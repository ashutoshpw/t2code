import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as SpacesSql from "../SpacesSql.ts";

/** A mailbox holding more ids than this collapses to `resync`, which bounds memory per subscriber. */
export const MAILBOX_LIMIT = 512;
const EVENT_LIMIT = C.SPACE_DATABASE_CHANGES_MAX_ENTRIES;

export interface DataSourceChange {
  readonly id: string;
  readonly databaseId: string;
  readonly schemaRevision: number;
  readonly dataRevision: number;
}

/** What one committed transaction changed, with the revisions it committed. */
export interface ChangeBatch {
  readonly dataSources: ReadonlyArray<DataSourceChange>;
  readonly databases: ReadonlyArray<{ readonly id: string; readonly revision: number }>;
}

export interface ChangeCollector {
  readonly dataSources: Set<string>;
  readonly databases: Set<string>;
}

/** The default collector is detached: records made outside a published transaction go nowhere. */
export const CurrentChangeCollector = Context.Reference<ChangeCollector | undefined>(
  "@t2code/cli/spaces/databases/CurrentChangeCollector",
  { defaultValue: () => undefined },
);

export const makeCollector = (): ChangeCollector => ({
  dataSources: new Set(),
  databases: new Set(),
});

export const recordDataSource = (id: string) =>
  Effect.map(CurrentChangeCollector, (collector) => void collector?.dataSources.add(id));

export const recordDatabase = (id: string) =>
  Effect.map(CurrentChangeCollector, (collector) => void collector?.databases.add(id));

/** Reads the committed revisions of what the collector recorded; ids that no longer exist are dropped. */
export const resolve = Effect.fn("SpacesDatabaseChanges.resolve")(function* (
  collector: ChangeCollector,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const dataSources =
    collector.dataSources.size === 0
      ? []
      : yield* sql<{
          readonly id: string;
          readonly databaseId: string;
          readonly schemaRevision: number;
          readonly dataRevision: number;
        }>`SELECT data_source_id AS id, database_id AS databaseId, schema_revision AS schemaRevision, data_revision AS dataRevision
          FROM spaces_db_data_sources WHERE data_source_id IN ${sql.in([...collector.dataSources])}`;
  const databases =
    collector.databases.size === 0
      ? []
      : yield* sql<{
          readonly id: string;
          readonly revision: number;
        }>`SELECT database_id AS id, revision FROM spaces_db_databases WHERE database_id IN ${sql.in([...collector.databases])}`;
  return { dataSources, databases } satisfies ChangeBatch;
});

interface Mailbox {
  readonly signal: Queue.Queue<void>;
  readonly dataSources: Map<string, DataSourceChange>;
  readonly databases: Map<string, number>;
  overflow: boolean;
}

const merge = (mailbox: Mailbox, batch: ChangeBatch) => {
  if (mailbox.overflow) return;
  for (const next of batch.dataSources) {
    const held = mailbox.dataSources.get(next.id);
    mailbox.dataSources.set(
      next.id,
      held === undefined
        ? next
        : {
            ...next,
            schemaRevision: Math.max(held.schemaRevision, next.schemaRevision),
            dataRevision: Math.max(held.dataRevision, next.dataRevision),
          },
    );
  }
  for (const next of batch.databases)
    mailbox.databases.set(next.id, Math.max(mailbox.databases.get(next.id) ?? 0, next.revision));
  if (mailbox.dataSources.size + mailbox.databases.size > MAILBOX_LIMIT) {
    mailbox.overflow = true;
    mailbox.dataSources.clear();
    mailbox.databases.clear();
  }
};

const chunks = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const out: A[][] = [];
  for (let index = 0; index < items.length; index += EVENT_LIMIT)
    out.push(items.slice(index, index + EVENT_LIMIT));
  return out;
};

/** Takes and clears a mailbox: one `resync` after an overflow, otherwise `changed` events of at most 256 entries. */
const take = (mailbox: Mailbox): ReadonlyArray<C.SpaceDatabaseChangeEvent> => {
  if (mailbox.overflow) {
    mailbox.overflow = false;
    return [{ type: "resync" }];
  }
  const dataSources = [...mailbox.dataSources.values()].map((change) => ({
    id: C.SpaceDataSourceId.make(change.id),
    databaseId: C.SpaceDatabaseId.make(change.databaseId),
    schemaRevision: change.schemaRevision,
    dataRevision: change.dataRevision,
  }));
  const databases = [...mailbox.databases].map(([id, revision]) => ({
    id: C.SpaceDatabaseId.make(id),
    revision,
  }));
  mailbox.dataSources.clear();
  mailbox.databases.clear();
  const sourceChunks = chunks(dataSources);
  const databaseChunks = chunks(databases);
  const count = Math.max(sourceChunks.length, databaseChunks.length);
  return Array.from({ length: count }, (_, index) => ({
    type: "changed" as const,
    dataSources: sourceChunks[index] ?? [],
    databases: databaseChunks[index] ?? [],
  }));
};

export interface ChangeHub {
  /** Never waits, so a slow subscriber cannot hold the write lock. */
  readonly publish: (batch: ChangeBatch) => Effect.Effect<void>;
  /** Emits `resync` first, then one event per batch the subscriber's mailbox collected. */
  readonly subscribe: Stream.Stream<C.SpaceDatabaseChangeEvent>;
}

export const makeHub = (): ChangeHub => {
  const mailboxes = new Set<Mailbox>();
  const publish = (batch: ChangeBatch) =>
    Effect.sync(() => {
      if (batch.dataSources.length === 0 && batch.databases.length === 0) return;
      for (const mailbox of mailboxes) {
        merge(mailbox, batch);
        Queue.offerUnsafe(mailbox.signal, undefined);
      }
    });
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const signal = yield* Queue.sliding<void>(1);
      const mailbox: Mailbox = {
        signal,
        dataSources: new Map(),
        databases: new Map(),
        overflow: false,
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => void mailboxes.add(mailbox)),
        () => Effect.sync(() => void mailboxes.delete(mailbox)),
      );
      const rest = Stream.fromEffectRepeat(
        Queue.take(signal).pipe(Effect.map(() => take(mailbox))),
      ).pipe(Stream.flatMap((events) => Stream.fromArray(events)));
      return Stream.concat(Stream.make<[C.SpaceDatabaseChangeEvent]>({ type: "resync" }), rest);
    }),
  );
  return { publish, subscribe };
};
