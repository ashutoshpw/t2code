import type {
  SpaceDatabaseChangeEvent,
  SpaceDatabaseId,
  SpaceDataSourceId,
} from "@t2code/contracts/spaces";

/** Past this many remembered ids the state forgets them and asks every view to refresh once. */
export const MAX_REMOTE_IDS = 2000;

export interface RemoteDataSource {
  readonly databaseId: SpaceDatabaseId;
  readonly schemaRevision: number;
  readonly dataRevision: number;
}

/** What the change stream has announced: the newest revision per id, and how many resyncs it asked for. */
export interface RemoteChanges {
  readonly resyncs: number;
  readonly dataSources: ReadonlyMap<SpaceDataSourceId, RemoteDataSource>;
  readonly databases: ReadonlyMap<SpaceDatabaseId, number>;
}

export const EMPTY_REMOTE_CHANGES: RemoteChanges = {
  resyncs: 0,
  dataSources: new Map(),
  databases: new Map(),
};

export function foldRemote(state: RemoteChanges, event: SpaceDatabaseChangeEvent): RemoteChanges {
  if (event.type === "resync") return { ...EMPTY_REMOTE_CHANGES, resyncs: state.resyncs + 1 };
  const dataSources = new Map(state.dataSources);
  for (const source of event.dataSources) {
    const held = dataSources.get(source.id);
    dataSources.set(source.id, {
      databaseId: source.databaseId,
      schemaRevision: Math.max(held?.schemaRevision ?? 0, source.schemaRevision),
      dataRevision: Math.max(held?.dataRevision ?? 0, source.dataRevision),
    });
  }
  const databases = new Map(state.databases);
  for (const database of event.databases)
    databases.set(database.id, Math.max(databases.get(database.id) ?? 0, database.revision));
  if (dataSources.size + databases.size > MAX_REMOTE_IDS)
    return { ...EMPTY_REMOTE_CHANGES, resyncs: state.resyncs + 1 };
  return { resyncs: state.resyncs, dataSources, databases };
}

/** The newest revisions this client has seen in any answer; owned and mutated by the caller. */
export interface KnownRevisions {
  readonly dataSources: Map<string, { schemaRevision: number; dataRevision: number }>;
  readonly databases: Map<string, number>;
}

export const makeKnownRevisions = (): KnownRevisions => ({
  dataSources: new Map(),
  databases: new Map(),
});

export function noteDataSourceRevisions(
  known: KnownRevisions,
  id: string,
  revisions: { readonly schemaRevision?: number; readonly dataRevision?: number },
) {
  const held = known.dataSources.get(id);
  known.dataSources.set(id, {
    schemaRevision: Math.max(held?.schemaRevision ?? 0, revisions.schemaRevision ?? 0),
    dataRevision: Math.max(held?.dataRevision ?? 0, revisions.dataRevision ?? 0),
  });
}

export function noteDatabaseRevision(known: KnownRevisions, id: string, revision: number) {
  known.databases.set(id, Math.max(known.databases.get(id) ?? 0, revision));
}

export interface PendingBumps {
  /** Data sources whose rows changed, and whether their schema did too. */
  readonly dataSources: ReadonlyArray<{
    readonly id: SpaceDataSourceId;
    readonly databaseId: SpaceDatabaseId;
    readonly schema: boolean;
  }>;
  readonly databases: ReadonlyArray<SpaceDatabaseId>;
  /** A database is new to this client, or was edited: the list of databases is stale. */
  readonly list: boolean;
}

/**
 * What the stream announced that this client does not know yet. A revision that is not newer than
 * a known one is skipped, which is how a client ignores the echo of its own write.
 */
export function pendingBumps(state: RemoteChanges, known: KnownRevisions): PendingBumps {
  const dataSources: Array<PendingBumps["dataSources"][number]> = [];
  for (const [id, remote] of state.dataSources) {
    const held = known.dataSources.get(id);
    if (held === undefined || remote.schemaRevision > held.schemaRevision)
      dataSources.push({ id, databaseId: remote.databaseId, schema: true });
    else if (remote.dataRevision > held.dataRevision)
      dataSources.push({ id, databaseId: remote.databaseId, schema: false });
  }
  const databases: SpaceDatabaseId[] = [];
  let list = false;
  for (const [id, revision] of state.databases) {
    const held = known.databases.get(id);
    if (held === undefined || revision > held) {
      databases.push(id);
      list = true;
    }
  }
  return { dataSources, databases, list };
}

/** Marks everything `pending` named as known, so the same revisions are not applied twice. */
export function markApplied(state: RemoteChanges, known: KnownRevisions) {
  for (const [id, remote] of state.dataSources) noteDataSourceRevisions(known, id, remote);
  for (const [id, revision] of state.databases) noteDatabaseRevision(known, id, revision);
}
