import { runAtomCommand } from "../state/runtime.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageId,
  SpaceReceiptEpoch,
  type SpacePageGetResult,
} from "@t2code/contracts/spaces";
import { EnvironmentId, WS_METHODS } from "@t2code/contracts";
import * as Deferred from "effect/Deferred";
import { MixedScheduler } from "effect/Scheduler";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createSpacesEnvironmentAtoms } from "../state/spaces.ts";
import * as Effect from "effect/Effect";
import { readSpacePageLocation } from "./pageLocation.ts";

const spaceId = SpaceId.make("current-space");
const timestamp = "2026-10-26T00:00:00Z";
function metadata(id: string, parent: string | null = null): SpacePageGetResult {
  return {
    page: {
      id: SpacePageId.make(id),
      spaceId,
      title: id,
      revision: 1,
      rootOrder: parent ? null : "rank",
      location: parent
        ? {
            kind: "child",
            spaceId,
            ownerBlockId: SpaceBlockId.make(`owner-${id}`),
            parentPageId: SpacePageId.make(parent),
          }
        : { kind: "root", spaceId, order: "rank" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    space: {
      id: spaceId,
      title: "Current space",
      revision: 1,
      rootOrderRevision: 1,
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    mutationAdmission: {
      epoch: SpaceReceiptEpoch.make("epoch"),
      acceptsUntil: timestamp,
      retainUntil: timestamp,
    },
  };
}

describe("readSpacePageLocation", () => {
  it.effect(
    "resolves the current normalized ancestry and verifies its revisions before publishing hints",
    () =>
      Effect.gen(function* () {
        const rows = [metadata("child", "parent"), metadata("parent", "root"), metadata("root")];
        const reads: string[] = [];
        const result = yield* readSpacePageLocation(
          { pageId: rows[0]!.page.id, version: 2 },
          (id) => {
            reads.push(id);
            return Effect.succeed(rows.find((row) => row.page.id === id)!);
          },
        );
        expect(result.page.spaceId).toBe("current-space");
        expect(result.ancestors.map((page) => page.id)).toEqual(["root", "parent"]);
        expect(reads).toEqual(["child", "parent", "root", "child", "root", "parent"]);
        reads.length = 0;
        const root = yield* readSpacePageLocation(
          { pageId: rows[2]!.page.id, version: 2 },
          (id) => {
            reads.push(id);
            return Effect.succeed(rows[2]!);
          },
        );
        expect(root.ancestors).toEqual([]);
        expect(reads).toEqual(["root"]);
      }),
  );

  it.effect("does not fabricate a location for legacy v1 metadata or missing v2 location", () =>
    Effect.gen(function* () {
      const row = metadata("legacy");
      const { location: _location, ...legacy } = row.page;
      let reads = 0;
      const read = () => {
        reads++;
        return Effect.succeed({ ...row, page: legacy });
      };
      const result = yield* readSpacePageLocation({ pageId: legacy.id, version: 1 }, read);
      expect(result.page).not.toHaveProperty("location");
      expect(result.ancestors).toEqual([]);
      expect(reads).toBe(1);
      const failure = yield* readSpacePageLocation({ pageId: legacy.id, version: 2 }, read).pipe(
        Effect.flip,
      );
      expect(failure.message).toContain("unavailable");
    }),
  );

  it.effect(
    "refuses a moved page during verification rather than rendering an obsolete parent path",
    () =>
      Effect.gen(function* () {
        const child = metadata("child", "parent");
        let reads = 0;
        const moved = metadata("child", "new-parent");
        const failure = yield* readSpacePageLocation(
          { pageId: child.page.id, version: 2 },
          (id) => {
            reads++;
            return Effect.succeed(
              id === child.page.id
                ? reads === 1
                  ? child
                  : { ...moved, page: { ...moved.page, revision: 2 } }
                : metadata("parent"),
            );
          },
        ).pipe(Effect.flip);
        expect(failure.message).toContain("location changed");
        expect(reads).toBe(3);
      }),
  );

  it.effect("bounds ancestry reads and UTF8 response bytes", () =>
    Effect.gen(function* () {
      const ids: string[] = [];
      const depthError = yield* readSpacePageLocation(
        { pageId: SpacePageId.make("0"), version: 2 },
        (id) => {
          ids.push(id);
          return Effect.succeed(metadata(id, String(Number(id) + 1)));
        },
      ).pipe(Effect.flip);
      expect(depthError.message).toContain("ancestry exceeds");
      expect(ids).toHaveLength(16);
      const row = metadata("big");
      const title = "界".repeat(Math.floor((2 * 1024 * 1024) / 3) + 1);
      const bytesError = yield* readSpacePageLocation({ pageId: row.page.id, version: 2 }, () =>
        Effect.succeed({ ...row, page: { ...row.page, title } }),
      ).pipe(Effect.flip);
      expect(bytesError.message).toContain("limit");
    }),
  );
});

const setupLocationRuntime = Effect.fn("SpacePageLocationTest.setupRuntime")(function* () {
  const environmentId = EnvironmentId.make("location-destination");
  const requests = yield* Queue.unbounded<{
    reply: Deferred.Deferred<SpacePageGetResult>;
    canceled: Deferred.Deferred<void>;
  }>();
  let executions = 0;
  const client = {
    [WS_METHODS.spacesPagesGet]: () =>
      Effect.gen(function* () {
        executions++;
        const reply = yield* Deferred.make<SpacePageGetResult>();
        const canceled = yield* Deferred.make<void>();
        yield* Queue.offer(requests, { reply, canceled });
        return yield* Deferred.await(reply).pipe(
          Effect.onInterrupt(() => Deferred.succeed(canceled, undefined)),
        );
      }),
  } as unknown as WsRpcProtocolClient;
  const makeSession = (): RpcSession => ({
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.never,
    closed: Effect.never,
  });
  const sessions = yield* SubscriptionRef.make(Option.some(makeSession()));
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Location destination",
      httpBaseUrl: "https://location.example.test",
      wsBaseUrl: "wss://location.example.test",
    }),
    state,
    session: sessions,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    Stream.provideService(stream, EnvironmentSupervisor, supervisor);
  const environments = EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry["Service"]);
  const cleanup = new MixedScheduler("async").makeDispatcher();
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      let active = true;
      cleanup.scheduleTask(() => {
        if (active) task();
      }, 0);
      return () => {
        active = false;
      };
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const queries = createSpacesEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)),
  );
  const target = {
    environmentId,
    input: { environmentId, pageId: SpacePageId.make("P"), version: 2 as const },
  };
  return {
    registry,
    flushCleanup: () => cleanup.flush(),
    requests,
    sessions,
    state,
    makeSession,
    executions: () => executions,
    location: () => queries.location(target),
    captureSession: queries.captureSession,
    environmentId,
  };
});

it.effect(
  "authorizes the moved page only after an owned fresh read and rejects obsolete connection epochs",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* setupLocationRuntime();
        const a = metadata("P");
        const destination = SpaceId.make("space-B");
        const b: SpacePageGetResult = {
          ...a,
          page: {
            ...a.page,
            spaceId: destination,
            revision: 2,
            location: { kind: "root", spaceId: destination, order: "rank" },
          },
          space: { ...a.space, id: destination },
        };
        const firstOwner = h.location();
        const firstRemoved = yield* Deferred.make<void>();
        h.registry.onNodeRemoved = (node) => {
          if (node.atom === firstOwner) Deferred.doneUnsafe(firstRemoved, Effect.void);
        };
        const stopFirst = h.registry.mount(firstOwner);
        yield* Effect.addFinalizer(() => Effect.sync(stopFirst));
        const first = yield* Queue.take(h.requests);
        yield* Deferred.succeed(first.reply, a);
        const settledA = yield* AtomRegistry.getResult(h.registry, firstOwner, {
          suspendOnWaiting: true,
        });
        expect(settledA.page.spaceId).toBe(spaceId);
        const secondOwner = h.location();
        const stopSecond = yield* Effect.sync(() => {
          stopFirst();
          h.flushCleanup();
          const stop = h.registry.mount(secondOwner);
          const initial = Option.getOrNull(AsyncResult.value(h.registry.get(secondOwner)));
          expect(initial?.page.spaceId).not.toBe(spaceId);
          return stop;
        });
        yield* Effect.addFinalizer(() => Effect.sync(stopSecond));
        const fresh = yield* Queue.take(h.requests);
        expect(h.executions()).toBe(2);
        yield* Deferred.succeed(fresh.reply, b);
        const settledB = yield* AtomRegistry.getResult(h.registry, secondOwner, {
          suspendOnWaiting: true,
        });
        expect(settledB.current()?.page.spaceId).toBe(destination);
        yield* Deferred.await(firstRemoved);
        yield* SubscriptionRef.set(h.sessions, Option.some(h.makeSession()));
        expect(settledB.current()).toBeNull();
        const reconnect = yield* Queue.take(h.requests);
        yield* SubscriptionRef.update(h.state, (state) => ({
          ...state,
          generation: state.generation + 1,
        }));
        yield* Deferred.await(reconnect.canceled);
        const latest = yield* Queue.take(h.requests);
        yield* Deferred.succeed(reconnect.reply, a);
        yield* Deferred.succeed(latest.reply, b);
        const current = yield* AtomRegistry.getResult(h.registry, secondOwner, {
          suspendOnWaiting: true,
        });
        expect(current.current()?.page.spaceId).toBe(destination);
        expect(h.executions()).toBe(4);
        stopSecond();
        h.flushCleanup();
        const thirdOwner = h.location();
        const stopThird = h.registry.mount(thirdOwner);
        yield* Effect.addFinalizer(() => Effect.sync(stopThird));
        expect(
          Option.getOrNull(AsyncResult.value(h.registry.get(thirdOwner)))?.page.spaceId,
        ).not.toBe(destination);
        const invalid = yield* Queue.take(h.requests);
        const { location: _location, ...missing } = b.page;
        yield* Deferred.succeed(invalid.reply, { ...b, page: missing });
        const failure = yield* AtomRegistry.getResult(h.registry, thirdOwner, {
          suspendOnWaiting: true,
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "SpaceLocationError" });
        expect(h.executions()).toBe(5);
        expect(settledB.current()).toBeNull();
        stopThird();
        expect(h.registry.getNodes().get(thirdOwner)?.listeners.size ?? 0).toBe(0);
      }),
    ),
);

it.effect("invalidates send capture ownership on a replacement session or disconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* setupLocationRuntime();
      const result = yield* Effect.promise(() =>
        runAtomCommand(h.registry, h.captureSession, {
          environmentId: h.environmentId,
          input: undefined,
        }),
      );
      if (result._tag !== "Success") return yield* Effect.die("Expected capture session ownership");
      const original = result.value();
      expect(original).not.toBeNull();
      yield* SubscriptionRef.set(h.sessions, Option.some(h.makeSession()));
      expect(result.value()).toBeNull();
      const replacement = yield* Effect.promise(() =>
        runAtomCommand(h.registry, h.captureSession, {
          environmentId: h.environmentId,
          input: undefined,
        }),
      );
      if (replacement._tag !== "Success")
        return yield* Effect.die("Expected replacement session ownership");
      expect(replacement.value()).not.toBe(original);
      yield* SubscriptionRef.update(h.state, (state) => ({
        ...state,
        generation: state.generation + 1,
      }));
      expect(replacement.value()).toBeNull();
      const latest = yield* Effect.promise(() =>
        runAtomCommand(h.registry, h.captureSession, {
          environmentId: h.environmentId,
          input: undefined,
        }),
      );
      if (latest._tag !== "Success")
        return yield* Effect.die("Expected current generation ownership");
      expect(latest.value()).not.toBeNull();
      yield* SubscriptionRef.set(h.state, AVAILABLE_CONNECTION_STATE);
      expect(latest.value()).toBeNull();
    }),
  ),
);
