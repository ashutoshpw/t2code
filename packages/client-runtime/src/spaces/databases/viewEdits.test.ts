import type { SpaceDatabaseView } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import {
  ackViewEdit,
  applyViewPatch,
  dropViewEdit,
  effectiveView,
  queueViewEdit,
  type ViewEdit,
} from "./viewEdits.ts";

const base = {
  id: "v1",
  databaseId: "d",
  dataSourceId: "s",
  name: "Table",
  type: "table",
  position: 0,
  filter: { property: "a", operator: "equals", value: 1 },
  group: { property: "b" },
  sorts: [],
  properties: [
    { propertyId: "a", visible: true, width: 100 },
    { propertyId: "b", visible: false },
  ],
  layout: {},
} as unknown as SpaceDatabaseView;
const edit = (id: number, patch: ViewEdit["patch"], ack?: number): ViewEdit => ({
  id,
  viewId: base.id,
  patch,
  ack,
});

describe("applyViewPatch", () => {
  it("replaces fields and removes with null", () => {
    const next = applyViewPatch(base, { name: "Board", filter: null, group: null, sorts: [] });
    expect(next.name).toBe("Board");
    expect("filter" in next).toBe(false);
    expect("group" in next).toBe(false);
    expect(base.filter).toBeDefined();
  });
  it("merges property settings, appends missing ids and removes on null", () => {
    const next = applyViewPatch(base, {
      properties: {
        set: { a: { width: null, aggregate: "count" }, c: { visible: true }, b: null },
      },
    });
    expect(next.properties).toEqual([
      { propertyId: "a", visible: true, aggregate: "count" },
      { propertyId: "c", visible: true },
    ]);
  });
  it("reorders with unlisted ids following and unknown ids hidden", () => {
    const next = applyViewPatch(base, { properties: { order: ["z", "b"] as never } });
    expect(next.properties.map((entry) => [entry.propertyId, entry.visible])).toEqual([
      ["z", false],
      ["b", false],
      ["a", true],
    ]);
  });
});

describe("effectiveView", () => {
  it("applies edits in id order and prunes acknowledged ones", () => {
    let edits = queueViewEdit([], edit(2, { name: "second" }));
    edits = queueViewEdit(edits, edit(1, { name: "first" }));
    expect(effectiveView(base, edits, 5).name).toBe("second");
    edits = ackViewEdit(edits, 2, 6);
    expect(effectiveView(base, edits, 5).name).toBe("second");
    expect(effectiveView(base, edits, 6).name).toBe("first");
    expect(queueViewEdit(edits, edit(3, {}), 6).map((entry) => entry.id)).toEqual([1, 3]);
    expect(dropViewEdit(edits, 1).map((entry) => entry.id)).toEqual([2]);
  });
});
