import {
  SpaceCursor,
  SpaceDatabaseId,
  SpaceDataSourceId,
  SpaceId,
  type SpaceDatabase,
  type SpaceDatabaseListResult,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { findDataSourceHomes } from "./dataSourceHomes.ts";

type Page = Pick<SpaceDatabaseListResult, "items" | "nextCursor">;

const SAMPLE: SpaceDatabase = {
  id: SpaceDatabaseId.make("sample"),
  spaceId: SpaceId.make("space"),
  title: "",
  revision: 0,
  home: null,
  live: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const page = (ids: ReadonlyArray<string>, next: string | null): Page => ({
  items: ids.map((id) => ({
    database: { ...SAMPLE, id: SpaceDatabaseId.make(`db-${id}`), title: ` ${id} ` },
    dataSources: [{ id: SpaceDataSourceId.make(`ds-${id}`), name: id }],
  })),
  nextCursor: next === null ? null : SpaceCursor.make(next),
});

function pager(pages: { space: Page[]; any: Page[] }) {
  const calls: string[] = [];
  return {
    calls,
    listPage: async (cursor: SpaceCursor | undefined, anySpace: boolean) => {
      calls.push(`${anySpace ? "any" : "space"}:${cursor ?? "-"}`);
      return pages[anySpace ? "any" : "space"][cursor === undefined ? 0 : Number(cursor)]!;
    },
  };
}

describe("findDataSourceHomes", () => {
  it("finds a target only on a later page of the space list", async () => {
    const source = pager({
      space: [page(["a"], "1"), page(["b"], "2"), page(["c"], null)],
      any: [],
    });
    const found = await findDataSourceHomes({
      ids: ["ds-c"],
      first: page(["a"], "1"),
      listPage: source.listPage,
    });
    expect(found.homes.get("ds-c")).toEqual({ databaseId: "db-c", title: "c" });
    expect(found.missing).toEqual([]);
    expect(source.calls).toEqual(["space:1", "space:2"]);
  });

  it("falls back to the list of every space for a target elsewhere", async () => {
    const source = pager({ space: [], any: [page(["x"], null)] });
    const found = await findDataSourceHomes({
      ids: ["ds-x", "ds-gone"],
      first: page(["a"], null),
      listPage: source.listPage,
    });
    expect(found.homes.get("ds-x")?.databaseId).toBe("db-x");
    expect(found.missing).toEqual(["ds-gone"]);
    expect(source.calls).toEqual(["any:-"]);
  });

  it("stops paging once every target is found", async () => {
    const source = pager({ space: [], any: [] });
    const found = await findDataSourceHomes({
      ids: ["ds-a"],
      first: page(["a"], "1"),
      listPage: source.listPage,
    });
    expect(found.missing).toEqual([]);
    expect(source.calls).toEqual([]);
  });

  it("keeps the homes found before a failed read and reports the walk as incomplete", async () => {
    const found = await findDataSourceHomes({
      ids: ["ds-a", "ds-z"],
      first: page(["a"], "1"),
      listPage: async () => {
        throw new Error("offline");
      },
    });
    expect(found.homes.get("ds-a")?.databaseId).toBe("db-a");
    expect(found.missing).toEqual(["ds-z"]);
    expect(found.incomplete).toBe(true);
  });

  it("calls a walk that hit the page cap unknown, and a finished one complete", async () => {
    const endless = await findDataSourceHomes({
      ids: ["ds-z"],
      first: page(["a"], "1"),
      listPage: async (cursor) => page(["a"], String(Number(cursor ?? 0) + 1)),
    });
    expect(endless.incomplete).toBe(true);
    const source = pager({ space: [], any: [page(["x"], null)] });
    const done = await findDataSourceHomes({
      ids: ["ds-gone"],
      first: page(["a"], null),
      listPage: source.listPage,
    });
    expect(done.incomplete).toBe(false);
  });
});
