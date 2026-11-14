import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, WS_METHODS } from "@t2code/contracts";
import {
  SpaceId,
  SpacePageId,
  type SpaceCapability,
  type SpacePageChangeEvent,
} from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { RemotePageChanges } from "../spaces/livePage.ts";
import { createSpacesPageAtoms } from "./spacesPages.ts";

const env = EnvironmentId.make("target");
const space = SpaceId.make("space");
const pageA = SpacePageId.make("a");
const pageB = SpacePageId.make("b");
const live = { version: 2, limits: {}, features: { pageChanges: true } } as SpaceCapability;
const without = { version: 2, limits: {}, features: { databaseChanges: true } } as SpaceCapability;

const harness = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const events = yield* Queue.unbounded<SpacePageChangeEvent>();
  const stats = { subscriptions: 0 };
  const scheduled: Array<{ readonly run: () => void; readonly delayMs: number }> = [];
  const transport = {
    client: {
      [WS_METHODS.spacesPagesSubscribeChanges]: () =>
        Stream.suspend(() => {
          stats.subscriptions++;
          return Stream.fromQueue(events);
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
  const changedFamily = Atom.family((_id: EnvironmentId) => Atom.make(0));
  const pages = createSpacesPageAtoms(runtime, {
    capabilityAtom: () => capability,
    changed: changedFamily,
    schedule: (run, delayMs) => {
      const entry = { run, delayMs };
      scheduled.push(entry);
      return () => {
        const at = scheduled.indexOf(entry);
        if (at >= 0) scheduled.splice(at, 1);
      };
    },
  });
  return { registry, capability, changed: changedFamily(env), pages, events, stats, scheduled };
});

// Waits on the registry, not the clock: resolves when the folded stream state satisfies `done`.
const untilRemote = (
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<RemotePageChanges, unknown>>,
  done: (state: RemotePageChanges) => boolean,
) =>
  Effect.callback<void>((resume) => {
    let finished = false;
    const stop = registry.subscribe(
      atom,
      (result) => {
        if (finished || result._tag !== "Success" || !done(result.value)) return;
        finished = true;
        resume(Effect.void);
      },
      { immediate: true },
    );
    return Effect.sync(() => stop());
  });

const edit = (id: SpacePageId, revision: number, tree = false): SpacePageChangeEvent => ({
  type: "changed",
  pages: [
    { id, spaceId: space, revision, bodyRevision: revision, ...(tree ? { tree: true } : {}) },
  ],
  spaces: [],
});

describe("spaces page atoms", () => {
  it.effect("moves only the changed page's signal, once per burst", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, pages, events, scheduled } = yield* harness;
        registry.mount(capability);
        registry.set(capability, live);
        const a = pages.pageLive(env, pageA);
        const b = pages.pageLive(env, pageB);
        registry.mount(a);
        registry.mount(b);
        const stream = pages.remoteChanges({ environmentId: env, input: { environmentId: env } });
        yield* Queue.offer(events, { type: "resync" });
        yield* Queue.offer(events, edit(pageA, 2));
        yield* Queue.offer(events, edit(pageA, 3));
        yield* Queue.offer(events, edit(pageA, 4));
        yield* untilRemote(registry, stream, (state) => state.pages.get(pageA)?.revision === 4);
        expect(scheduled).toHaveLength(1);
        scheduled.shift()!.run();
        expect(registry.get(a)).toEqual({
          changeSeq: 1,
          resyncSeq: 0,
          revision: 4,
          bodyRevision: 4,
        });
        expect(registry.get(b)).toEqual({ changeSeq: 0, resyncSeq: 0 });
      }),
    ),
  );

  it.effect("bumps the shared counter only for tree changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, changed, pages, events, scheduled } = yield* harness;
        registry.mount(capability);
        registry.set(capability, live);
        registry.mount(pages.treeLive(env));
        registry.mount(changed);
        const stream = pages.remoteChanges({ environmentId: env, input: { environmentId: env } });
        yield* Queue.offer(events, edit(pageA, 2));
        yield* untilRemote(registry, stream, (state) => state.pages.size === 1);
        scheduled.shift()!.run();
        expect(registry.get(changed)).toBe(0);
        yield* Queue.offer(events, edit(pageA, 3, true));
        yield* untilRemote(registry, stream, (state) => state.pages.get(pageA)?.revision === 3);
        scheduled.shift()!.run();
        expect(registry.get(changed)).toBe(1);
      }),
    ),
  );

  it.effect("ignores the opening resync and moves resyncSeq on a later one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, changed, pages, events, scheduled } = yield* harness;
        registry.mount(capability);
        registry.set(capability, live);
        const a = pages.pageLive(env, pageA);
        registry.mount(a);
        registry.mount(changed);
        const stream = pages.remoteChanges({ environmentId: env, input: { environmentId: env } });
        yield* Queue.offer(events, { type: "resync" });
        yield* untilRemote(registry, stream, (state) => state.resyncs === 1);
        expect(scheduled).toHaveLength(0);
        expect(registry.get(a).resyncSeq).toBe(0);
        yield* Queue.offer(events, { type: "resync" });
        yield* untilRemote(registry, stream, (state) => state.resyncs === 2);
        expect(scheduled).toHaveLength(1);
        scheduled.shift()!.run();
        expect(registry.get(a).resyncSeq).toBe(1);
        expect(registry.get(changed)).toBe(1);
      }),
    ),
  );

  it.effect("does not subscribe without the capability flag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, pages, stats } = yield* harness;
        registry.mount(capability);
        registry.set(capability, without);
        registry.mount(pages.pageLive(env, pageA));
        registry.mount(pages.treeLive(env));
        expect(stats.subscriptions).toBe(0);
        registry.set(capability, live);
        yield* Effect.yieldNow;
        expect(stats.subscriptions).toBe(1);
      }),
    ),
  );
});
