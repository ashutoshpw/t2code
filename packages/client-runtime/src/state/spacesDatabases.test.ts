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
  type SpaceDatabaseChangeEvent,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSpacesEnvironmentAtoms } from "./spaces.ts";
import type { RemoteChanges } from "../spaces/databases/remoteChanges.ts";
import { createSpacesDatabaseAtoms, type SpacesDatabaseAtoms } from "./spacesDatabases.ts";

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
const admission = {
  epoch: SpaceReceiptEpoch.make("epoch-2"),
  acceptsUntil: "2030-01-01T00:00:00.000Z",
  retainUntil: "2030-02-01T00:00:00.000Z",
};
const enabled = { version: 2, limits: {}, features: { databases: true } } as SpaceCapability;
const live = {
  version: 2,
  limits: {},
  features: { databases: true, databaseChanges: true },
} as SpaceCapability;

const harness = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(sessions(env), AsyncResult.success(operate));
  const sent: string[] = [];
  const changes = yield* Queue.unbounded<SpaceDatabaseChangeEvent>();
  const stats = { subscriptions: 0 };
  // The one-shot debounce of remote changes, run by hand.
  const scheduled: Array<{ readonly run: () => void; readonly delayMs: number }> = [];
  const transport = {
    client: {
      [WS_METHODS.spacesDatabasesSubscribeChanges]: () =>
        Stream.suspend(() => {
          stats.subscriptions++;
          return Stream.fromQueue(changes);
        }),
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
            mutationAdmission: admission,
          };
        }),
      [WS_METHODS.spacesDatabasesRowsGet]: () =>
        Effect.sync(() => ({ dataSource: { id: source }, mutationAdmission: admission })),
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
      [WS_METHODS.spacesDatabasesRowsCreate]: () =>
        Effect.succeed({
          status: "saved",
          dataSourceId: source,
          dataRevision: 1,
          rows: [],
          affectedDataSourceIds: [source, sibling],
        }),
      // A rollup in another data source reads these rows, so the receipt names it.
      [WS_METHODS.spacesPagesUpdate]: () =>
        Effect.succeed({ status: "saved", affectedDataSourceIds: [sibling] }),
      [WS_METHODS.spacesPagesTrash]: () =>
        Effect.succeed({ status: "saved", affectedDataSourceIds: [sibling] }),
      [WS_METHODS.spacesPagesRestore]: () =>
        Effect.succeed({ status: "saved", affectedDataSourceIds: [sibling] }),
      [WS_METHODS.spacesPagesPermanentlyDelete]: () =>
        Effect.succeed({
          status: "saved",
          deletedPageIds: [page, "child"],
          affectedDataSourceIds: [sibling],
        }),
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
    Layer.succeed(EnvironmentRegistry, {
      run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      followStream: (_id: EnvironmentId, stream: Stream.Stream<unknown, unknown, unknown>) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const capability = Atom.make<SpaceCapability | undefined>(undefined);
  const databases = createSpacesDatabaseAtoms(runtime, {
    capabilityAtom: () => capability,
    schedule: (run, delayMs) => {
      const entry = { run, delayMs };
      scheduled.push(entry);
      return () => {
        const at = scheduled.indexOf(entry);
        if (at >= 0) scheduled.splice(at, 1);
      };
    },
  });
  return {
    registry,
    sent,
    capability,
    databases,
    runtime,
    changes,
    stats,
    scheduled,
    supervisor,
    transport,
  };
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

  it.effect("refuses a query without the read grant and answers it with the grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, sent, capability, databases } = yield* harness;
        registry.mount(capability);
        registry.set(capability, enabled);
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
        registry.mount(rowsQuery);
        registry.set(
          sessions(env),
          AsyncResult.success({ ...operate, scopes: [], permissions: [] }),
        );
        const refused = yield* AtomRegistry.getResult(registry, rowsQuery, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(sent).toEqual([]);

        registry.set(sessions(env), AsyncResult.success(operate));
        // The refused answer stays cached for its own query, so a second query proves the grant.
        const granted = databases.query({
          environmentId: env,
          input: {
            environmentId: env,
            dataSourceId: sibling,
            viewId: view,
            mode: "rows",
            timeZone: "UTC",
          },
        });
        registry.mount(granted);
        const answer = yield* AtomRegistry.getResult(registry, granted, { suspendOnWaiting: true });
        expect(answer).toEqual({ rows: [] });
        expect(sent).toEqual(["query"]);
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
        yield* Effect.promise(() =>
          databases.createRows.run(registry, {
            environmentId: env,
            input: { ...metadata, dataSourceId: source, rows: [{ title: "new" }] },
          } as never),
        );
        expect(counts()).toEqual([3, 2, 0]);
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

  it.effect("keeps the newest admission and refreshes a row's data source on page edits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, databases } = yield* harness;
        registry.mount(capability);
        registry.set(capability, enabled);
        const rowQuery = databases.row({
          environmentId: env,
          input: { environmentId: env, pageId: page },
        });
        registry.mount(rowQuery);
        const changed = databases.dataSourceChanged(env, source);
        registry.mount(changed);
        expect(registry.get(databases.admission(env))).toBeUndefined();
        registry.mount(databases.admission(env));
        yield* AtomRegistry.getResult(registry, rowQuery, { suspendOnWaiting: true }).pipe(
          Effect.ignore,
        );
        expect(registry.get(databases.admission(env))).toEqual(admission);
        databases.rowPageChanged(registry, env, page);
        expect(registry.get(changed)).toBe(1);
        // A page nobody noted has no known data source to refresh.
        databases.rowPageChanged(registry, env, SpacePageId.make("unknown"));
        expect(registry.get(changed)).toBe(1);
        // The grid notes the source when it trashes a row it never opened as a page.
        databases.noteRowDataSource(registry, env, SpacePageId.make("never-opened"), source);
        databases.rowPageChanged(registry, env, SpacePageId.make("never-opened"));
        expect(registry.get(changed)).toBe(2);
      }),
    ),
  );

  it.effect("refreshes a row's data source after page edits, trash, restore and delete", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, runtime } = yield* harness;
        const spaces = createSpacesEnvironmentAtoms(runtime, { capabilityAtom: () => capability });
        registry.set(capability, { ...enabled, features: { ...enabled.features, recovery: true } });
        const rowQuery = spaces.databases.row({
          environmentId: env,
          input: { environmentId: env, pageId: page },
        });
        registry.mount(rowQuery);
        yield* AtomRegistry.getResult(registry, rowQuery, { suspendOnWaiting: true }).pipe(
          Effect.ignore,
        );
        const changed = spaces.databases.dataSourceChanged(env, source);
        registry.mount(changed);
        const siblingChanged = spaces.databases.dataSourceChanged(env, sibling);
        registry.mount(siblingChanged);
        const guards = { page: { revision: 1 } };
        const input = { ...metadata, pageId: page, guards };
        const commands: Array<() => Promise<{ readonly _tag: string }>> = [
          () => spaces.updatePage.run(registry, { environmentId: env, input: input as never }),
          () => spaces.trashPage.run(registry, { environmentId: env, input: input as never }),
          () => spaces.restorePage.run(registry, { environmentId: env, input: input as never }),
          () =>
            spaces.permanentlyDeletePage.run(registry, {
              environmentId: env,
              input: input as never,
            }),
        ];
        let expected = 0;
        for (const command of commands) {
          expect((yield* Effect.promise(command))._tag).toBe("Success");
          expected += 1;
          expect(registry.get(changed)).toBe(expected);
          expect(registry.get(siblingChanged)).toBe(expected);
        }
      }),
    ),
  );

  describe("remote changes", () => {
    const announce = (
      event: SpaceDatabaseChangeEvent,
      changes: Queue.Queue<SpaceDatabaseChangeEvent>,
    ) => Queue.offer(changes, event);
    const sourceChange = (id: SpaceDataSourceId, dataRevision: number, schemaRevision = 0) => ({
      id,
      databaseId: database,
      schemaRevision,
      dataRevision,
    });
    const changed = (
      ...dataSources: ReturnType<typeof sourceChange>[]
    ): SpaceDatabaseChangeEvent => ({
      type: "changed",
      dataSources,
      databases: [],
    });
    // Waits on the registry, not the clock: resolves when the folded stream state satisfies `done`.
    const untilRemote = (
      registry: AtomRegistry.AtomRegistry,
      atom: Atom.Atom<AsyncResult.AsyncResult<RemoteChanges, unknown>>,
      done: (state: RemoteChanges) => boolean,
    ) =>
      Effect.callback<void>((resume) => {
        let stop = () => {};
        let finished = false;
        const check = (result: AsyncResult.AsyncResult<RemoteChanges, unknown>) => {
          if (finished || result._tag !== "Success" || !done(result.value)) return;
          finished = true;
          resume(Effect.void);
        };
        stop = registry.subscribe(atom, check, { immediate: true });
        return Effect.sync(() => stop());
      });
    const stream = (databases: SpacesDatabaseAtoms) =>
      databases.remoteChanges({ environmentId: env, input: { environmentId: env } });

    it.effect(
      "applies a burst of remote changes as one bump and ignores the echo of an own write",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { registry, capability, databases, changes, scheduled } = yield* harness;
            registry.mount(capability);
            registry.set(capability, live);
            const trigger = databases.dataSourceLive(env, source);
            registry.mount(trigger);
            yield* Queue.offer(changes, { type: "resync" });
            yield* untilRemote(registry, stream(databases), (state) => state.resyncs === 1);
            // The server's opening resync costs one refresh and nothing more.
            expect(scheduled).toHaveLength(1);
            scheduled.shift()!.run();
            expect(registry.get(trigger)).toBe(1);

            // Own write: the answer carries revision 1, so the echo of it is not news.
            yield* Effect.promise(() =>
              databases.updateRows.run(registry, {
                environmentId: env,
                input: { ...metadata, dataSourceId: source, rows: [{ pageId: page, cells: {} }] },
              }),
            );
            const afterOwnWrite = registry.get(trigger);
            yield* announce(changed(sourceChange(source, 1)), changes);
            yield* announce(changed(sourceChange(source, 2)), changes);
            yield* announce(changed(sourceChange(source, 3)), changes);
            yield* untilRemote(
              registry,
              stream(databases),
              (state) => state.dataSources.get(source)?.dataRevision === 3,
            );
            expect(scheduled).toHaveLength(1);
            scheduled.shift()!.run();
            expect(registry.get(trigger)).toBe(afterOwnWrite + 1);

            // The same revisions again are already applied.
            yield* announce(changed(sourceChange(source, 3)), changes);
            yield* untilRemote(
              registry,
              stream(databases),
              (state) => state.dataSources.size === 1,
            );
            expect(scheduled).toHaveLength(0);
          }),
        ),
    );

    it.effect(
      "moves every trigger on a resync, and once more on a new session's opening resync",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const {
              registry,
              capability,
              databases,
              changes,
              scheduled,
              supervisor,
              transport,
              sent,
            } = yield* harness;
            registry.mount(capability);
            registry.set(capability, live);
            const sources = [source, sibling].map((id) => databases.dataSourceLive(env, id));
            for (const atom of sources) registry.mount(atom);
            const databaseQuery = databases.database({
              environmentId: env,
              input: { environmentId: env, databaseId: database },
            });
            registry.mount(databaseQuery);
            yield* AtomRegistry.getResult(registry, databaseQuery, { suspendOnWaiting: true }).pipe(
              Effect.ignore,
            );
            expect(sent.filter((call) => call === "get")).toHaveLength(1);
            yield* Queue.offer(changes, { type: "resync" });
            yield* untilRemote(registry, stream(databases), (state) => state.resyncs === 1);
            scheduled.shift()!.run();
            expect(sources.map((atom) => registry.get(atom))).toEqual([1, 1]);
            // The mounted database query refetched with the resync.
            expect(sent.filter((call) => call === "get")).toHaveLength(2);

            // A new session subscribes again and its first event is a resync, which refreshes once more.
            const reconnected = yield* Queue.unbounded<SpaceDatabaseChangeEvent>();
            yield* SubscriptionRef.set(
              supervisor.session,
              Option.some({
                ...transport,
                client: {
                  ...transport.client,
                  [WS_METHODS.spacesDatabasesSubscribeChanges]: () => Stream.fromQueue(reconnected),
                },
              } as unknown as RpcSession),
            );
            expect(scheduled).toHaveLength(0);
            yield* Queue.offer(reconnected, { type: "resync" });
            yield* untilRemote(registry, stream(databases), (state) => state.resyncs === 2);
            expect(scheduled).toHaveLength(1);
            scheduled.shift()!.run();
            expect(sources.map((atom) => registry.get(atom))).toEqual([2, 2]);
          }),
        ),
    );

    it.effect("mounts no subscription against a server without the change stream", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { registry, capability, databases, stats, changes } = yield* harness;
          registry.mount(capability);
          registry.set(capability, enabled);
          registry.mount(databases.dataSourceLive(env, source));
          expect(stats.subscriptions).toBe(0);
          registry.set(capability, live);
          yield* Queue.offer(changes, { type: "resync" });
          yield* untilRemote(registry, stream(databases), (state) => state.resyncs === 1);
          expect(stats.subscriptions).toBe(1);
        }),
      ),
    );
  });
});
