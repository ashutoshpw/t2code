import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { fixtureView, subItemRows, withSubItems } from "../test/fixtures";
import { mountRows } from "./listHarness";

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

async function mount(
  options: ConstructorParameters<typeof FakeDatabase>[0] = { rows: 6 },
  patch: Record<string, unknown> = {},
) {
  const view = { ...fixtureView("view-list", "list", "List", 0), ...patch } as never;
  const fake = new FakeDatabase({ quietRowWrites: true, ...options, views: [view] });
  state.fake = fake;
  await page.viewport(1400, 900);
  const mounted = await readyWhen(
    await mountRows(view, options.permissions?.rows !== false),
    (rows) => vi.waitFor(() => expect(rows.scroller()).toBeTruthy()),
  );
  return { fake, ...mounted };
}
const inList = (root: HTMLElement) => page.elementLocator(root);
const rowIds = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>("[data-row-id]")].map((row) => row.dataset.rowId!);

describe("rows", () => {
  it("renders a line per row with its visible properties and names", async () => {
    const { screen, scroller } = await mount();
    await using _screen = screen;
    await vi.waitFor(() => expect(rowIds(scroller())).toHaveLength(6));
    const first = scroller().querySelector<HTMLElement>('[data-row-id="row-1"]')!;
    expect(first.textContent).toContain("Task 1");
    expect(first.textContent).toContain("Status");
    expect(first.textContent).toContain("Not started");
    // Empty properties leave no entry.
    expect(first.textContent).not.toContain("Notes");
  });

  it("drops the property names when the layout turns them off", async () => {
    const { screen, scroller } = await mount({ rows: 2 }, { layout: { showPropertyNames: false } });
    await using _screen = screen;
    await vi.waitFor(() => expect(rowIds(scroller())).toHaveLength(2));
    const first = scroller().querySelector<HTMLElement>('[data-row-id="row-1"]')!;
    expect(first.textContent).toContain("Not started");
    expect(first.textContent).not.toContain("Status");
  });

  it("opens the page on click and on Enter", async () => {
    const { screen, host, scroller } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: /^Task 2\b/ }));
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-2" }));
    scroller().querySelector<HTMLElement>('[data-row-id="row-3"] button')!.focus();
    await userEvent.keyboard("{Enter}");
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-3" }));
  });

  it("moves focus between rows with the arrow keys", async () => {
    const { screen, scroller } = await mount();
    await using _screen = screen;
    await vi.waitFor(() => expect(rowIds(scroller())).toHaveLength(6));
    scroller().querySelector<HTMLElement>('[data-row-id="row-1"] button')!.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id")).toBe(
      "row-3",
    );
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id")).toBe(
      "row-2",
    );
  });
});

describe("windowing", () => {
  it("mounts only a window of 500 rows and loads the next page near the end", async () => {
    const { fake, screen, scroller } = await mount({ rows: 500 });
    await using _screen = screen;
    await vi.waitFor(() => expect(rowIds(scroller()).length).toBeGreaterThan(5));
    expect(rowIds(scroller()).length).toBeLessThan(60);
    expect(fake.callsOf("query")).toHaveLength(1);
    scroller().scrollTop = scroller().scrollHeight;
    await vi.waitFor(() => expect(fake.callsOf("query").length).toBeGreaterThan(1));
    expect(fake.callsOf("query").at(-1)!.input).toMatchObject({ cursor: "100" });
    await vi.waitFor(() => expect(rowIds(scroller())).toContain("row-100"));
  });
});

describe("groups", () => {
  const grouped = { group: { property: "status" } };

  it("renders a header per bucket and collapses one", async () => {
    const { screen, scroller } = await mount({ rows: 6 }, grouped);
    await using _screen = screen;
    await expect.element(screen.getByRole("button", { name: "Collapse Done" })).toBeVisible();
    expect(rowIds(scroller())).toHaveLength(6);
    await userEvent.click(screen.getByRole("button", { name: "Collapse Done" }));
    await vi.waitFor(() =>
      expect(rowIds(scroller())).toEqual(["row-1", "row-4", "row-2", "row-5"]),
    );
    await expect.element(screen.getByRole("button", { name: "Expand Done" })).toBeVisible();
  });

  it("adds a row to a group with the group's value and opens it", async () => {
    const { fake, screen, host, scroller } = await mount({ rows: 3 }, grouped);
    await using _screen = screen;
    const adds = inList(scroller()).getByRole("button", { name: "New" });
    await vi.waitFor(() => expect(adds.all().length).toBe(4));
    await userEvent.click(adds.nth(2));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    expect(fake.callsOf("createRows")[0]!.input.rows).toEqual([{ cells: { status: "done" } }]);
    await vi.waitFor(() =>
      expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-new-1" })),
    );
  });
});

describe("add row", () => {
  it("adds a row at the end and opens it", async () => {
    const { fake, screen, host, scroller } = await mount({ rows: 2 });
    await using _screen = screen;
    await userEvent.click(inList(scroller()).getByRole("button", { name: "New" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    await vi.waitFor(() =>
      expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-new-1" })),
    );
  });
});

describe("row menu", () => {
  it("moves a row up and down by swapping with its neighbour", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Row actions for Task 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    await vi.waitFor(() => expect(fake.callsOf("moveRows")).toHaveLength(1));
    expect(fake.callsOf("moveRows")[0]!.input).toMatchObject({
      pageIds: ["row-2"],
      beforeRowId: "row-1",
    });
    await userEvent.click(screen.getByRole("button", { name: "Row actions for Task 2" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
    await vi.waitFor(() => expect(fake.callsOf("moveRows")).toHaveLength(2));
    expect(fake.callsOf("moveRows")[1]!.input).toMatchObject({
      pageIds: ["row-3"],
      beforeRowId: "row-2",
    });
  });

  it("disables moving when the view is sorted", async () => {
    const { screen } = await mount(
      { rows: 4 },
      { sorts: [{ property: "title", direction: "ascending" }] },
    );
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Row actions for Task 2" }));
    await expect
      .element(screen.getByRole("menuitem", { name: "Move up" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect
      .element(screen.getByRole("menuitem", { name: "Move down" }))
      .toHaveAttribute("aria-disabled", "true");
  });
});

describe("read-only", () => {
  it("shows rows and opens them but offers no add, move or delete", async () => {
    const { screen, host, scroller } = await mount({
      rows: 3,
      permissions: { rows: false, cells: false },
    });
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: /^Task 1\b/ }));
    expect(host.openPage).toHaveBeenCalled();
    await expect
      .element(inList(scroller()).getByRole("button", { name: "New" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Row actions for Task 2" }));
    await expect
      .element(screen.getByRole("menuitem", { name: "Move up" }))
      .toHaveAttribute("aria-disabled", "true");
    await expect.element(screen.getByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });
});

describe("sub-items in a list", () => {
  it("nests children under an expanded parent and creates a sub-item for it", async () => {
    const { fake, screen, scroller } = await mount({
      dataSource: withSubItems(),
      rowData: subItemRows(),
    });
    await using _screen = screen;
    await vi.waitFor(() => expect(rowIds(scroller())).toEqual(["row-1", "row-2", "row-3"]));
    await userEvent.click(page.getByRole("button", { name: "Expand sub-items" }));
    await vi.waitFor(() =>
      expect(rowIds(scroller())).toEqual(["row-1", "row-4", "row-5", "row-2", "row-3"]),
    );
    const child = scroller().querySelector<HTMLElement>('[data-row-id="row-4"]')!;
    const parent = scroller().querySelector<HTMLElement>('[data-row-id="row-1"]')!;
    expect(parseFloat(child.style.paddingInlineStart)).toBeGreaterThan(
      parseFloat(parent.style.paddingInlineStart),
    );
    await userEvent.click(page.getByRole("button", { name: "New sub-item" }));
    await vi.waitFor(() =>
      expect(fake.callsOf("createRows")[0]?.input.rows).toEqual([{ cells: { parent: ["row-1"] } }]),
    );
  });
});
