import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDatabaseActions, type ActionsState } from "./actions";

const ports = vi.hoisted(() => ({
  createView: vi.fn(async (_registry: unknown, _environmentId: unknown, input: unknown) => ({
    viewId: "view-new",
    input,
  })),
  updateView: vi.fn(async () => ({ revision: 2 })),
  deleteView: vi.fn(async (_registry: unknown, _environmentId: unknown, _input: unknown) => ({})),
  update: vi.fn(async (_registry: unknown, _environmentId: unknown, _input: unknown) => ({})),
  createDataSource: vi.fn(async (_registry: unknown, _environmentId: unknown, _input: unknown) => ({
    dataSourceId: "ds-new",
  })),
}));
vi.mock(import("./ports"), () => ({
  databasePorts: {
    run: {
      createView: ports.createView,
      updateView: ports.updateView,
      deleteView: ports.deleteView,
      update: ports.update,
      createDataSource: ports.createDataSource,
    },
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
function setup(blockOverride: object = {}) {
  const views = [view("view-a", "ds-a"), view("view-b", "ds-b")];
  const block = {
    setViews: vi.fn(() => true),
    remove: () => true,
    setTitleHidden: () => true,
    ...blockOverride,
  };
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
    block,
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
  return { actions, edits, block };
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

describe("a database on the full page", () => {
  const remote = { pageId: "page-1", blockId: "block-1" };
  const blockOf = (call: ReadonlyArray<unknown>) => (call[2] as { block?: unknown }).block;

  it("sends tab edits through the server and never edits the block", async () => {
    ports.createView.mockClear();
    ports.deleteView.mockClear();
    const { actions, block } = setup({ remote });
    await actions.createView("table");
    await actions.duplicateView("view-b" as never);
    await actions.deleteView("view-b" as never);
    actions.reorderViews(["view-b", "view-a"] as never);
    expect(ports.createView.mock.calls.map(blockOf)).toEqual([remote, remote]);
    expect(ports.deleteView.mock.calls.map(blockOf)).toEqual([remote]);
    expect(block.setViews).not.toHaveBeenCalled();
  });

  it("still edits the block when the database is inline", async () => {
    ports.createView.mockClear();
    const { actions, block } = setup();
    await actions.createView("table");
    expect(blockOf(ports.createView.mock.calls[0]!)).toBeUndefined();
    expect(block.setViews).toHaveBeenCalledWith(["view-a", "view-b", "view-new"]);
  });

  it("adds a data source with a table view on it, placing the tab locally or on the server", async () => {
    ports.createView.mockClear();
    const local = setup();
    await local.actions.createDataSource();
    expect(ports.createDataSource.mock.calls[0]![2]).toEqual({
      databaseId: "db",
      name: "Data source 3",
    });
    expect(ports.createView.mock.calls[0]![2]).toMatchObject({
      dataSourceId: "ds-new",
      type: "table",
      properties: [{ propertyId: "title", visible: true }],
    });
    expect(local.block.setViews).toHaveBeenCalledWith(["view-a", "view-b", "view-new"]);
    const onServer = setup({ remote });
    await onServer.actions.createDataSource();
    expect(blockOf(ports.createView.mock.calls[1]!)).toEqual(remote);
    expect(onServer.block.setViews).not.toHaveBeenCalled();
  });

  it("sends the icon as given, null clearing it", () => {
    ports.update.mockClear();
    const { actions } = setup();
    actions.setDatabaseIcon("🚀");
    actions.setDatabaseIcon(null);
    expect(ports.update.mock.calls.map((call) => call[2])).toEqual([
      { databaseId: "db", icon: "🚀" },
      { databaseId: "db", icon: null },
    ]);
  });
});
