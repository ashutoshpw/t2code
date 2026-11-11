import type { SpaceDataSourceId, SpacePropertyId } from "@t2code/contracts/spaces";
import {
  EMPTY_PENDING_CELL_EDITS,
  coalesceCellWrites,
  queueCellEdit,
  settleCellEdits,
  type CellWriteBatch,
  type PendingCellEdit,
  type PendingCellEdits,
} from "./cellEdits.ts";

export interface DatabaseWriterPorts {
  /** Rejects with the typed failure. */
  updateRows(batch: CellWriteBatch): Promise<{ dataRevision: number }>;
  limits(): { maxRowsPerMutation: number; maxCellsPerMutation: number };
  /** Returns the cancel function. */
  schedule(run: () => void, delayMs: number): () => void;
  /** True when the server refused the value, so the edits are dropped; false means retry later. */
  rejected(error: unknown): boolean;
  report(error: unknown, edits: ReadonlyArray<PendingCellEdit>): void;
}

export interface WriterSnapshot {
  readonly pending: PendingCellEdits;
  /** Edits waiting for a retry after a transport failure. */
  readonly failed: number;
}

export interface WriteAck {
  readonly dataSourceId: SpaceDataSourceId;
  readonly dataRevision: number;
  readonly propertyIds: ReadonlySet<SpacePropertyId>;
  readonly structural: boolean;
  /** The cell edits this acknowledgement carries; empty for structural writes. */
  readonly edits: ReadonlyArray<PendingCellEdit>;
}

export const WRITER_DEBOUNCE_MS = 250;
export const WRITER_MAX_WAIT_MS = 1000;

const keyOf = (edit: Pick<PendingCellEdit, "pageId" | "propertyId">) =>
  JSON.stringify([edit.pageId, edit.propertyId]);

/**
 * Owns the cell-edit queue of one environment and wraps every row mutation, so a view can tell its
 * own writes from foreign ones: `busy` stays true until the acknowledgement listeners ran.
 */
export class DatabaseWriter {
  readonly #ports: DatabaseWriterPorts;
  readonly #listeners = new Set<() => void>();
  readonly #ackListeners = new Set<(ack: WriteAck) => void>();
  readonly #busy = new Map<SpaceDataSourceId, number>();
  readonly #failed = new Set<string>();
  #pending: PendingCellEdits = EMPTY_PENDING_CELL_EDITS;
  #snapshot: WriterSnapshot = { pending: EMPTY_PENDING_CELL_EDITS, failed: 0 };
  #seq = 0;
  #debounce: (() => void) | undefined;
  #maxWait: (() => void) | undefined;
  #running: Promise<void> | undefined;
  #again = false;

  constructor(ports: DatabaseWriterPorts) {
    this.#ports = ports;
  }

  editCell(edit: Omit<PendingCellEdit, "seq">): void {
    const next = { ...edit, seq: ++this.#seq };
    this.#failed.delete(keyOf(next));
    this.#pending = queueCellEdit(this.#pending, next);
    this.#publish();
    this.#debounce?.();
    this.#debounce = this.#ports.schedule(() => this.#fire(), WRITER_DEBOUNCE_MS);
    this.#maxWait ??= this.#ports.schedule(() => this.#fire(), WRITER_MAX_WAIT_MS);
  }

  /** Sends every queued edit that is not waiting for a retry, including edits made meanwhile. */
  async flush(): Promise<void> {
    this.#cancelTimers();
    for (;;) {
      if (this.#running !== undefined) await this.#running;
      else if (Object.keys(this.#eligible()).length > 0) {
        this.#running = this.#round().finally(() => {
          this.#running = undefined;
        });
        await this.#running;
      } else return;
    }
  }

  retry(): void {
    if (this.#failed.size === 0) return;
    this.#failed.clear();
    this.#publish();
    void this.flush();
  }

  discardFailed(): void {
    if (this.#failed.size === 0) return;
    const dropped = Object.entries(this.#pending).filter(([key]) => this.#failed.has(key));
    this.#failed.clear();
    this.#pending = settleCellEdits(
      this.#pending,
      dropped.map(([, edit]) => edit),
    );
    this.#publish();
  }

  async track<T extends { dataRevision: number }>(
    dataSourceId: SpaceDataSourceId,
    effect: {
      propertyIds?: Iterable<SpacePropertyId>;
      structural: boolean;
      edits?: ReadonlyArray<PendingCellEdit>;
      /** Runs right after the ack listeners, in the same synchronous block. */
      settle?: () => void;
    },
    run: () => Promise<T>,
  ): Promise<T> {
    this.#busy.set(dataSourceId, (this.#busy.get(dataSourceId) ?? 0) + 1);
    try {
      const result = await run();
      const ack: WriteAck = {
        dataSourceId,
        dataRevision: result.dataRevision,
        propertyIds: new Set(effect.propertyIds ?? []),
        structural: effect.structural,
        edits: effect.edits ?? [],
      };
      for (const listener of this.#ackListeners) listener(ack);
      effect.settle?.();
      return result;
    } finally {
      const count = (this.#busy.get(dataSourceId) ?? 1) - 1;
      if (count <= 0) this.#busy.delete(dataSourceId);
      else this.#busy.set(dataSourceId, count);
    }
  }

  busy(dataSourceId: SpaceDataSourceId): boolean {
    return this.#busy.has(dataSourceId);
  }

  onAck(listener: (ack: WriteAck) => void): () => void {
    this.#ackListeners.add(listener);
    return () => this.#ackListeners.delete(listener);
  }

  /** Arrow fields, so they can be handed to `useSyncExternalStore` unbound. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): WriterSnapshot => this.#snapshot;

  #eligible(): PendingCellEdits {
    if (this.#failed.size === 0) return this.#pending;
    return Object.fromEntries(
      Object.entries(this.#pending).filter(([key]) => !this.#failed.has(key)),
    );
  }

  #cancelTimers() {
    this.#debounce?.();
    this.#maxWait?.();
    this.#debounce = undefined;
    this.#maxWait = undefined;
  }

  #fire() {
    this.#cancelTimers();
    if (this.#running !== undefined) {
      this.#again = true;
      return;
    }
    this.#running = this.#round().finally(() => {
      this.#running = undefined;
      if (this.#again) {
        this.#again = false;
        this.#fire();
      }
    });
  }

  async #round(): Promise<void> {
    const batches = coalesceCellWrites(this.#eligible(), this.#ports.limits());
    for (const batch of batches) {
      const propertyIds = new Set(batch.edits.map((edit) => edit.propertyId));
      try {
        await this.track(
          batch.dataSourceId,
          {
            propertyIds,
            structural: false,
            edits: batch.edits,
            // After the listeners folded the edits into the loaded rows, so the old value never shows.
            settle: () => {
              this.#pending = settleCellEdits(this.#pending, batch.edits);
              this.#publish();
            },
          },
          () => this.#ports.updateRows(batch),
        );
      } catch (error) {
        if (this.#ports.rejected(error)) {
          this.#pending = settleCellEdits(this.#pending, batch.edits);
          for (const edit of batch.edits) this.#failed.delete(keyOf(edit));
          this.#publish();
          this.#ports.report(error, batch.edits);
        } else {
          for (const edit of batch.edits) this.#failed.add(keyOf(edit));
          this.#publish();
        }
      }
    }
  }

  #publish() {
    const failed = Object.keys(this.#pending).filter((key) => this.#failed.has(key)).length;
    if (this.#snapshot.pending !== this.#pending || this.#snapshot.failed !== failed) {
      this.#snapshot = { pending: this.#pending, failed };
    }
    for (const listener of this.#listeners) listener();
  }
}
