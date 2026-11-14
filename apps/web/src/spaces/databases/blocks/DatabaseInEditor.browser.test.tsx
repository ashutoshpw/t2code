import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { SpaceBlockId, SpacePageId, type SpaceBlock } from "@t2code/contracts/spaces";
import { EnvironmentId } from "@t2code/contracts";
import { AtomRegistry } from "effect/reactivity";

import { render } from "../../../../test/render";
import { SpaceEditorAdapter } from "../../adapter";
import { SpaceEditor } from "../../SpaceEditor";
import { FakeDatabase } from "../test/fakeDatabase";
import { fakeController, testHost, TestHostProvider } from "../test/harness";
import { createDatabaseBlock } from "./createDatabase";

const state = vi.hoisted(() => ({ fake: null as unknown }));

vi.mock(import("../data/ports"), async () => {
  const { fakePortsModule } = await import("../test/fakeDatabase");
  return fakePortsModule(() => state.fake as never) as never;
});
vi.mock(import("../../../state/environments"), async (original) => {
  const { environmentWith } = await import("../test/environment");
  return { ...(await original()), useEnvironment: (() => environmentWith(true)) as never };
});
vi.mock(import("../../../state/spaces"), async (original) => ({
  ...(await original()),
  useSpacesAvailability: () => "writable",
}));

const paragraph = (id: string, text: string, order: string): SpaceBlock => ({
  id: SpaceBlockId.make(id),
  parentId: null,
  order,
  type: "paragraph",
  version: 1,
  content: { runs: [{ text, marks: [] }] },
});
// The fixture's home block is `block-1`; any other block of the same database is a linked view.
const database: SpaceBlock = {
  id: SpaceBlockId.make("block-1"),
  parentId: null,
  order: "b",
  type: "database",
  version: 1,
  content: { databaseId: "database-1", viewIds: ["view-table"] },
};
const linkedDatabase: SpaceBlock = { ...database, id: SpaceBlockId.make("linked-block") };

function adapterFor(blocks: SpaceBlock[]) {
  let sequence = 0;
  return new SpaceEditorAdapter({
    target: {
      environmentId: EnvironmentId.make("environment-1"),
      pageId: SpacePageId.make("page-1"),
    },
    window: { revision: 0, completeParents: [null], blocks },
    maxBlocks: 50,
    maxDepth: 8,
    maxTextLength: 10000,
    maxClipboardBytes: 20000,
    allocateId: () => SpaceBlockId.make(`new-${++sequence}`),
    allocateOrder: ({ before }) => `${before ?? ""}~${++sequence}`,
  });
}

describe("database block in the page editor", () => {
  it("inserts a database from the slash menu and renders it", async () => {
    state.fake = new FakeDatabase();
    const adapter = adapterFor([]);
    const onBatch = vi.fn();
    const { controller } = fakeController();
    const onCreateDatabase = vi.fn((place: (content: never) => boolean) =>
      place({ databaseId: "database-1", viewIds: ["view-table"] } as never),
    );
    await using screen = await render(
      <TestHostProvider host={testHost(controller, adapter)}>
        <SpaceEditor adapter={adapter} onBatch={onBatch} onCreateDatabase={onCreateDatabase} />
      </TestHostProvider>,
      { router: false },
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("/");
    await expect.element(screen.getByRole("option", { name: "Database" })).toBeVisible();
    await userEvent.keyboard("datab{Enter}");
    await expect.element(screen.getByRole("tablist", { name: "Database views" })).toBeVisible();
    expect(onCreateDatabase).toHaveBeenCalledOnce();
    const batch = JSON.stringify(onBatch.mock.calls.at(-1)?.[0]);
    expect(batch).toContain('"type":"database"');
    expect(batch).toContain("view-table");
  });

  it("offers no Database entry without the host's create handler", async () => {
    state.fake = new FakeDatabase();
    const adapter = adapterFor([]);
    const { controller } = fakeController();
    await using screen = await render(
      <TestHostProvider host={testHost(controller, adapter)}>
        <SpaceEditor adapter={adapter} />
      </TestHostProvider>,
      { router: false },
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("/");
    await expect.element(screen.getByRole("option", { name: "Heading 1" })).toBeVisible();
    await expect.element(screen.getByRole("option", { name: "Database" })).not.toBeInTheDocument();
  });

  it("asks the host for a linked view from the slash menu", async () => {
    state.fake = new FakeDatabase();
    const adapter = adapterFor([]);
    const { controller } = fakeController();
    const onCreateDatabase = vi.fn();
    await using screen = await render(
      <TestHostProvider host={testHost(controller, adapter)}>
        <SpaceEditor adapter={adapter} onCreateDatabase={onCreateDatabase} />
      </TestHostProvider>,
      { router: false },
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("/linked");
    await expect
      .element(screen.getByRole("option", { name: "Linked view of database" }))
      .toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(onCreateDatabase).toHaveBeenCalledWith(expect.any(Function), "linked");
  });

  it("keeps keys typed inside the block away from the surrounding document", async () => {
    state.fake = new FakeDatabase();
    const adapter = adapterFor([
      paragraph("before", "Before", "a"),
      database,
      paragraph("after", "After", "c"),
    ]);
    const onBatch = vi.fn();
    const { controller } = fakeController();
    await using screen = await render(
      <TestHostProvider host={testHost(controller, adapter)}>
        <SpaceEditor adapter={adapter} onBatch={onBatch} />
      </TestHostProvider>,
      { router: false },
    );
    const title = screen.getByRole("textbox", { name: "Database title" });
    await userEvent.click(title);
    await userEvent.keyboard("abc{Backspace}{Enter}");
    await userEvent.keyboard("{Control>}z{/Control}{Control>}a{/Control}{Control>}b{/Control}");
    expect(onBatch).not.toHaveBeenCalled();
    await expect.element(screen.getByText("Before")).toBeVisible();
    await expect.element(screen.getByText("After")).toBeVisible();
  });
});

describe("database block handle menu", () => {
  async function openMenu(item: string, block: SpaceBlock = database) {
    // The handle sits in the gutter left of the column, so the editor needs room on both sides.
    await page.viewport(1200, 800);
    state.fake = new FakeDatabase();
    const adapter = adapterFor([
      paragraph("before", "Before", "a"),
      block,
      paragraph("after", "After", "c"),
    ]);
    const onBatch = vi.fn();
    const { controller } = fakeController();
    const screen = await render(
      <div className="px-16">
        <TestHostProvider host={testHost(controller, adapter)}>
          <SpaceEditor adapter={adapter} onBatch={onBatch} />
        </TestHostProvider>
      </div>,
      { router: false },
    );
    await userEvent.hover(screen.getByRole("tablist", { name: "Database views" }));
    await userEvent.click(screen.getByRole("button", { name: "Block menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: item }));
    return { screen, onBatch };
  }

  it("keeps the delete confirmation open after the menu closes and deletes on confirm", async () => {
    const { screen, onBatch } = await openMenu("Delete database");
    await using _screen = screen;
    await expect.element(screen.getByText("Delete this database?")).toBeVisible();
    expect(onBatch).not.toHaveBeenCalled();
    // A native click: Base UI's inert layer swallows synthesized pointer events over the dialog.
    await vi.waitFor(() =>
      (screen.getByRole("button", { name: "Delete database" }).element() as HTMLElement).click(),
    );
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalled());
    expect(JSON.stringify(onBatch.mock.calls.at(-1)?.[0])).not.toContain('"type":"database"');
  });

  it("leaves the block alone on cancel", async () => {
    const { screen, onBatch } = await openMenu("Delete database");
    await using _screen = screen;
    await vi.waitFor(() =>
      (screen.getByRole("button", { name: "Cancel" }).element() as HTMLElement).click(),
    );
    await expect.element(screen.getByText("Delete this database?")).not.toBeInTheDocument();
    expect(onBatch).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("tablist", { name: "Database views" })).toBeVisible();
  });

  it("deletes a linked view without confirmation and keeps the database", async () => {
    const { screen, onBatch } = await openMenu("Delete linked view", linkedDatabase);
    await using _screen = screen;
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalled());
    expect(screen.getByText("Delete this database?").query()).toBeNull();
    expect(JSON.stringify(onBatch.mock.calls.at(-1)?.[0])).not.toContain('"type":"database"');
  });

  it("moves the block up", async () => {
    const { screen, onBatch } = await openMenu("Move up");
    await using _screen = screen;
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalled());
  });

  it("moves the block down", async () => {
    const { screen, onBatch } = await openMenu("Move down");
    await using _screen = screen;
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalled());
  });
});

describe("createDatabaseBlock", () => {
  it("creates the database, places its block and saves the page", async () => {
    const fake = new FakeDatabase();
    state.fake = fake;
    const { controller, save } = fakeController();
    const place = vi.fn(() => true);
    await createDatabaseBlock({ registry: AtomRegistry.make(), controller, place });
    expect(fake.callsOf("create")[0]?.input).toMatchObject({ spaceId: "space-1", title: "" });
    expect(place).toHaveBeenCalledWith({ databaseId: "database-1", viewIds: ["view-table"] });
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not save when the block could not be placed", async () => {
    state.fake = new FakeDatabase();
    const { controller, save } = fakeController();
    await createDatabaseBlock({ registry: AtomRegistry.make(), controller, place: () => false });
    expect(save).not.toHaveBeenCalled();
  });
});
