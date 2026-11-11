import type {
  SpaceAggregateResult,
  SpaceDatabaseQueryInput,
  SpaceDatabaseQueryResult,
  SpaceDatabaseRow,
  SpaceGroupBucket,
  SpaceGroupKey,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";
import {
  EMPTY_PENDING_CELL_EDITS,
  applyCellPatches,
  queueCellEdit,
  type PendingCellEdit,
  type PendingCellEdits,
} from "./cellEdits.ts";
import { canonicalJson, queryKey } from "./queryKey.ts";
import type { RowPlacement } from "./regroup.ts";
import { appendWindow, startWindows, type QueryWindows } from "./windows.ts";

export interface QuerySessionPorts {
  /** Rejects on failure. */
  query(input: SpaceDatabaseQueryInput): Promise<SpaceDatabaseQueryResult>;
  schedule(run: () => void, delayMs: number): () => void;
  /** True while the writer of this data source has a write in flight. */
  busy(): boolean;
}

export interface QuerySnapshot {
  readonly status: "idle" | "loading" | "ready" | "error";
  /** Of the current key, or of the previous key while `stale`. */
  readonly windows: QueryWindows | null;
  readonly aggregates: ReadonlyArray<SpaceAggregateResult>;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  /** The shown data belongs to an older key or revision. */
  readonly stale: boolean;
  readonly loadingMore: boolean;
  /** `canonicalJson` of the group key (and sub-group key) being continued. */
  readonly loadingBuckets: ReadonlySet<string>;
  /** Rows created here, shown until the next refresh. */
  readonly placed: ReadonlyArray<{ row: SpaceDatabaseRow; group: string | null }>;
  /** Card drops shown until the next refresh answers (or the write fails and they are cleared). */
  readonly placements: Readonly<Record<string, RowPlacement>>;
  /** Acknowledged edits the shown rows do not contain yet; merge them under the writer's pending. */
  readonly acked: PendingCellEdits;
  readonly error: unknown;
  /** A continuation or refresh failed; the loaded windows stay usable and `retryLoad` asks again. */
  readonly loadError: unknown;
  /** The server is still bringing computed values up to date; the session asks again by itself. */
  readonly computedPending: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const NO_PLACEMENTS: Readonly<Record<string, RowPlacement>> = {};
const IDLE: QuerySnapshot = {
  status: "idle",
  windows: null,
  aggregates: [],
  relatedPages: {},
  stale: false,
  loadingMore: false,
  loadingBuckets: EMPTY_SET,
  placed: [],
  placements: NO_PLACEMENTS,
  acked: EMPTY_PENDING_CELL_EDITS,
  error: undefined,
  loadError: undefined,
  computedPending: false,
};

const PENDING_DELAYS_MS = [400, 800, 1600, 3200] as const;
/** After the backoff, a slow fixed interval: a large recompute can run for minutes. */
const PENDING_SLOW_DELAY_MS = 5000;
const REFRESH_DELAY_MS = 150;
const ACK_REFRESH_DELAY_MS = 1000;
const MAX_REFRESH_WINDOWS = 5;
const MAX_FILL_WINDOWS = 50;

const bucketId = (group: SpaceGroupKey, subGroup?: SpaceGroupKey) =>
  subGroup === undefined
    ? canonicalJson(group)
    : `${canonicalJson(group)}/${canonicalJson(subGroup)}`;

function isStaleCursor(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const tag: unknown = Reflect.get(error, "_tag");
  return (
    tag === "SpaceCursorStaleError" ||
    (tag === "SpaceValidationError" && Reflect.get(error, "reason") === "invalid_cursor")
  );
}

/** Keeps the previous object for every row whose JSON did not change, so memoized rows skip. */
function shareRows(
  previous: ReadonlyArray<SpaceDatabaseRow>,
  next: ReadonlyArray<SpaceDatabaseRow>,
): ReadonlyArray<SpaceDatabaseRow> {
  const old = new Map(previous.map((row) => [row.page.id, row]));
  let same = previous.length === next.length;
  const rows = next.map((row, index) => {
    const before = old.get(row.page.id);
    const kept =
      before !== undefined && canonicalJson(before) === canonicalJson(row) ? before : row;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? previous : rows;
}

function patchBuckets(
  buckets: ReadonlyArray<SpaceGroupBucket> | undefined,
  edits: PendingCellEdits,
): ReadonlyArray<SpaceGroupBucket> | undefined {
  if (buckets === undefined) return undefined;
  const patch = <B extends Pick<SpaceGroupBucket, "rows">>(bucket: B): B => {
    const rows = applyCellPatches(bucket.rows, edits);
    return rows.every((row, index) => row === bucket.rows[index]) ? bucket : { ...bucket, rows };
  };
  return buckets.map((bucket) => {
    const top = patch(bucket);
    const subGroups = top.subGroups?.map(patch);
    return subGroups !== undefined && subGroups.some((sub, i) => sub !== top.subGroups?.[i])
      ? { ...top, subGroups }
      : top;
  });
}

function shareBuckets(
  previous: ReadonlyArray<SpaceGroupBucket> | undefined,
  next: ReadonlyArray<SpaceGroupBucket> | undefined,
): ReadonlyArray<SpaceGroupBucket> | undefined {
  if (next === undefined) return undefined;
  if (previous === undefined) return next;
  const old = new Map(previous.map((bucket) => [canonicalJson(bucket.key), bucket]));
  const buckets = next.map((bucket) => {
    const before = old.get(canonicalJson(bucket.key));
    if (before === undefined) return bucket;
    const rows = shareRows(before.rows, bucket.rows);
    const shared = { ...bucket, rows };
    return canonicalJson({ ...before, rows: [] }) === canonicalJson({ ...shared, rows: [] }) &&
      rows === before.rows
      ? before
      : shared;
  });
  const identical =
    buckets.length === previous.length &&
    buckets.every((bucket, index) => bucket === previous[index]);
  return identical ? previous : buckets;
}

/**
 * Loads one view query window by window and folds the results into `QueryWindows`. Framework-free:
 * nothing stays subscribed to the server, a UI drives it and reads snapshots.
 */
export class DatabaseQuerySession {
  readonly #ports: QuerySessionPorts;
  readonly #listeners = new Set<() => void>();
  #snapshot: QuerySnapshot = IDLE;
  #input: SpaceDatabaseQueryInput | null = null;
  #key: string | null = null;
  #generation = 0;
  #holds = 0;
  #refreshWanted = false;
  #cancelTimer: (() => void) | undefined;
  #timerDelay = 0;
  #staleRetried = false;
  #disposed = false;
  #ackedRevision = 0;
  #retry: (() => void) | null = null;
  #fillRows = 0;
  /** Bumped by every placement and hold: a refresh that started before one must not answer over it. */
  #pinEpoch = 0;
  #followAttempt = 0;
  #followRun = false;

  constructor(ports: QuerySessionPorts) {
    this.#ports = ports;
  }

  /**
   * `fillRows` makes the session keep following `nextCursor` after the first window until the
   * query is complete or that many rows are loaded, so a bounded range (a calendar month) is whole.
   */
  setInput(input: SpaceDatabaseQueryInput | null, options?: { readonly fillRows?: number }): void {
    if (this.#disposed) return;
    const key = input === null ? null : queryKey(input);
    this.#fillRows = options?.fillRows ?? 0;
    if (key === this.#key) return;
    this.#key = key;
    this.#input = input;
    this.#generation++;
    this.#clearTimer();
    this.#refreshWanted = false;
    this.#staleRetried = false;
    this.#followAttempt = 0;
    this.#followRun = false;
    if (input === null) {
      this.#set(IDLE);
      return;
    }
    const keepWindows = this.#snapshot.windows;
    this.#set({
      ...IDLE,
      status: "loading",
      windows: keepWindows,
      aggregates: keepWindows === null ? [] : this.#snapshot.aggregates,
      relatedPages: keepWindows === null ? {} : this.#snapshot.relatedPages,
      stale: keepWindows !== null,
    });
    void this.#loadFirst(input, this.#generation);
  }

  loadMore(): void {
    const input = this.#input;
    const windows = this.#snapshot.windows;
    if (
      this.#disposed ||
      input === null ||
      windows === null ||
      input.mode !== "rows" ||
      windows.nextCursor === null ||
      this.#snapshot.loadingMore ||
      this.#snapshot.status !== "ready"
    )
      return;
    const generation = this.#generation;
    this.#retry = () => this.loadMore();
    this.#set({ ...this.#snapshot, loadingMore: true, loadError: undefined });
    void this.#append({ ...input, cursor: windows.nextCursor }, generation, () =>
      this.#set({ ...this.#snapshot, loadingMore: false }),
    );
  }

  loadBucket(group: SpaceGroupKey, subGroup?: SpaceGroupKey): void {
    const input = this.#input;
    const windows = this.#snapshot.windows;
    if (this.#disposed || input === null || windows === null || input.mode !== "groups") return;
    const id = bucketId(group, subGroup);
    if (this.#snapshot.loadingBuckets.has(id)) return;
    const top = windows.groups?.find(
      (bucket) => canonicalJson(bucket.key) === canonicalJson(group),
    );
    const bucket =
      subGroup === undefined
        ? top
        : top?.subGroups?.find((sub) => canonicalJson(sub.key) === canonicalJson(subGroup));
    if (bucket === undefined) return;
    const generation = this.#generation;
    this.#retry = () => this.loadBucket(group, subGroup);
    this.#set({
      ...this.#snapshot,
      loadingBuckets: new Set([...this.#snapshot.loadingBuckets, id]),
      loadError: undefined,
    });
    void this.#append(
      {
        ...input,
        mode: "rows",
        scope: { group, ...(subGroup === undefined ? {} : { subGroup }) },
        ...(bucket.nextCursor === null ? {} : { cursor: bucket.nextCursor }),
      },
      generation,
      () => {
        const loading = new Set(this.#snapshot.loadingBuckets);
        loading.delete(id);
        this.#set({ ...this.#snapshot, loadingBuckets: loading });
      },
    );
  }

  /** Asks again for whatever failed last: a continuation, a bucket or a refresh. */
  retryLoad(): void {
    this.#retry?.();
  }

  /** Teaches the session pages a write just referenced, until the next answer carries them. */
  noteRelatedPages(pages: Readonly<Record<string, SpaceRelatedPage>>): void {
    if (this.#disposed) return;
    this.#set({
      ...this.#snapshot,
      relatedPages: { ...this.#snapshot.relatedPages, ...pages },
    });
  }

  /** Coalesced, 150 ms trailing. */
  refresh(): void {
    this.#requestRefresh(REFRESH_DELAY_MS);
  }

  /** A counter bump: our own writes are handled through `noteAck`, so ignore it while busy. */
  invalidate(): void {
    if (this.#ports.busy()) return;
    this.refresh();
  }

  /**
   * Our own acknowledged write. The loaded rows still hold the old values, so the edits are folded
   * in (adopt path) or kept as an overlay until a refresh answers with the acked revision.
   */
  noteAck(ack: {
    dataRevision: number;
    affects: boolean;
    structural: boolean;
    edits?: ReadonlyArray<PendingCellEdit>;
  }): void {
    if (this.#disposed) return;
    this.#ackedRevision = Math.max(this.#ackedRevision, ack.dataRevision);
    let edits = EMPTY_PENDING_CELL_EDITS;
    for (const edit of ack.edits ?? []) edits = queueCellEdit(edits, edit);
    const hasEdits = edits !== EMPTY_PENDING_CELL_EDITS;
    const windows = this.#snapshot.windows;
    if (
      windows !== null &&
      ack.dataRevision === windows.dataRevision + 1 &&
      !ack.affects &&
      !ack.structural
    ) {
      // Silent: no consumer shows the revision, and appendWindow compares against it.
      this.#snapshot = {
        ...this.#snapshot,
        windows: {
          ...windows,
          dataRevision: ack.dataRevision,
          rows: hasEdits ? applyCellPatches(windows.rows, edits) : windows.rows,
          groups: hasEdits ? patchBuckets(windows.groups, edits) : windows.groups,
        },
      };
      if (hasEdits) for (const listener of this.#listeners) listener();
      return;
    }
    if (hasEdits) {
      let acked = this.#snapshot.acked;
      for (const edit of Object.values(edits)) acked = queueCellEdit(acked, edit);
      this.#set({ ...this.#snapshot, acked });
    }
    if (windows !== null) {
      this.#requestRefresh(ack.structural ? REFRESH_DELAY_MS : ACK_REFRESH_DELAY_MS);
    }
  }

  placeRow(row: SpaceDatabaseRow, group: SpaceGroupKey | null): void {
    if (this.#disposed) return;
    this.#pinEpoch++;
    this.#set({
      ...this.#snapshot,
      placed: [
        ...this.#snapshot.placed,
        { row, group: group === null ? null : canonicalJson(group) },
      ],
    });
  }

  /** `undefined` for a page clears its placement; a refresh answer clears them all. */
  setPlacement(pageId: string, placement: RowPlacement | undefined): void {
    if (this.#disposed) return;
    if (placement !== undefined) this.#pinEpoch++;
    const { [pageId]: _dropped, ...rest } = this.#snapshot.placements;
    this.#set({
      ...this.#snapshot,
      placements: placement === undefined ? rest : { ...rest, [pageId]: placement },
    });
  }

  /** Refreshes wait until every hold is released. */
  hold(): () => void {
    this.#holds++;
    this.#pinEpoch++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holds--;
      if (this.#holds === 0 && this.#refreshWanted) this.#requestRefresh(REFRESH_DELAY_MS);
    };
  }

  /** Arrow fields, so they can be handed to `useSyncExternalStore` unbound. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): QuerySnapshot => this.#snapshot;

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    this.#listeners.clear();
  }

  #set(snapshot: QuerySnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #clearTimer() {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#timerDelay = 0;
  }

  #requestRefresh(delayMs: number) {
    if (this.#disposed || this.#input === null) return;
    this.#refreshWanted = true;
    if (this.#holds > 0) return;
    if (this.#cancelTimer !== undefined) {
      if (this.#timerDelay <= delayMs) return;
      this.#clearTimer();
    }
    this.#timerDelay = delayMs;
    this.#cancelTimer = this.#ports.schedule(() => {
      this.#cancelTimer = undefined;
      this.#timerDelay = 0;
      if (this.#holds > 0 || !this.#refreshWanted) return;
      this.#refreshWanted = false;
      void this.#runRefresh();
    }, delayMs);
  }

  /** While an answer says computed values are pending, refresh again with a growing delay. */
  #followPending(pending: boolean) {
    if (!pending) {
      this.#followAttempt = 0;
      return;
    }
    const delay = PENDING_DELAYS_MS[this.#followAttempt] ?? PENDING_SLOW_DELAY_MS;
    this.#followAttempt++;
    this.#followRun = true;
    this.#requestRefresh(delay);
  }

  #firstInput(input: SpaceDatabaseQueryInput): SpaceDatabaseQueryInput {
    const { cursor: _cursor, scope, ...rest } = input;
    const parent = scope?.parentRowId;
    return {
      ...rest,
      ...(parent === undefined ? {} : { scope: { parentRowId: parent } }),
      include: { ...input.include, total: true, aggregates: true },
    };
  }

  async #loadFirst(input: SpaceDatabaseQueryInput, generation: number) {
    try {
      const result = await this.#ports.query(this.#firstInput(input));
      if (this.#disposed || generation !== this.#generation) return;
      this.#staleRetried = false;
      const behind = result.dataRevision < this.#ackedRevision;
      this.#set({
        ...IDLE,
        status: "ready",
        windows: startWindows(input, result),
        aggregates: result.aggregates ?? [],
        relatedPages: result.relatedPages,
        acked: behind ? this.#snapshot.acked : EMPTY_PENDING_CELL_EDITS,
        computedPending: result.computedPending === true,
      });
      if (behind) this.#requestRefresh(REFRESH_DELAY_MS);
      else this.#followPending(result.computedPending === true);
      await this.#fill(generation);
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      this.#set({ ...this.#snapshot, status: "error", error, loadingMore: false });
    }
  }

  /** Follows the cursor until the query is whole or the row cap is reached, window by window. */
  async #fill(generation: number) {
    const input = this.#input;
    if (this.#fillRows <= 0 || input === null || input.mode !== "rows") return;
    for (let step = 0; step < MAX_FILL_WINDOWS; step++) {
      const windows = this.#snapshot.windows;
      if (
        this.#disposed ||
        generation !== this.#generation ||
        windows === null ||
        windows.nextCursor === null ||
        windows.rows.length >= this.#fillRows
      )
        return;
      this.#retry = () => this.refresh();
      const before = windows.rows.length;
      await this.#append({ ...input, cursor: windows.nextCursor }, generation, () => {});
      if (this.#snapshot.loadError !== undefined) return;
      if ((this.#snapshot.windows?.rows.length ?? before) === before) return;
    }
  }

  async #append(input: SpaceDatabaseQueryInput, generation: number, done: () => void) {
    try {
      const result = await this.#ports.query(input);
      if (this.#disposed || generation !== this.#generation) return;
      const windows = this.#snapshot.windows;
      if (windows === null) return;
      this.#staleRetried = false;
      const next = appendWindow(windows, input, result);
      done();
      this.#set({
        ...this.#snapshot,
        windows: next,
        aggregates: this.#snapshot.aggregates,
        relatedPages: { ...this.#snapshot.relatedPages, ...result.relatedPages },
        loadError: undefined,
      });
      if (next.outdated) this.refresh();
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      done();
      if (isStaleCursor(error) && !this.#staleRetried) {
        this.#staleRetried = true;
        this.refresh();
        return;
      }
      this.#set({ ...this.#snapshot, loadError: error });
    }
  }

  /** Continues every bucket that held more rows before the refresh, off-screen, within the budget. */
  async #regrowBuckets(
    input: SpaceDatabaseQueryInput,
    start: QueryWindows,
    previous: ReadonlyArray<SpaceGroupBucket>,
    relatedPages: Record<string, SpaceRelatedPage>,
    generation: number,
  ): Promise<QueryWindows> {
    let windows = start;
    let budget = MAX_REFRESH_WINDOWS - 1;
    const find = (key: SpaceGroupKey, subKey?: SpaceGroupKey) => {
      const top = windows.groups?.find(
        (bucket) => canonicalJson(bucket.key) === canonicalJson(key),
      );
      return subKey === undefined
        ? top
        : top?.subGroups?.find((sub) => canonicalJson(sub.key) === canonicalJson(subKey));
    };
    const targets: Array<{ key: SpaceGroupKey; subKey?: SpaceGroupKey; rows: number }> = [];
    for (const bucket of previous) {
      targets.push({ key: bucket.key, rows: bucket.rows.length });
      for (const sub of bucket.subGroups ?? [])
        targets.push({ key: bucket.key, subKey: sub.key, rows: sub.rows.length });
    }
    for (const target of targets) {
      for (;;) {
        const bucket = find(target.key, target.subKey);
        if (
          bucket === undefined ||
          bucket.rows.length >= target.rows ||
          bucket.nextCursor === null ||
          budget <= 0
        )
          break;
        budget--;
        const request: SpaceDatabaseQueryInput = {
          ...input,
          mode: "rows",
          scope: {
            group: target.key,
            ...(target.subKey === undefined ? {} : { subGroup: target.subKey }),
          },
          cursor: bucket.nextCursor,
        };
        const result = await this.#ports.query(request);
        if (this.#disposed || generation !== this.#generation) return windows;
        windows = appendWindow(windows, request, result);
        Object.assign(relatedPages, result.relatedPages);
      }
    }
    return windows;
  }

  async #runRefresh() {
    const input = this.#input;
    if (input === null || this.#disposed) return;
    const generation = ++this.#generation;
    const epoch = this.#pinEpoch;
    if (!this.#followRun) this.#followAttempt = 0;
    this.#followRun = false;
    const previous = this.#snapshot.windows;
    if (previous === null) {
      this.#set({ ...IDLE, status: "loading" });
      await this.#loadFirst(input, generation);
      return;
    }
    this.#set({
      ...this.#snapshot,
      stale: true,
      loadingMore: false,
      loadingBuckets: EMPTY_SET,
      loadError: undefined,
    });
    try {
      const first = this.#firstInput(input);
      const firstResult = await this.#ports.query(first);
      if (this.#disposed || generation !== this.#generation) return;
      let windows = startWindows(input, firstResult);
      const relatedPages = { ...firstResult.relatedPages };
      if (input.mode === "rows") {
        const limit = input.limit ?? Math.max(1, firstResult.rows.length);
        const needed = Math.min(
          MAX_REFRESH_WINDOWS,
          Math.max(1, Math.ceil(previous.rows.length / limit)),
        );
        for (let fetched = 1; fetched < needed && windows.nextCursor !== null; fetched++) {
          const result = await this.#ports.query({ ...input, cursor: windows.nextCursor });
          if (this.#disposed || generation !== this.#generation) return;
          windows = appendWindow(windows, input, result);
          Object.assign(relatedPages, result.relatedPages);
        }
      } else if (previous.groups !== undefined) {
        windows = await this.#regrowBuckets(
          input,
          windows,
          previous.groups,
          relatedPages,
          generation,
        );
        if (this.#disposed || generation !== this.#generation) return;
      }
      if (this.#holds > 0 || this.#pinEpoch !== epoch) {
        // A drag or a placement began while this answer was on the way; it would reshuffle them.
        this.#set({ ...this.#snapshot, stale: false });
        this.#refreshWanted = true;
        if (this.#holds === 0) this.#requestRefresh(REFRESH_DELAY_MS);
        return;
      }
      this.#staleRetried = false;
      const behind = firstResult.dataRevision < this.#ackedRevision;
      this.#set({
        status: "ready",
        windows: {
          ...windows,
          outdated: false,
          rows: shareRows(previous.rows, windows.rows),
          groups: shareBuckets(previous.groups, windows.groups),
        },
        aggregates: firstResult.aggregates ?? [],
        relatedPages,
        stale: false,
        loadingMore: false,
        loadingBuckets: EMPTY_SET,
        placed: [],
        placements: NO_PLACEMENTS,
        acked: behind ? this.#snapshot.acked : EMPTY_PENDING_CELL_EDITS,
        error: undefined,
        loadError: undefined,
        computedPending: firstResult.computedPending === true,
      });
      if (behind) this.#requestRefresh(REFRESH_DELAY_MS);
      else this.#followPending(firstResult.computedPending === true);
      await this.#fill(generation);
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      if (isStaleCursor(error) && !this.#staleRetried) {
        this.#staleRetried = true;
        this.refresh();
        return;
      }
      this.#retry = () => this.refresh();
      this.#set({ ...this.#snapshot, stale: false, loadError: error });
    }
  }
}
