import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { mountTable } from "./tableHarness";

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

const EXTRA = [
  { id: "site", name: "Site", type: "url", config: {} },
  { id: "files", name: "Files", type: "files", config: {} },
  {
    id: "rel",
    name: "Related",
    type: "relation",
    config: { dataSourceId: "data-source-1", limit: "many" },
  },
  { id: "made", name: "Created", type: "created_time", config: {} },
];

/** The fixture plus url, files, relation and created_time columns, all visible. */
async function mount() {
  const fake = new FakeDatabase({ quietRowWrites: true, rows: 10 });
  fake.dataSource = {
    ...fake.dataSource,
    properties: {
      ...fake.dataSource.properties,
      ...Object.fromEntries(
        EXTRA.map((property, index) => [property.id, { ...property, position: 7 + index }]),
      ),
    },
  } as never;
  fake.views = fake.views.map((view) => ({
    ...view,
    properties: [
      ...view.properties,
      ...EXTRA.map((property) => ({ propertyId: property.id, visible: true })),
    ],
  })) as never;
  state.fake = fake;
  await page.viewport(2800, 900);
  const table = await readyWhen(await mountTable(fake), (mounted) =>
    vi.waitFor(() => expect(mounted.cell("row-1", "made")).not.toBeNull()),
  );
  return { fake, ...table };
}
const locate = (element: HTMLElement | null) => page.elementLocator(element!);
const lastWrite = (fake: FakeDatabase) =>
  (
    fake.callsOf("updateRows").at(-1)?.input.rows as
      | { cells: Record<string, unknown> }[]
      | undefined
  )?.at(-1)?.cells;
const focused = () => {
  const { row, col } = (document.activeElement as HTMLElement).dataset;
  return row === undefined ? null : `${row}:${col}`;
};

describe("option editors", () => {
  it("picks a status, and Escape closes the popover and returns focus to the cell", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "status")));
    await userEvent.click(page.getByRole("option", { name: "Done" }));
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ status: "done" }));
    await expect.element(page.getByRole("listbox", { name: "Status" })).not.toBeInTheDocument();
    expect(focused()).toBe("row-1:status");

    await userEvent.click(locate(cell("row-2", "status")));
    await expect.element(page.getByRole("combobox", { name: "Search Status" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("listbox", { name: "Status" })).not.toBeInTheDocument();
    expect(focused()).toBe("row-2:status");
  });

  it("filters by the typed seed and picks with Enter", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "status")!.focus();
    await userEvent.keyboard("prog");
    await expect.element(page.getByRole("combobox", { name: "Search Status" })).toHaveValue("prog");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ status: "doing" }));
  });

  it("toggles multi-select options without closing, then creates an option", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "tags")));
    await userEvent.click(page.getByRole("option", { name: "Bug" }));
    await userEvent.click(page.getByRole("option", { name: "Idea" }));
    await expect.element(page.getByRole("listbox", { name: "Tags" })).toBeVisible();
    await userEvent.fill(page.getByRole("combobox", { name: "Search Tags" }), "Perf");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(fake.callsOf("updateSchema")).toHaveLength(1));
    expect(fake.callsOf("updateSchema")[0]!.input.operations).toMatchObject([
      { op: "addOption", propertyId: "tags", option: { name: "Perf" } },
    ]);
    const created = (
      fake.callsOf("updateSchema")[0]!.input.operations as { option: { id: string } }[]
    )[0]!.option.id;
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ tags: ["bug", "idea", created] }));
    // The new option already reads as a chip before the schema answer arrives.
    await expect.element(page.getByText("Perf").first()).toBeVisible();
  });

  it("removes the last chip with Backspace on an empty search", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "tags")));
    await userEvent.click(page.getByRole("option", { name: "Bug" }));
    await userEvent.click(page.getByRole("option", { name: "Idea" }));
    await userEvent.click(page.getByRole("combobox", { name: "Search Tags" }));
    await userEvent.keyboard("{Backspace}");
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ tags: ["bug"] }));
  });
});

describe("date editor", () => {
  it("writes a day, then a range with times in the viewer zone", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "due")));
    await userEvent.fill(page.getByRole("textbox", { name: "Start date" }), "2026-03-04");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ due: { start: "2026-03-04" } }));

    await userEvent.click(page.getByRole("switch", { name: "End date" }));
    await userEvent.fill(page.getByRole("textbox", { name: "End date" }), "2026-03-06");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(page.getByRole("switch", { name: "Include time" }));
    await vi.waitFor(() => {
      const due = lastWrite(fake)?.due as { start: string; end?: string; timeZone?: string };
      expect(due).toMatchObject({ start: "2026-03-04T00:00:00", end: "2026-03-06T00:00:00" });
      expect(due.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
  });

  it("clears the date", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "due")));
    await userEvent.fill(page.getByRole("textbox", { name: "Start date" }), "2026-03-04");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(page.getByRole("button", { name: "Clear" }));
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ due: null }));
  });
});

describe("links and files", () => {
  it("edits a url inline and adds a file by link", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "site")));
    await userEvent.fill(screen.getByRole("textbox", { name: "Site" }), "https://example.com");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ site: "https://example.com" }));

    await userEvent.click(locate(cell("row-1", "files")));
    await userEvent.fill(page.getByRole("textbox", { name: "File URL" }), "ftp://example.com/x");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Enter an http or https link")).toBeVisible();
    await userEvent.fill(
      page.getByRole("textbox", { name: "File URL" }),
      "https://example.com/a/report.pdf",
    );
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(lastWrite(fake)).toEqual({
        files: [{ name: "report.pdf", url: "https://example.com/a/report.pdf" }],
      }),
    );
  });
});

describe("relation editor", () => {
  it("searches the related data source and toggles pages", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "rel")));
    await userEvent.fill(page.getByRole("combobox", { name: "Search Related" }), "Task 3");
    await expect.element(page.getByRole("option", { name: "Task 3" })).toBeVisible();
    await vi.waitFor(() =>
      expect(fake.callsOf("query").at(-1)!.input).toMatchObject({
        mode: "rows",
        search: "Task 3",
        limit: 20,
        properties: [],
      }),
    );
    await userEvent.click(page.getByRole("option", { name: "Task 3" }));
    await vi.waitFor(() => expect(lastWrite(fake)).toEqual({ rel: ["row-3"] }));
    await expect.element(page.getByRole("button", { name: "Remove Task 3" })).toBeVisible();
    await vi.waitFor(() => expect(cell("row-1", "rel")!.textContent).toContain("Task 3"));
  });
});

describe("read-only types", () => {
  it("focuses created time but never opens an editor", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    expect(cell("row-1", "made")!.getAttribute("aria-readonly")).toBe("true");
    await userEvent.click(locate(cell("row-1", "made")));
    await userEvent.keyboard("{Enter}x");
    expect(focused()).toBe("row-1:made");
    expect(screen.container.querySelectorAll("input")).toHaveLength(1);
    expect(fake.callsOf("updateRows")).toHaveLength(0);
  });
});
