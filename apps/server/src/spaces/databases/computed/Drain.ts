import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { computedDrainRows, computedDrainSteps } from "../../CorePolicy.ts";
import * as SpacesSql from "../../SpacesSql.ts";
import * as CellStore from "../CellStore.ts";
import * as SchemaStore from "../SchemaStore.ts";
import type { Snapshot } from "../SchemaStore.ts";
import * as Deps from "./Deps.ts";
import * as Dirty from "./Dirty.ts";
import * as Evaluate from "./Evaluate.ts";
import { isMaterialized } from "./Record.ts";
import { toCellItems } from "./Values.ts";
import { processZone } from "./Zone.ts";

const CHUNK = 50;

interface Budget {
  steps: number;
  readonly limit: number;
}

const newBudget = (): Budget => ({ steps: 0, limit: computedDrainSteps });

interface QueuedRow {
  readonly page_id: string;
  readonly data_source_id: string;
}

/** Whether rows of the data source still wait for their computed values. */
export const pending = Effect.fn("SpacesDatabases.computedPending")(function* (
  dataSourceId: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] =
    yield* sql`SELECT 1 FROM spaces_db_computed_dirty WHERE data_source_id = ${dataSourceId} LIMIT 1`;
  return row !== undefined;
});

export const queued = Effect.fn("SpacesDatabases.computedQueued")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql`SELECT 1 FROM spaces_db_computed_dirty LIMIT 1`;
  return row !== undefined;
});

/**
 * Computes up to `limit` queued rows in the current transaction (the caller holds the write
 * mutex), propagating to the rows that read them across relations. Stops once the evaluation
 * steps spent reach `computedDrainSteps`, a deterministic stand-in for wall time; unprocessed
 * rows stay queued. Returns the data sources whose cells changed.
 */
export const batch = Effect.fn("SpacesDatabases.drainBatch")(function* (input: {
  readonly limit: number;
  readonly order: "ASC" | "DESC";
  /** Shared by the batches of one lock hold; a fresh budget otherwise. */
  readonly budget?: Budget;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const now = yield* Clock.currentTimeMillis;
  const budget = input.budget ?? newBudget();
  const picked =
    input.order === "ASC"
      ? yield* sql<QueuedRow>`SELECT page_id, data_source_id FROM spaces_db_computed_dirty ORDER BY rowid ASC LIMIT ${input.limit}`
      : yield* sql<QueuedRow>`SELECT page_id, data_source_id FROM spaces_db_computed_dirty ORDER BY rowid DESC LIMIT ${input.limit}`;
  const changed = new Set<string>();
  const snapshots = new Map<string, Snapshot>();
  const dependents = new Map<string, readonly Deps.Dependent[]>();
  let processed = 0;
  let stopped = false;
  // A row leaves the queue before its propagation re-queues the rows that read it.
  const dequeue = Effect.fn("SpacesDatabases.dequeueComputed")(function* (
    pageIds: readonly string[],
  ) {
    yield* sql`DELETE FROM spaces_db_computed_dirty WHERE page_id IN ${sql.in(pageIds)}`;
    processed += pageIds.length;
  });
  for (let start = 0; start < picked.length; start += CHUNK) {
    if (processed > 0 && budget.steps >= budget.limit) {
      stopped = true;
      break;
    }
    const chunk = picked.slice(start, start + CHUNK);
    const bySource = new Map<string, string[]>();
    for (const row of chunk)
      bySource.set(row.data_source_id, [...(bySource.get(row.data_source_id) ?? []), row.page_id]);
    for (const [dataSourceId, pageIds] of bySource) {
      if (stopped) break;
      let snapshot = snapshots.get(dataSourceId);
      if (snapshot === undefined) {
        const loaded = yield* SchemaStore.load(dataSourceId).pipe(Effect.option);
        if (loaded._tag === "None") {
          yield* dequeue(pageIds);
          continue;
        }
        snapshot = loaded.value;
        snapshots.set(dataSourceId, snapshot);
      }
      const properties = snapshot.live.filter(
        (property) =>
          (property.type === "formula" || property.type === "rollup") &&
          isMaterialized(property.computed),
      );
      if (properties.length === 0) {
        yield* dequeue(pageIds);
        continue;
      }
      const evaluated = yield* Evaluate.rows({
        snapshot,
        pageIds,
        properties,
        now,
        timeZone: processZone,
        budget,
      });
      if (evaluated.done.length < pageIds.length) stopped = true;
      yield* dequeue(evaluated.done);
      for (const pageId of evaluated.done) {
        for (const property of properties) {
          const value = evaluated.values.get(pageId)?.get(property.id) ?? null;
          const items = toCellItems(value, property.computed!.type, {
            timeZone: processZone,
            titleOf: evaluated.titleOf,
            ...(evaluated.colorsOf(property.id) === undefined
              ? {}
              : { colorOf: evaluated.colorsOf(property.id)! }),
          });
          if (!(yield* CellStore.replace(pageId, dataSourceId, property.id, items))) continue;
          changed.add(dataSourceId);
          const key = `${dataSourceId}\u0000${property.id}`;
          const found =
            dependents.get(key) ?? (yield* Deps.dependentsOf(dataSourceId, property.id));
          dependents.set(key, found);
          for (const dependent of found)
            if (dependent.via_property_id !== "")
              yield* Dirty.enqueueReferrers(
                dependent.data_source_id,
                dependent.via_property_id,
                pageId,
              );
        }
      }
    }
  }
  return { processed, changed, stopped };
});

/**
 * The share of the queue a mutation computes itself (newest first, so its own rows and what they
 * feed are served before older backlog); the background drain does the rest.
 */
export const inMutation = Effect.fn("SpacesDatabases.drainInMutation")(function* () {
  const changed = new Set<string>();
  const budget = newBudget();
  let remaining = computedDrainRows;
  while (remaining > 0) {
    const result = yield* batch({ limit: remaining, order: "DESC", budget });
    for (const id of result.changed) changed.add(id);
    remaining -= result.processed;
    if (result.processed === 0 || result.stopped || remaining <= 0) break;
    if (!(yield* queued())) break;
  }
  return changed;
});
