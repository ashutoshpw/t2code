import { describe, expect, it } from "vite-plus/test";
import type { SpaceDatabaseView, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import {
  canWriteGroup,
  insertionIndex,
  planCardDrop,
  planColumnMove,
  planLaneDrop,
} from "./boardDrag";

const known = (type: string, config: object = {}) =>
  ({ id: "p", type, config }) as unknown as SpaceKnownDatabaseProperty;
const status = known("status", {
  options: [
    { id: "a", name: "A", color: "gray", group: "todo" },
    { id: "b", name: "B", color: "blue", group: "in_progress" },
    { id: "c", name: "C", color: "green", group: "complete" },
  ],
  defaultOptionId: "a",
});
const unsorted = { sorts: [] } as unknown as SpaceDatabaseView;
const sorted = {
  sorts: [{ property: "x", direction: "ascending" }],
} as unknown as SpaceDatabaseView;
const option = (optionId: string) => ({ kind: "option", optionId }) as const;
const base = { cardId: "r1", value: undefined, beforeRowId: null, view: unsorted };

describe("planCardDrop", () => {
  it("writes the target option and orders the card in an unsorted view", () => {
    expect(
      planCardDrop({
        ...base,
        from: option("a"),
        to: option("b"),
        beforeRowId: "r9",
        known: status,
      }),
    ).toEqual({ cell: "b", move: { beforeRowId: "r9" } });
  });

  it("leaves the order to the sort when the view has sorts", () => {
    expect(
      planCardDrop({ ...base, view: sorted, from: option("a"), to: option("b"), known: status }),
    ).toEqual({ cell: "b" });
  });

  it("clears the cell for the empty column", () => {
    expect(
      planCardDrop({ ...base, from: option("a"), to: { kind: "empty" }, known: status }),
    ).toEqual({
      cell: null,
      move: { beforeRowId: null },
    });
  });

  it("takes the default option of a status group", () => {
    expect(
      planCardDrop({
        ...base,
        from: { kind: "status_group", group: "todo" },
        to: { kind: "status_group", group: "complete" },
        known: status,
      }),
    ).toMatchObject({ cell: "c" });
  });

  it("toggles a checkbox", () => {
    const box = known("checkbox");
    const from = { kind: "checkbox", value: false } as const;
    const to = { kind: "checkbox", value: true } as const;
    expect(planCardDrop({ ...base, from, to, known: box })).toMatchObject({ cell: true });
    expect(planCardDrop({ ...base, from: to, to: from, known: box })).toMatchObject({ cell: null });
  });

  it("replaces the source option of a multi-select and appends from the empty column", () => {
    const tags = known("multi_select", { options: [] });
    expect(
      planCardDrop({ ...base, value: ["x", "y"], from: option("x"), to: option("z"), known: tags }),
    ).toMatchObject({ cell: ["y", "z"] });
    expect(
      planCardDrop({ ...base, value: ["x", "y"], from: option("x"), to: option("y"), known: tags }),
    ).toMatchObject({ cell: ["y"] });
    expect(
      planCardDrop({
        ...base,
        value: undefined,
        from: { kind: "empty" },
        to: option("z"),
        known: tags,
      }),
    ).toMatchObject({ cell: ["z"] });
    expect(
      planCardDrop({
        ...base,
        value: ["x"],
        from: option("x"),
        to: { kind: "empty" },
        known: tags,
      }),
    ).toMatchObject({ cell: null });
  });

  it("only reorders inside the same column, and never without a position change", () => {
    expect(
      planCardDrop({
        ...base,
        from: option("a"),
        to: option("a"),
        beforeRowId: "r5",
        known: status,
      }),
    ).toEqual({ move: { beforeRowId: "r5" } });
    expect(
      planCardDrop({ ...base, view: sorted, from: option("a"), to: option("a"), known: status }),
    ).toEqual({});
    expect(
      planCardDrop({
        ...base,
        from: option("a"),
        to: option("a"),
        beforeRowId: "r1",
        known: status,
      }),
    ).toEqual({});
  });

  it("refuses groupings that cannot be written", () => {
    expect(
      planCardDrop({
        ...base,
        from: { kind: "number_range", start: 0, end: 10 },
        to: { kind: "number_range", start: 10, end: 20 },
        known: known("number"),
      }),
    ).toBeNull();
  });
});

describe("canWriteGroup", () => {
  it("is false without a property and for ranges, true for options", () => {
    expect(canWriteGroup(option("a"), null)).toBe(false);
    expect(canWriteGroup(option("a"), status)).toBe(true);
    expect(canWriteGroup({ kind: "number_range", start: 0, end: 1 }, known("number"))).toBe(false);
  });
});

describe("planColumnMove", () => {
  const keys = [{ kind: "empty" }, option("a"), option("b"), option("c")] as const;
  it("moves a column onto another and never writes the empty bucket", () => {
    expect(planColumnMove(keys, option("c"), option("a"))).toEqual([
      option("c"),
      option("a"),
      option("b"),
    ]);
    expect(planColumnMove(keys, option("a"), option("c"))).toEqual([
      option("b"),
      option("c"),
      option("a"),
    ]);
    expect(planColumnMove(keys, option("b"), { kind: "empty" })).toEqual([
      option("b"),
      option("a"),
      option("c"),
    ]);
  });
  it("is null for no change or an unknown column", () => {
    expect(planColumnMove(keys, option("a"), option("a"))).toBeNull();
    expect(planColumnMove(keys, option("zz"), option("a"))).toBeNull();
  });
});

describe("insertionIndex", () => {
  it("is the first card whose middle is below the pointer", () => {
    expect(insertionIndex([10, 50, 90], 0)).toBe(0);
    expect(insertionIndex([10, 50, 90], 60)).toBe(2);
    expect(insertionIndex([10, 50, 90], 200)).toBe(3);
    expect(insertionIndex([], 5)).toBe(0);
  });
});

describe("planLaneDrop", () => {
  it("writes the sub-group property when the card changes lane, and nothing when it stays", () => {
    expect(
      planLaneDrop({ cardId: "r1", value: "a", from: option("a"), to: option("b"), known: status }),
    ).toEqual({ cell: "b" });
    expect(
      planLaneDrop({ cardId: "r1", value: "a", from: option("a"), to: option("a"), known: status }),
    ).toBeUndefined();
    expect(
      planLaneDrop({
        cardId: "r1",
        value: "a",
        from: option("a"),
        to: { kind: "empty" },
        known: status,
      }),
    ).toEqual({ cell: null });
  });

  it("edits the list of a multi-select lane instead of replacing it", () => {
    const tags = known("multi_select", { options: [{ id: "x" }, { id: "y" }] });
    expect(
      planLaneDrop({
        cardId: "r1",
        value: ["x", "z"],
        from: option("x"),
        to: option("y"),
        known: tags,
      }),
    ).toEqual({ cell: ["z", "y"] });
  });
});
