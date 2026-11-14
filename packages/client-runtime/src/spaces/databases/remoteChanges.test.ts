import { SpaceDatabaseId, SpaceDataSourceId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_REMOTE_CHANGES,
  MAX_REMOTE_IDS,
  foldRemote,
  makeKnownRevisions,
  markApplied,
  noteDatabaseRevision,
  noteDataSourceRevisions,
  pendingBumps,
} from "./remoteChanges.ts";

const database = SpaceDatabaseId.make("db");
const source = (id: string, dataRevision: number, schemaRevision = 0) => ({
  id: SpaceDataSourceId.make(id),
  databaseId: database,
  schemaRevision,
  dataRevision,
});

describe("remote changes", () => {
  it("keeps the newest revision per id and counts resyncs", () => {
    let state = foldRemote(EMPTY_REMOTE_CHANGES, {
      type: "changed",
      dataSources: [source("a", 3, 1)],
      databases: [{ id: database, revision: 2 }],
    });
    state = foldRemote(state, {
      type: "changed",
      dataSources: [source("a", 2, 2)],
      databases: [{ id: database, revision: 1 }],
    });
    expect(state.dataSources.get(SpaceDataSourceId.make("a"))).toMatchObject({
      dataRevision: 3,
      schemaRevision: 2,
    });
    expect(state.databases.get(database)).toBe(2);
    expect(foldRemote(state, { type: "resync" })).toMatchObject({ resyncs: 1 });
    expect(foldRemote(state, { type: "resync" }).dataSources.size).toBe(0);
  });

  it("forgets everything and counts a resync past the id cap", () => {
    const dataSources = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => source(`s${from + i}`, 1));
    const full = foldRemote(EMPTY_REMOTE_CHANGES, {
      type: "changed",
      dataSources: dataSources(0, MAX_REMOTE_IDS),
      databases: [],
    });
    expect(full).toMatchObject({ resyncs: 0 });
    const over = foldRemote(full, {
      type: "changed",
      dataSources: dataSources(MAX_REMOTE_IDS, 1),
      databases: [],
    });
    expect(over.resyncs).toBe(1);
    expect(over.dataSources.size).toBe(0);
  });

  it("reports only what is newer than what this client knows", () => {
    const known = makeKnownRevisions();
    for (const id of ["own", "dataonly", "schema"])
      noteDataSourceRevisions(known, id, { schemaRevision: 1, dataRevision: 4 });
    noteDatabaseRevision(known, "db", 5);
    const state = foldRemote(EMPTY_REMOTE_CHANGES, {
      type: "changed",
      dataSources: [
        source("own", 4, 1),
        source("dataonly", 5, 1),
        source("schema", 4, 2),
        source("unseen", 1),
      ],
      databases: [{ id: database, revision: 6 }],
    });
    const bumps = pendingBumps(state, known);
    expect(bumps.dataSources.map(({ id, schema }) => [id, schema])).toEqual([
      ["dataonly", false],
      ["schema", true],
      ["unseen", true],
    ]);
    expect(bumps.databases).toEqual([database]);
    expect(bumps.list).toBe(true);
    markApplied(state, known);
    expect(pendingBumps(state, known)).toEqual({ dataSources: [], databases: [], list: false });
  });
});
