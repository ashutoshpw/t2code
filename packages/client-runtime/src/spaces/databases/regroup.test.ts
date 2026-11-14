import { describe, expect, it } from "vite-plus/test";
import type {
  SpaceDatabaseRow,
  SpaceGroupBucket,
  SpaceKnownDatabaseProperty,
} from "@t2code/contracts/spaces";

import type { PendingCellEdits } from "./cellEdits.ts";
import { laneCell, laneKeys, orderBuckets, regroupBuckets } from "./regroup.ts";

const row = (id: string) =>
  ({ page: { id, title: id }, number: 1, cells: {} }) as unknown as SpaceDatabaseRow;
const bucket = (key: object, ids: string[], count = ids.length) =>
  ({ key, count, rows: ids.map(row), nextCursor: null }) as unknown as SpaceGroupBucket;
const edit = (pageId: string, propertyId: string, value: unknown, seq = 1): PendingCellEdits => ({
  [`${pageId}:${propertyId}`]: { dataSourceId: "ds", pageId, propertyId, value, seq } as never,
});
const status = {
  id: "status",
  type: "status",
  config: {
    options: [
      { id: "a", name: "A", color: "gray", group: "todo" },
      { id: "b", name: "B", color: "blue", group: "todo" },
      { id: "c", name: "C", color: "green", group: "complete" },
    ],
  },
} as unknown as SpaceKnownDatabaseProperty;
const tags = {
  id: "tags",
  type: "multi_select",
  config: { options: [] },
} as unknown as SpaceKnownDatabaseProperty;
const checkbox = {
  id: "done",
  type: "checkbox",
  config: {},
} as unknown as SpaceKnownDatabaseProperty;
const ids = (b: SpaceGroupBucket) => b.rows.map((entry) => entry.page.id);

describe("regroupBuckets", () => {
  const options = [
    bucket({ kind: "option", optionId: "a" }, ["r1", "r2"], 5),
    bucket({ kind: "option", optionId: "b" }, ["r3"]),
    bucket({ kind: "empty" }, []),
  ];

  it("moves a row to the bucket of its pending option and adjusts both counts", () => {
    const result = regroupBuckets(options, edit("r1", "status", "b"), status, "option");
    expect(ids(result[0]!)).toEqual(["r2"]);
    expect(result[0]!.count).toBe(4);
    expect(ids(result[1]!)).toEqual(["r3", "r1"]);
    expect(result[1]!.count).toBe(2);
  });

  it("moves to the empty bucket when the cell is cleared", () => {
    const result = regroupBuckets(options, edit("r3", "status", null), status, "option");
    expect(ids(result[2]!)).toEqual(["r3"]);
    expect(result[1]!.rows).toEqual([]);
  });

  it("returns the same array when nothing moves", () => {
    expect(regroupBuckets(options, edit("r1", "status", "a"), status, "option")).toBe(options);
    expect(regroupBuckets(options, {}, status, "option")).toBe(options);
    expect(regroupBuckets(options, edit("r1", "notes", "x"), status, "option")).toBe(options);
    expect(regroupBuckets(options, edit("r1", "status", "b"), null, undefined)).toBe(options);
  });

  it("maps a status option to its status group", () => {
    const groups = [
      bucket({ kind: "status_group", group: "todo" }, ["r1"]),
      bucket({ kind: "status_group", group: "complete" }, []),
    ];
    const result = regroupBuckets(groups, edit("r1", "status", "c"), status, "status_group");
    expect(ids(result[1]!)).toEqual(["r1"]);
    expect(regroupBuckets(groups, edit("r1", "status", "b"), status, "status_group")).toBe(groups);
  });

  it("keeps a multi-select row in every bucket its value names", () => {
    const groups = [
      bucket({ kind: "option", optionId: "x" }, ["r1"]),
      bucket({ kind: "option", optionId: "y" }, []),
      bucket({ kind: "empty" }, []),
    ];
    const result = regroupBuckets(groups, edit("r1", "tags", ["x", "y"]), tags, "option");
    expect(ids(result[0]!)).toEqual(["r1"]);
    expect(ids(result[1]!)).toEqual(["r1"]);
    const cleared = regroupBuckets(groups, edit("r1", "tags", []), tags, "option");
    expect(ids(cleared[2]!)).toEqual(["r1"]);
    expect(cleared[0]!.rows).toEqual([]);
  });

  it("toggles a checkbox between its two buckets", () => {
    const groups = [
      bucket({ kind: "checkbox", value: false }, ["r1"]),
      bucket({ kind: "checkbox", value: true }, []),
    ];
    const result = regroupBuckets(groups, edit("r1", "done", true), checkbox, "checkbox");
    expect(ids(result[1]!)).toEqual(["r1"]);
    expect(result[0]!.count).toBe(0);
  });

  it("applies a placement inside a bucket, including without a cell edit", () => {
    const groups = [bucket({ kind: "option", optionId: "a" }, ["r1", "r2", "r3"])];
    const first = regroupBuckets(groups, {}, status, "option", {
      r3: { group: { kind: "option", optionId: "a" }, beforeRowId: "r1" },
    });
    expect(ids(first[0]!)).toEqual(["r3", "r1", "r2"]);
    const last = regroupBuckets(groups, {}, status, "option", {
      r1: { group: { kind: "option", optionId: "a" }, beforeRowId: null },
    });
    expect(ids(last[0]!)).toEqual(["r2", "r3", "r1"]);
    const inPlace = regroupBuckets(groups, {}, status, "option", {
      r1: { group: { kind: "option", optionId: "a" }, beforeRowId: "r2" },
    });
    expect(inPlace[0]!.rows).toEqual(groups[0]!.rows);
  });

  it("places a moved row before a card of the target bucket", () => {
    const result = regroupBuckets(options, edit("r1", "status", "b"), status, "option", {
      r1: { group: { kind: "option", optionId: "b" }, beforeRowId: "r3" },
    });
    expect(ids(result[1]!)).toEqual(["r1", "r3"]);
  });
});

describe("orderBuckets", () => {
  const a = bucket({ kind: "option", optionId: "a" }, ["r1"]);
  const b = bucket({ kind: "option", optionId: "b" }, ["r2"]);
  const c = bucket({ kind: "option", optionId: "c" }, []);
  const none = bucket({ kind: "empty" }, []);

  it("keeps the server order and puts the empty bucket first", () => {
    expect(orderBuckets([a, b, c, none], undefined).shown).toEqual([none, a, b, c]);
  });

  it("applies the manual order and sends unlisted groups last", () => {
    const result = orderBuckets([a, b, c, none], {
      sort: "manual",
      order: [
        { kind: "option", optionId: "c" },
        { kind: "option", optionId: "a" },
      ],
    });
    expect(result.shown).toEqual([none, c, a, b]);
  });

  it("ignores the order unless the sort is manual", () => {
    expect(orderBuckets([a, b], { order: [{ kind: "option", optionId: "b" }] }).shown).toEqual([
      a,
      b,
    ]);
  });

  it("lists hidden groups apart and drops empty ones with hideEmpty", () => {
    const result = orderBuckets([a, b, c, none], {
      hidden: [{ kind: "option", optionId: "b" }],
      hideEmpty: true,
    });
    expect(result.shown).toEqual([a]);
    expect(result.hidden).toEqual([b]);
  });

  it("keeps the empty bucket with hideEmpty when it has cards", () => {
    const filled = bucket({ kind: "empty" }, ["r9"]);
    expect(orderBuckets([a, filled], { hideEmpty: true }).shown).toEqual([filled, a]);
  });
});

describe("laneKeys and laneCell", () => {
  const sub = (key: object, count: number) =>
    ({ key, count, rows: [], nextCursor: null }) as unknown as SpaceGroupBucket;
  const columns = [
    {
      ...bucket({ kind: "option", optionId: "a" }, []),
      subGroups: [sub({ kind: "empty" }, 1), sub({ kind: "option", optionId: "x" }, 2)],
    },
    {
      ...bucket({ kind: "option", optionId: "b" }, []),
      subGroups: [
        sub({ kind: "option", optionId: "y" }, 1),
        sub({ kind: "option", optionId: "x" }, 3),
      ],
    },
  ] as SpaceGroupBucket[];
  it("takes the union of lanes, honours manual order, and finds a column's cell", () => {
    expect(laneKeys(columns).map((key) => (key as { optionId?: string }).optionId)).toEqual([
      undefined,
      "x",
      "y",
    ]);
    expect(
      laneKeys(columns, {
        sort: "manual",
        order: [
          { kind: "option", optionId: "y" },
          { kind: "option", optionId: "x" },
        ],
      } as never).map((key) => (key as { optionId?: string }).optionId),
    ).toEqual([undefined, "y", "x"]);
    expect(laneCell(columns[0]!, { kind: "option", optionId: "x" })?.count).toBe(2);
    expect(laneCell(columns[0]!, { kind: "option", optionId: "y" })).toBeUndefined();
  });
});
