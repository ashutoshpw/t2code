import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { FakeDatabase } from "../test/fakeDatabase";
import { fixtureDataSource } from "../test/fixtures";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";

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

function setup(options: ConstructorParameters<typeof FakeDatabase>[0] = {}) {
  const fake = new FakeDatabase(options);
  state.fake = fake;
  const { controller } = fakeController();
  return { fake, host: testHost(controller) };
}
const BOTH = ["view-table", "view-board"];

describe("view tabs", () => {
  it("switches the active view", async () => {
    const { host } = setup();
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={BOTH} />, {
      router: false,
    });
    await expect
      .element(screen.getByRole("tab", { name: "Table" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Board" }));
    await expect
      .element(screen.getByRole("tab", { name: "Board" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("adds a board view, appends it to the block and activates it", async () => {
    const { fake, host } = setup();
    const onSetViews = vi.fn();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={["view-table"]} onSetViews={onSetViews} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a view" }));
    await userEvent.click(page.getByRole("button", { name: "Board" }));
    await vi.waitFor(() => expect(onSetViews).toHaveBeenCalled());
    expect(fake.callsOf("createView")[0]?.input).toMatchObject({
      type: "board",
      group: { property: "status" },
    });
    const added = onSetViews.mock.calls[0]![0] as string[];
    expect(added).toHaveLength(2);
    await expect
      .element(screen.getByRole("tab", { name: "Board" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it.each([
    ["List", "list", {}],
    ["Gallery", "gallery", {}],
    ["Calendar", "calendar", { datePropertyId: "due" }],
    ["Timeline", "timeline", { startPropertyId: "due" }],
  ])("adds a %s view with the layout its type requires", async (label, type, layout) => {
    const { fake, host } = setup();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={["view-table"]} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a view" }));
    await userEvent.click(page.getByRole("button", { name: label }));
    await vi.waitFor(() => expect(fake.callsOf("createView")).toHaveLength(1));
    expect(fake.callsOf("createView")[0]?.input).toMatchObject({ type, name: label, layout });
    await expect
      .element(screen.getByRole("tab", { name: label }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("adds a Date property before it creates a calendar on a source without one", async () => {
    const base = fixtureDataSource();
    const { due: _due, ...properties } = base.properties;
    const { fake, host } = setup({ dataSource: { ...base, properties } });
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={["view-table"]} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Add a view" }));
    await userEvent.click(page.getByRole("button", { name: "Calendar" }));
    await vi.waitFor(() => expect(fake.callsOf("createView")).toHaveLength(1));
    const added = fake.callsOf("updateSchema")[0]?.input as {
      operations: { property: { id: string; name: string; type: string } }[];
    };
    expect(added.operations[0]?.property).toMatchObject({ name: "Date", type: "date" });
    expect(fake.callsOf("createView")[0]?.input).toMatchObject({
      type: "calendar",
      layout: { datePropertyId: added.operations[0]?.property.id },
    });
  });

  it("switches the type of a view and sends the layout with it", async () => {
    const { fake, host } = setup();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={["view-table"]} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "View settings" }));
    await userEvent.click(page.getByRole("button", { name: /^Layout/ }));
    await userEvent.click(page.getByRole("radio", { name: "Timeline" }));
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    expect(fake.callsOf("updateView")[0]?.input).toMatchObject({
      type: "timeline",
      layout: { startPropertyId: "due" },
    });
  });

  it("renames the active view through its menu", async () => {
    const { fake, host } = setup();
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={BOTH} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("tab", { name: "Table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Rename" }));
    await userEvent.keyboard("{Control>}a{/Control}Roadmap{Enter}");
    await expect.element(screen.getByRole("tab", { name: "Roadmap" })).toBeVisible();
    expect(fake.callsOf("updateView")[0]?.input).toMatchObject({
      viewId: "view-table",
      name: "Roadmap",
    });
  });

  it("rolls a rename back and reports it when the server refuses", async () => {
    const { fake, host } = setup();
    fake.failNext.set("updateView", { _tag: "SpaceDatabaseError", reason: "invalid_view" });
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={BOTH} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("tab", { name: "Table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Rename" }));
    await userEvent.keyboard("{Control>}a{/Control}Nope{Enter}");
    await expect.element(screen.getByRole("tab", { name: "Table" })).toBeVisible();
    await expect.element(screen.getByRole("tab", { name: "Nope" })).not.toBeInTheDocument();
  });

  it("duplicates a view next to its source", async () => {
    const { fake, host } = setup();
    const onSetViews = vi.fn();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={BOTH} onSetViews={onSetViews} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("tab", { name: "Table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Duplicate" }));
    await vi.waitFor(() => expect(onSetViews).toHaveBeenCalled());
    expect(fake.callsOf("createView")[0]?.input).toMatchObject({
      name: "Table (1)",
      type: "table",
    });
    const saved = onSetViews.mock.calls[0]![0] as string[];
    expect(saved[0]).toBe("view-table");
    expect(saved).toHaveLength(3);
  });

  it("confirms deletion, and cannot delete the last view", async () => {
    const { fake, host } = setup();
    const onSetViews = vi.fn();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={BOTH} onSetViews={onSetViews} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("tab", { name: "Table" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete view" }));
    // The dialog's inert guard sits over real pointer hits; a DOM click is what a keyboard Enter does.
    await vi.waitFor(() =>
      (page.getByRole("button", { name: "Delete view" }).element() as HTMLElement).click(),
    );
    await vi.waitFor(() => expect(onSetViews).toHaveBeenCalledWith(["view-board"]));
    expect(fake.callsOf("deleteView")).toHaveLength(1);
    await expect.element(screen.getByRole("tab", { name: "Table" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Board" }));
    await expect
      .element(page.getByRole("menuitem", { name: "Delete view" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  it("reorders with Alt+Arrow from the keyboard", async () => {
    const { host } = setup();
    const onSetViews = vi.fn();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={BOTH} onSetViews={onSetViews} />,
      { router: false },
    );
    screen.getByRole("tab", { name: "Table" }).element().focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(onSetViews).toHaveBeenCalledWith(["view-board", "view-table"]);
  });

  it("moves between tabs with the arrow keys", async () => {
    const { host } = setup();
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={BOTH} />, {
      router: false,
    });
    screen.getByRole("tab", { name: "Table" }).element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(screen.getByRole("tab", { name: "Board" })).toHaveFocus();
  });

  it("hides every management control without permission", async () => {
    const { host } = setup({ permissions: { views: false, rename: false } });
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={BOTH} />, {
      router: false,
    });
    await expect.element(screen.getByRole("tab", { name: "Table" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Add a view" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Table" }));
    await expect.element(page.getByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect
      .element(screen.getByRole("textbox", { name: "Database title" }))
      .not.toBeInTheDocument();
  });

  it("hides management when the page itself is not editable", async () => {
    const { host } = setup();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={BOTH} editable={false} />,
      { router: false },
    );
    await expect.element(screen.getByRole("tab", { name: "Table" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Add a view" }))
      .not.toBeInTheDocument();
  });

  it("shows an empty state when no view of this block exists", async () => {
    const { host } = setup();
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={["gone"]} />, {
      router: false,
    });
    await expect.element(screen.getByText("This database has no views here")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add a table view" })).toBeVisible();
  });
});
