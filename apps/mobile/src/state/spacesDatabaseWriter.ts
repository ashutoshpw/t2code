import {
  DatabaseWriter,
  databaseErrorMessage,
  type PendingCellEdit,
} from "@t2code/client-runtime/spaces";
import type { DatabaseMutations } from "@t2code/client-runtime/state/spaces-database-mutations";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSourceId } from "@t2code/contracts/spaces";

/** Rows and cells per mutation when the capability has not loaded yet; the server limit applies either way. */
export const FALLBACK_WRITE_LIMITS = { maxRowsPerMutation: 50, maxCellsPerMutation: 200 };

const REJECTING_TAGS = new Set([
  "SpaceDatabaseError",
  "SpaceNotFoundError",
  "SpaceLimitExceededError",
  "SpaceValidationError",
]);

/** The server refused the value itself, so retrying cannot help. */
export const writerRejects = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  REJECTING_TAGS.has(String(Reflect.get(error, "_tag")));

export interface WriteFailure {
  readonly id: number;
  readonly environmentId: EnvironmentId;
  readonly dataSourceId: SpaceDataSourceId | undefined;
  readonly message: string;
}

/** The refused writes of one environment; failures are kept for all environments in one store. */
export const failuresOf = (
  failures: ReadonlyArray<WriteFailure>,
  environmentId: EnvironmentId,
): ReadonlyArray<WriteFailure> => failures.filter((entry) => entry.environmentId === environmentId);

/** The refused writes still to show: the newest few of each environment. */
export function createWriteFailures(max = 3) {
  const listeners = new Set<() => void>();
  let snapshot: ReadonlyArray<WriteFailure> = [];
  let next = 0;
  const publish = (value: ReadonlyArray<WriteFailure>) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    add: (entry: Omit<WriteFailure, "id">) => {
      const own = failuresOf(snapshot, entry.environmentId);
      const kept = own.slice(Math.max(0, own.length - (max - 1)));
      publish([
        ...snapshot.filter((other) => other.environmentId !== entry.environmentId),
        ...kept,
        { id: ++next, ...entry },
      ]);
    },
    dismiss: (id: number) => publish(snapshot.filter((entry) => entry.id !== id)),
  };
}
export type WriteFailures = ReturnType<typeof createWriteFailures>;

/**
 * One environment's cell writer: edits go through the shared mutation runner, a refused value is
 * dropped and reported, anything else stays queued for retry.
 */
export function createCellWriter(args: {
  readonly environmentId: EnvironmentId;
  readonly mutations: Pick<DatabaseMutations, "updateRows">;
  readonly registry: Parameters<DatabaseMutations["updateRows"]>[0];
  readonly canWrite: () => boolean;
  readonly limits: () => { maxRowsPerMutation: number; maxCellsPerMutation: number } | undefined;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly failures: WriteFailures;
}): DatabaseWriter {
  return new DatabaseWriter({
    updateRows: async (batch) => {
      if (!args.canWrite()) throw new Error("You can no longer edit this database.");
      const result = await args.mutations.updateRows(args.registry, args.environmentId, {
        dataSourceId: batch.dataSourceId,
        rows: batch.rows.map((row) => ({ pageId: row.pageId, cells: { ...row.cells } })),
      });
      return { dataRevision: result.dataRevision };
    },
    limits: () => args.limits() ?? FALLBACK_WRITE_LIMITS,
    schedule: args.schedule,
    rejected: writerRejects,
    report: (error: unknown, edits: ReadonlyArray<PendingCellEdit>) =>
      args.failures.add({
        environmentId: args.environmentId,
        dataSourceId: edits[0]?.dataSourceId,
        message: databaseErrorMessage(error),
      }),
  });
}
