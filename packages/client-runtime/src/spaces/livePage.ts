import type { SpacePageChangeEvent, SpacePageId } from "@t2code/contracts/spaces";

/** What a client knows about the newest announced state of one page. */
export interface SpacePageLiveSignal {
  /** Moves once per coalesced announcement for this page. */
  readonly changeSeq: number;
  /** Moves once per stream resync after the first. */
  readonly resyncSeq: number;
  readonly revision?: number;
  readonly bodyRevision?: number;
}

/** What a client knows about the newest announced comments of one page. */
export interface SpacePageCommentSignal {
  /** Moves once per announcement that changed the page's comments. */
  readonly commentSeq: number;
  /** Moves once per stream resync after the first. */
  readonly resyncSeq: number;
}

export type SpaceLiveAction = "none" | "hold" | "metadata" | "body" | "check";

/** Decides how an open document reacts to a live signal; never reads anything itself. */
export function spaceLiveAction(
  previous: SpacePageLiveSignal | null,
  next: SpacePageLiveSignal,
  state: {
    readonly hydrated: boolean;
    readonly busy: boolean;
    readonly baseRevision: number | null;
    readonly metadataRevision: number | null;
  },
): SpaceLiveAction {
  const changed = next.changeSeq !== (previous?.changeSeq ?? 0);
  const resynced = next.resyncSeq !== (previous?.resyncSeq ?? 0);
  if (!changed && !resynced) return "none";
  if (!state.hydrated) return "none";
  if (state.busy) return "hold";
  if (resynced) return "check";
  if (
    next.bodyRevision !== undefined &&
    state.baseRevision !== null &&
    next.bodyRevision > state.baseRevision
  )
    return "body";
  if (
    next.revision !== undefined &&
    state.metadataRevision !== null &&
    next.revision > state.metadataRevision
  )
    return "metadata";
  return "none";
}

/** Past this many remembered pages the state forgets them and asks every open page to check once. */
export const MAX_REMOTE_PAGES = 512;

export interface RemotePage {
  readonly revision: number;
  readonly bodyRevision: number;
  /** 0 until a comment change is announced. */
  readonly commentRevision: number;
  /** The event sequence number that last announced this page. */
  readonly seq: number;
}

/** What the page change stream has announced; `seq` counts events and restarts with a new stream. */
export interface RemotePageChanges {
  readonly seq: number;
  readonly resyncs: number;
  /** The sequence number of the newest event that touched a tree, a removal or a space. */
  readonly treeSeq: number;
  readonly pages: ReadonlyMap<SpacePageId, RemotePage>;
}

export const EMPTY_REMOTE_PAGES: RemotePageChanges = {
  seq: 0,
  resyncs: 0,
  treeSeq: 0,
  pages: new Map(),
};

export function foldPageChanges(
  state: RemotePageChanges,
  event: SpacePageChangeEvent,
): RemotePageChanges {
  const seq = state.seq + 1;
  if (event.type === "resync")
    return { ...EMPTY_REMOTE_PAGES, seq, resyncs: state.resyncs + 1, treeSeq: state.treeSeq };
  const pages = new Map(state.pages);
  let tree = event.spaces.length > 0;
  for (const change of event.pages) {
    const held = pages.get(change.id);
    pages.set(change.id, {
      revision: Math.max(held?.revision ?? 0, change.revision),
      bodyRevision: Math.max(held?.bodyRevision ?? 0, change.bodyRevision),
      commentRevision: Math.max(held?.commentRevision ?? 0, change.commentRevision ?? 0),
      seq,
    });
    if (change.tree === true || change.removed === true) tree = true;
  }
  if (pages.size > MAX_REMOTE_PAGES)
    return { ...EMPTY_REMOTE_PAGES, seq, resyncs: state.resyncs + 1, treeSeq: seq };
  return { seq, resyncs: state.resyncs, treeSeq: tree ? seq : state.treeSeq, pages };
}
