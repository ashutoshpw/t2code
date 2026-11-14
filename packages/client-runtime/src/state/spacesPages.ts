import type { SpaceCapability, SpacePageId } from "@t2code/contracts/spaces";
import { WS_METHODS, type EnvironmentId } from "@t2code/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  EMPTY_REMOTE_PAGES,
  foldPageChanges,
  type RemotePageChanges,
  type SpacePageLiveSignal,
} from "../spaces/livePage.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

const pushes = (capability: SpaceCapability | undefined) =>
  capability?.version === 2 && capability.features?.pageChanges === true;

/** A burst of remote changes becomes one application. */
const REMOTE_APPLY_DELAY_MS = 300;
/** Past this an idle subscription is released; reopening a page within it keeps the stream. */
const CHANGES_IDLE_TTL_MS = 10_000;

const NO_SIGNAL: SpacePageLiveSignal = { changeSeq: 0, resyncSeq: 0 };

/**
 * Live page changes per environment. The stream carries ids and revisions only; an open page
 * decides from its own state whether to read again, and the page tree refreshes through the same
 * `changed` counter the client's own mutations move.
 */
export function createSpacesPageAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly capabilityAtom?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<SpaceCapability | undefined>;
    readonly changed: (environmentId: EnvironmentId) => Atom.Writable<number>;
    /** One-shot timer; tests inject their own. */
    readonly schedule?: (run: () => void, delayMs: number) => () => void;
  },
) {
  const remoteChanges = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:spaces:pages:changes",
    tag: WS_METHODS.spacesPagesSubscribeChanges,
    idleTtlMs: CHANGES_IDLE_TTL_MS,
    transform: (stream) => stream.pipe(Stream.scan(() => EMPTY_REMOTE_PAGES, foldPageChanges)),
  });
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      // @effect-diagnostics-next-line globalTimers:off -- a one-shot debounce read by atoms, outside an Effect runtime.
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });
  const pageSignals = Atom.family((_key: string) => Atom.make<SpacePageLiveSignal>(NO_SIGNAL));
  const signalKey = (environmentId: EnvironmentId, pageId: SpacePageId) =>
    JSON.stringify([environmentId, pageId]);
  const resyncCounter = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));
  const treeCounter = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));

  // Mounted by whatever reads `pageLive` or `treeLive`; it depends on the capability only.
  const subscription = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (!pushes(options.capabilityAtom ? get(options.capabilityAtom(environmentId)) : undefined))
        return;
      const registry = get.registry;
      let latest: RemotePageChanges = EMPTY_REMOTE_PAGES;
      let appliedSeq = 0;
      let appliedTreeSeq = 0;
      let seenResyncs = 0;
      let totalResyncs = 0;
      let resyncWanted = false;
      let cancel: (() => void) | undefined;
      const apply = () => {
        cancel = undefined;
        const state = latest;
        for (const [pageId, page] of state.pages) {
          if (page.seq <= appliedSeq) continue;
          const atom = pageSignals(signalKey(environmentId, pageId));
          const held = registry.get(atom);
          registry.set(atom, {
            ...held,
            changeSeq: held.changeSeq + 1,
            revision: Math.max(held.revision ?? 0, page.revision),
            bodyRevision: Math.max(held.bodyRevision ?? 0, page.bodyRevision),
          });
        }
        appliedSeq = state.seq;
        const treeChanged = state.treeSeq > appliedTreeSeq;
        appliedTreeSeq = state.treeSeq;
        if (treeChanged) registry.update(treeCounter(environmentId), (count) => count + 1);
        if (resyncWanted) registry.update(resyncCounter(environmentId), (count) => count + 1);
        if (treeChanged || resyncWanted)
          registry.update(options.changed(environmentId), (count) => count + 1);
        resyncWanted = false;
      };
      get.addFinalizer(() => cancel?.());
      get.subscribe(
        remoteChanges({ environmentId, input: { environmentId } }),
        (result) => {
          if (result._tag !== "Success") return;
          latest = result.value;
          if (latest.resyncs !== seenResyncs) {
            // The first resync is the opening handshake; later ones mean the server dropped events.
            if (latest.resyncs > 0) {
              totalResyncs += 1;
              resyncWanted = resyncWanted || totalResyncs > 1;
            }
            seenResyncs = latest.resyncs;
          }
          if (cancel !== undefined) return;
          // A new stream restarts its sequence at zero.
          if (latest.seq < appliedSeq) {
            appliedSeq = 0;
            appliedTreeSeq = 0;
          }
          const unapplied =
            latest.treeSeq > appliedTreeSeq ||
            [...latest.pages.values()].some((page) => page.seq > appliedSeq);
          if (resyncWanted || unapplied) cancel = schedule(apply, REMOTE_APPLY_DELAY_MS);
        },
        { immediate: true },
      );
    }),
  );

  const liveAtoms = Atom.family((key: string) => {
    const [environmentId] = JSON.parse(key) as [EnvironmentId, SpacePageId];
    return Atom.make((get): SpacePageLiveSignal => {
      get(subscription(environmentId));
      return {
        ...get(pageSignals(key)),
        resyncSeq: get(resyncCounter(environmentId)),
      };
    });
  });
  const treeAtoms = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      get(subscription(environmentId));
      return get(treeCounter(environmentId));
    }),
  );
  /** What an open page watches; reading it mounts the environment's change stream. */
  const pageLive = (environmentId: EnvironmentId, pageId: SpacePageId) =>
    liveAtoms(signalKey(environmentId, pageId));
  /** Moves when the page tree changed elsewhere; mounting it keeps the change stream open. */
  const treeLive = (environmentId: EnvironmentId) => treeAtoms(environmentId);
  return { pageLive, treeLive, remoteChanges };
}

export type SpacesPageAtoms = ReturnType<typeof createSpacesPageAtoms>;
