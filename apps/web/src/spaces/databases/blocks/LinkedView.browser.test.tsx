import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { FakeDatabase } from "../test/fakeDatabase";
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

async function mount(options: { live?: boolean; viewIds?: string[] } = {}) {
  const fake = new FakeDatabase({ rows: 3, quietRowWrites: true, live: options.live ?? true });
  state.fake = fake;
  const { controller } = fakeController();
  const host = testHost(controller);
  const onSetViews = vi.fn();
  await page.viewport(1400, 900);
  const screen = await render(
    <DatabaseHarness
      host={host}
      blockId="block-linked"
      initialViewIds={options.viewIds ?? []}
      onSetViews={onSetViews}
    />,
  );
  return { fake, host, screen, onSetViews };
}

describe("linked view block", () => {
  it("links to the home page and offers the six types for its first view", async () => {
    const { fake, host, screen, onSetViews } = await mount();
    await using _screen = screen;
    await expect.element(page.getByText("Add a view")).toBeVisible();
    // No database title input: it is edited on the home page.
    await expect
      .element(page.getByRole("textbox", { name: "Database title" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Tasks" }));
    expect(host.openPage).toHaveBeenCalledWith({
      environmentId: "environment-1",
      spaceId: "space-1",
      pageId: "page-1",
    });
    for (const type of ["Table", "Board", "List", "Gallery", "Calendar", "Timeline"])
      await expect.element(page.getByRole("button", { name: type, exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Table", exact: true }));
    await vi.waitFor(() => expect(fake.callsOf("createView")).toHaveLength(1));
    expect(fake.callsOf("createView")[0]!.input).toMatchObject({
      dataSourceId: "data-source-1",
      type: "table",
    });
    await vi.waitFor(() => expect(onSetViews).toHaveBeenCalledTimes(1));
    // The tabs are this block's views only: the home block's two views are not listed.
    await expect.element(page.getByRole("tab", { name: "Table" })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "Board" })).not.toBeInTheDocument();
  });

  it("edits its own view's sort without touching the home views", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Table", exact: true }));
    await vi.waitFor(() => expect(page.getByRole("grid").elements()).toHaveLength(1));
    await userEvent.click(page.getByRole("columnheader", { name: /Status/ }).getByRole("button"));
    await userEvent.click(page.getByRole("menuitem", { name: "Sort descending" }));
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    const edited = fake.callsOf("updateView")[0]!.input.viewId;
    expect(edited).toMatch(/^view-new-/);
    expect(fake.views.find((view) => view.id === "view-table")!.sorts).toEqual([]);
    expect(fake.views.find((view) => view.id === edited)!.sorts).toEqual([
      { property: "status", direction: "descending" },
    ]);
  });

  it("says the original database was deleted and shows no controls", async () => {
    const { screen } = await mount({ live: false });
    await using _screen = screen;
    await expect.element(page.getByText(/The original database was deleted/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Table", exact: true }))
      .not.toBeInTheDocument();
  });
});
