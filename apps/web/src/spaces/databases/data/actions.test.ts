import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDatabaseActions, type ActionsState } from "./actions";

const ports = vi.hoisted(() => ({
  createView: vi.fn(async (_registry: unknown, _environmentId: unknown, input: unknown) => ({
    viewId: "view-new",
    input,
  })),
  updateView: vi.fn(async () => ({ revision: 2 })),
}));
vi.mock(import("./ports"), () => ({
  databasePorts: {
    run: { createView: ports.createView, updateView: ports.updateView },
    changed: {},
  } as never,
}));
vi.mock(import("../../../components/ui/toast"), () => ({
  toastManager: { add: vi.fn() } as never,
}));

const property = (id: string, type: string, position: number) => ({
  id,
  name: id,
  type,
  config: {},
  position,
});
const source = (id: string, types: ReadonlyArray<string>) => ({
  id,
  properties: Object.fromEntries(
    types.map((type, index) => [`${id}-${type}`, property(`${id}-${type}`, type, index)]),
  ),
});
const sourceA = source("ds-a", ["title", "date"]);
const sourceB = source("ds-b", ["title", "date"]);
const view = (id: string, dataSourceId: string, type = "table") => ({
  id,
  databaseId: "db",
  dataSourceId,
  name: id,
  type,
  position: 0,
  sorts: [],
  properties: [],
  layout: {},
});

/** A two-source database whose active view reads source A while the acted-on view reads B. */
function setup() {
  const views = [view("view-a", "ds-a"), view("view-b", "ds-b")];
  const state = {
    model: {
      environmentId: "env",
      database: { id: "db", revision: 1 },
      dataSources: [sourceA, sourceB],
      views,
    },
    dataSource: sourceA,
    view: views[0],
    viewIds: ["view-a", "view-b"],
    block: { setViews: () => true, remove: () => true },
    host: null,
    peek: null,
  } as unknown as ActionsState;
  const edits: unknown[] = [];
  const actions = createDatabaseActions({
    registry: AtomRegistry.make(),
    state: () => state,
    queueViewEdit: (_viewId, patch) => {
      edits.push(patch);
      return edits.length;
    },
    ackViewEdit: () => {},
    dropViewEdit: () => {},
    activate: () => {},
  });
  return { actions, edits };
}

describe("views of a multi-source database", () => {
  it("creates a view over the active view's data source unless one is named", async () => {
    const { actions } = setup();
    await actions.createView("table");
    await actions.createView("table", "ds-b" as never);
    expect(
      ports.createView.mock.calls.map((call) => (call[2] as { dataSourceId: string }).dataSourceId),
    ).toEqual(["ds-a", "ds-b"]);
  });

  it("duplicates a view into the data source that view reads", async () => {
    ports.createView.mockClear();
    const { actions } = setup();
    await actions.duplicateView("view-b" as never);
    const sent = ports.createView.mock.calls.map(
      (call) => (call[2] as { dataSourceId: string }).dataSourceId,
    );
    expect(sent).toEqual(["ds-b"]);
  });

  it("derives a type change from the schema of the changed view's own data source", async () => {
    const { actions, edits } = setup();
    await actions.changeViewType("view-b" as never, "calendar");
    expect(edits).toHaveLength(1);
    expect(JSON.stringify(edits[0])).toContain("ds-b-date");
    expect(JSON.stringify(edits[0])).not.toContain("ds-a-");
  });
});
