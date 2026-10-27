import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "../packages/contracts/src/index.ts";
import { createSpacesEnvironmentAtoms } from "../packages/client-runtime/src/state/spaces.ts";
import { runAtomCommand } from "../packages/client-runtime/src/state/runtime.ts";
import { createEnvironmentSessionAtoms } from "../packages/client-runtime/src/state/session.ts";
import { EnvironmentRegistry } from "../packages/client-runtime/src/connection/registry.ts";
import { EnvironmentSupervisor } from "../packages/client-runtime/src/connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "../packages/client-runtime/src/connection/model.ts";
import { createMobileSpaceReferenceController } from "../apps/mobile/src/features/spaces/references.ts";
import { diskDatabase } from "../apps/mobile/src/persistence/mobile-database.test-support.ts";
import { mobileSpacesServiceLayer, promiseRunner } from "./spaces-mobile.test-support.mjs";
import * as SpacesService from "../apps/server/src/spaces/SpacesService.ts";

vi.mock("../packages/client-runtime/src/state/session.ts", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const sessions = Atom.family(() => Atom.make(AsyncResult.initial()));
  return { createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }) };
});

const fixture = Effect.fn("MobileReferencesTest.fixture")(function* (use) {
  const disk = yield* diskDatabase();
  const environmentId = EnvironmentId.make("query-environment");
  yield* Effect.gen(function* () {
    const service = yield* SpacesService.SpacesService;
    const run = yield* promiseRunner();
    const db = yield* disk.open();
    const capability = yield* service.getCapability(environmentId);
    const state = yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
      generation: 1,
      attempt: 1,
    });
    const calls = [];
    const rpc = {
      client: {
        [WS_METHODS.spacesSearch]: (input) =>
          Effect.tryPromise({
            try: () => {
              calls.push(input);
              return run(service.search(input));
            },
            catch: (error) => error,
          }),
        [WS_METHODS.spacesReferencesResolve]: (input) =>
          Effect.tryPromise({
            try: () => {
              calls.push(input);
              return run(service.resolveReference(input));
            },
            catch: (error) => error,
          }),
      },
    };
    const session = yield* SubscriptionRef.make(Option.some(rpc));
    const supervisor = {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Query test",
        httpBaseUrl: "https://query.invalid",
        wsBaseUrl: "wss://query.invalid",
      }),
      state,
      session,
    };
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      }),
    );
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const cap = Atom.make(capability);
    registry.mount(cap);
    const atoms = createSpacesEnvironmentAtoms(runtime, { capabilityAtom: () => cap });
    const grant = createEnvironmentSessionAtoms(runtime).sessionStateAtom(environmentId);
    registry.mount(grant);
    registry.mount(atoms.changed(environmentId));
    const permissions = (allowed) =>
      registry.set(
        grant,
        AsyncResult.success({
          authenticated: true,
          scopes: allowed ? [AuthOrchestrationReadScope] : [],
          permissions: allowed ? [AuthOrchestrationReadScope] : [],
        }),
      );
    permissions(true);
    const command = async (cmd, input) => {
      const result = await runAtomCommand(
        registry,
        cmd,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    };
    const owner = () =>
      createMobileSpaceReferenceController({
        environmentId,
        captureSession: () => command(atoms.captureSession, undefined),
        access: () => ({
          sourceVersion: registry.get(atoms.changed(environmentId)),
          canRead: registry.get(grant).value.permissions.includes(AuthOrchestrationReadScope),
          capability: registry.get(cap),
        }),
        search: (input) => command(atoms.search, input),
        resolve: (input) => command(atoms.resolve, input),
      });
    let id = 0;
    const root = async (title) => {
      const admission = await run(service.listSpaces({ environmentId }));
      const list = await run(
        service.listPages({ environmentId, spaceId: admission.defaultSpaceId }),
      );
      const result = await run(
        service.createPage({
          environmentId,
          spaceId: admission.defaultSpaceId,
          receiptEpoch: admission.mutationAdmission.epoch,
          mutationId: `root-${++id}`,
          title,
          baseRootOrderRevision: list.space.rootOrderRevision,
        }),
      );
      expect(result.status).toBe("saved");
      return result.page;
    };
    yield* use({
      service,
      run,
      db,
      disk,
      environmentId,
      capability,
      calls,
      registry,
      cap,
      atoms,
      permissions,
      session,
      state,
      rpc,
      owner,
      command,
      root,
    });
  }).pipe(Effect.provide(mobileSpacesServiceLayer(disk.file, environmentId)));
}, Effect.scoped);

it.effect(
  "uses actual query commands and SQLite search cursors, revokes results on changed atom/reconnect and checks live optional flags/read grants at dispatch",
  () =>
    fixture((c) =>
      Effect.promise(async () => {
        const page = await c.root("nativesearchneedle");
        const second = await c.root("nativesearchneedle two");
        c.registry.set(c.cap, {
          ...c.capability,
          limits: { ...c.capability.limits, search: { ...c.capability.limits.search, maxRows: 1 } },
        });
        const owner = await c.owner();
        expect(owner.canCapture()).toBe(false);
        expect((await owner.search("nativesearchneedle")).status).toBe("building");
        const first = await owner.search("nativesearchneedle");
        expect(first.status).toBe("ready");
        expect(first.result.items).toHaveLength(1);
        const cursor = first.result.nextCursor;
        expect(cursor).not.toBeNull();
        await expect(
          c.run(
            c.service.search({ environmentId: c.environmentId, query: "other", limit: 1, cursor }),
          ),
        ).rejects.toMatchObject({ reason: "invalid_cursor" });
        const next = await first.next();
        expect(next.status).toBe("ready");
        expect(next.result.items).toHaveLength(1);
        expect(
          new Set([...first.result.items, ...next.result.items].map((hit) => hit.page.id)),
        ).toEqual(new Set([page.id, second.id]));
        c.registry.update(c.atoms.changed(c.environmentId), (value) => value + 1);
        expect(next.current()).toBe(false);
        const before = c.calls.length;
        expect((await next.next()).status).toBe("unavailable");
        expect(c.calls).toHaveLength(before);
        const connected = await c.owner();
        const fresh = await connected.search("nativesearchneedle");
        expect(fresh.status).toBe("ready");
        await c.run(
          SubscriptionRef.set(c.state, {
            ...SubscriptionRef.getUnsafe(c.state),
            generation: 2,
            attempt: 2,
          }),
        );
        expect(fresh.current()).toBe(false);
        const replacement = await c.owner();
        c.permissions(false);
        await expect(
          c.command(c.atoms.search, {
            environmentId: c.environmentId,
            query: "nativesearchneedle",
          }),
        ).rejects.toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(await replacement.resolve({ kind: "page", pageId: page.id })).toBeNull();
        expect(c.calls).toHaveLength(before + 1);
        c.permissions(true);
        c.registry.set(c.cap, { ...c.capability, features: { referenceResolution: true } });
        await expect(
          c.command(c.atoms.search, {
            environmentId: c.environmentId,
            query: "nativesearchneedle",
          }),
        ).rejects.toMatchObject({ _tag: "SpacesUnavailableError" });
        const resolver = await c.owner();
        expect((await resolver.resolve({ kind: "page", pageId: page.id })).current()).toMatchObject(
          { pageId: page.id },
        );
        await c.run(SubscriptionRef.set(c.session, Option.none()));
        expect(resolver.current()).toBe(false);
        owner.dispose();
        connected.dispose();
        replacement.dispose();
        resolver.dispose();
      }),
    ),
);
