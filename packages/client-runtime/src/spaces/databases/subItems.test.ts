import type {
  SpaceDatabaseQueryInput,
  SpaceDatabaseQueryResult,
  SpaceDatabaseRow,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { SubItemTree, subItemCells } from "./subItems.ts";

const tick = async () => {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
};
const row = (id: string, childCount = 0): SpaceDatabaseRow =>
  ({
    page: { id, title: id, revision: 1, createdAt: "t", updatedAt: "t" },
    number: 1,
    cells: { title: id },
    childCount,
  }) as unknown as SpaceDatabaseRow;
const base = {
  environmentId: "e",
  dataSourceId: "s",
  mode: "rows",
  filter: { property: "status", operator: "equals", value: "todo" },
  sorts: [],
  limit: 2,
  timeZone: "UTC",
} as unknown as SpaceDatabaseQueryInput;

function setup() {
  const calls: SpaceDatabaseQueryInput[] = [];
  const children: Record<string, SpaceDatabaseRow[]> = {
    a: [row("a1"), row("a2")],
    b: [row("b1")],
  };
  const tree = new SubItemTree({
    query: async (input) => {
      calls.push(input);
      const parent = input.scope?.parentRowId ?? "";
      return {
        dataSourceId: "s",
        schemaRevision: 1,
        dataRevision: 1,
        rows: children[parent] ?? [],
        relatedPages: {},
        nextCursor: null,
      } as unknown as SpaceDatabaseQueryResult;
    },
    schedule: () => () => {},
    busy: () => false,
  });
  return { tree, calls };
}

describe("SubItemTree", () => {
  it("queries each expanded parent with the view's filter and the parent scope", async () => {
    const { tree, calls } = setup();
    tree.setBase({ ...base, scope: { parentRowId: null } });
    tree.expand("a" as never);
    tree.expand("b" as never);
    await tick();
    expect(calls.map((call) => call.scope)).toEqual([{ parentRowId: "a" }, { parentRowId: "b" }]);
    expect(calls.every((call) => call.filter === base.filter)).toBe(true);
    const snapshot = tree.getSnapshot().children;
    expect(snapshot.get("a")?.rows.map((entry) => entry.page.id)).toEqual(["a1", "a2"]);
    expect(snapshot.get("b")?.status).toBe("ready");
  });

  it("drops a collapsed parent's rows and notifies subscribers", async () => {
    const { tree } = setup();
    tree.setBase(base);
    let notified = 0;
    tree.subscribe(() => notified++);
    tree.expand("a" as never);
    await tick();
    tree.collapse("a" as never);
    expect(tree.getSnapshot().children.size).toBe(0);
    expect(tree.isExpanded("a")).toBe(false);
    expect(notified).toBeGreaterThan(1);
  });

  it("re-points expanded parents when the base query changes, and routes acks to all", async () => {
    const { tree, calls } = setup();
    tree.setBase(base);
    tree.expand("a" as never);
    await tick();
    calls.length = 0;
    tree.setBase({ ...base, filter: null });
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.filter).toBeNull();
    const before = tree.getSnapshot();
    tree.noteAck({ dataRevision: 2, affects: false, structural: false });
    expect(tree.getSnapshot()).toBe(before);
  });

  it("ignores everything after dispose", async () => {
    const { tree, calls } = setup();
    tree.setBase(base);
    tree.dispose();
    tree.expand("a" as never);
    await tick();
    expect(calls).toHaveLength(0);
  });

  it("stays usable after reset, as when StrictMode re-runs effect cleanups", async () => {
    const { tree, calls } = setup();
    tree.setBase(base);
    tree.expand("a" as never);
    tree.reset();
    expect(tree.isExpanded("a")).toBe(false);
    tree.setBase(base);
    tree.expand("a" as never);
    await tick();
    expect(tree.isExpanded("a")).toBe(true);
    expect(calls.at(-1)?.scope?.parentRowId).toBe("a");
  });

  it("seeds a new sub-item with its parent", () => {
    expect(subItemCells("parent", "p1" as never)).toEqual({ parent: ["p1"] });
  });
});
