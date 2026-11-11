import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
} from "@t2code/contracts";
import {
  SpaceDataSourceId,
  SpaceDatabaseId,
  SpaceViewId,
  SpaceMutationId,
  SpacePageId,
  SpaceReceiptEpoch,
  SpacePropertyId,
  type SpaceCapability,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSpacesDatabaseAtoms } from "./spacesDatabases.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const operate: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
const source = SpaceDataSourceId.make("source");
const sibling = SpaceDataSourceId.make("sibling");
const other = SpaceDataSourceId.make("other");
const page = SpacePageId.make("page");
const database = SpaceDatabaseId.make("database");
const view = SpaceViewId.make("view");
const property = SpacePropertyId.make("prop");
const metadata = {
  environmentId: env,
  mutationId: SpaceMutationId.make("write"),
  receiptEpoch: SpaceReceiptEpoch.make("epoch"),
};
const enabled = { version: 2, limits: {}, features: { databases: true } } as SpaceCapability;

const harness = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(sessions(env), AsyncResult.success(operate));
  const sent: string[] = [];
  const transport = {
    client: {
      [WS_METHODS.spacesDatabasesRowsUpdate]: () =>
        Effect.sync(() => {
          sent.push("rows.update");
          return {
            status: "saved",
            dataSourceId: source,
            dataRevision: 1,
            rows: [],
            affectedDataSourceIds: [source, sibling],
          };
        }),
      [WS_METHODS.spacesDatabasesGet]: () =>
        Effect.sync(() => {
          sent.push("get");
          return {
            database: { id: database },
            dataSources: [{ id: source }],
            views: [{ id: view }],
          };
        }),
      [WS_METHODS.spacesDatabasesQuery]: () =>
        Effect.sync(() => {
          sent.push("query");
          return { rows: [] };
        }),
      [WS_METHODS.spacesDatabasesSchemaUpdate]: () =>
        Effect.sync(() => ({
          status: "saved",
          dataSourceId: source,
          affectedDataSourceIds: [source],
        })),
      [WS_METHODS.spacesDatabasesViewsCreate]: () =>
        Effect.sync(() => ({ status: "saved", viewId: "created" })),
      [WS_METHODS.spacesDatabasesViewsUpdate]: () => Effect.sync(() => ({ status: "saved" })),
      [WS_METHODS.spacesDatabasesRowsMove]: () =>
        Effect.sync(() => {
          sent.push("rows.move");
          return { status: "saved", dataSourceId: source, dataRevision: 2 };
        }),
    },
  } as unknown as RpcSession;
  const supervisor = {
    target: { environmentId: env, label: "destination" },
    session: yield* SubscriptionRef.make(Option.some(transport)),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as unknown as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(RpcPermissionGuard, { authorize: () => Effect.void }),
      Layer.succeed(EnvironmentRegistry, {
        run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        followStream: (_id: EnvironmentId, stream: Stream.Stream<unknown, unknown, unknown>) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry["Service"]),
    ),
  );
  const capability = Atom.make<SpaceCapability | undefined>(undefined);
  const databases = createSpacesDatabaseAtoms(runtime, { capabilityAtom: () => capability });
  return { registry, sent, capability, databases };
});

describe("spaces database atoms", () => {
  it.effect("refuses writes until the server advertises databases", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, sent, capability, databases } = yield* harness;
        const run = () =>
          Effect.promise(() =>
            databases.updateRows.run(registry, {
              environmentId: env,
              input: { ...metadata, dataSourceId: source, rows: [{ pageId: page, cells: {} }] },
            }),
          );
        for (const value of [
          undefined,
          { ...enabled, version: 1 },
          { ...enabled, features: {} },
        ] as const) {
          registry.set(capability, value as SpaceCapability | undefined);
          const refused = yield* run();
          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure")
            expect(Cause.squash(refused.cause)).toMatchObject({
              _tag: "SpacesUnavailableError",
              stage: "settings",
            });
        }
        expect(sent).toEqual([]);
      }),
    ),
  );

  it.effect("invalidates only the data sources a write touched", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, databases } = yield* harness;
        registry.set(capability, enabled);
        const counts = () =>
          [source, sibling, other].map((id) => registry.get(databases.dataSourceChanged(env, id)));
        registry.mount(databases.dataSourceChanged(env, source));
        registry.mount(databases.dataSourceChanged(env, sibling));
        registry.mount(databases.dataSourceChanged(env, other));
        expect(counts()).toEqual([0, 0, 0]);
        const updated = yield* Effect.promise(() =>
          databases.updateRows.run(registry, {
            environmentId: env,
            input: {
              ...metadata,
              dataSourceId: source,
              rows: [{ pageId: page, cells: { [property]: 1 } }],
            },
          }),
        );
        expect(updated._tag).toBe("Success");
        // A two-way relation edit reports the synced side's data source too.
        expect(counts()).toEqual([1, 1, 0]);
        yield* Effect.promise(() =>
          databases.moveRows.run(registry, {
            environmentId: env,
            input: { ...metadata, dataSourceId: source, pageIds: [page], beforeRowId: null },
          }),
        );
        expect(counts()).toEqual([2, 1, 0]);
      }),
    ),
  );
  it.effect("refetches the database and view queries after schema and view edits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, sent, capability, databases } = yield* harness;
        registry.mount(capability);
        registry.set(capability, enabled);
        const read = (atom: Atom.Atom<AsyncResult.AsyncResult<unknown, Error>>) =>
          AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }).pipe(
            Effect.ignore,
            Effect.tap(() => Effect.yieldNow),
          );
        const databaseQuery = databases.database({
          environmentId: env,
          input: { environmentId: env, databaseId: database },
        });
        const rowsQuery = databases.query({
          environmentId: env,
          input: {
            environmentId: env,
            dataSourceId: source,
            viewId: view,
            mode: "rows",
            timeZone: "UTC",
          },
        });
        registry.mount(databaseQuery);
        registry.mount(rowsQuery);
        yield* read(databaseQuery);
        yield* read(rowsQuery);
        expect(sent.filter((call) => call === "get")).toHaveLength(1);
        const owner = (counter: Atom.Atom<number>) => registry.get(counter);
        const changed = databases.databaseChanged(env, database);
        registry.mount(changed);
        const before = owner(changed);

        yield* Effect.promise(() =>
          databases.updateSchema.run(registry, {
            environmentId: env,
            input: { ...metadata, dataSourceId: source, operations: [] },
          } as never),
        );
        yield* Effect.promise(() =>
          databases.updateView.run(registry, {
            environmentId: env,
            input: { ...metadata, viewId: view },
          } as never),
        );
        yield* Effect.promise(() =>
          databases.createView.run(registry, {
            environmentId: env,
            input: { ...metadata, dataSourceId: source, name: "v", type: "table" },
          } as never),
        );
        expect(owner(changed)).toBe(before + 3);
        yield* read(databaseQuery);
        yield* read(rowsQuery);
        expect(sent.filter((call) => call === "get").length).toBeGreaterThan(1);
        expect(sent.filter((call) => call === "query").length).toBeGreaterThan(1);
      }),
    ),
  );
});
