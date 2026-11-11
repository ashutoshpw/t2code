import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FIXTURE_IDS } from "../test/fixtures";
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

async function mount(patch?: object) {
  const fake = new FakeDatabase({ quietRowWrites: true, rows: 5 });
  if (patch !== undefined)
    fake.views = fake.views.map((view) =>
      view.id === FIXTURE_IDS.tableView ? ({ ...view, ...patch } as typeof view) : view,
    );
  state.fake = fake;
  await page.viewport(1800, 1200);
  const table = await readyWhen(await mountTable(fake), (mounted) =>
    vi.waitFor(() => expect(mounted.cell("row-1", "title")).not.toBeNull()),
  );
  return { fake, ...table };
}

async function mountMarked() {
  const fake = new FakeDatabase({ quietRowWrites: true, rows: 2 });
  fake.rows = fake.rows.map((row, index) =>
    index === 0
      ? ({
          ...row,
          cells: {
            ...row.cells,
            notes: [
              { text: "hello ", marks: [] },
              { text: "world", marks: [{ type: "bold", version: 1 }] },
            ],
          },
        } as typeof row)
      : row,
  );
  state.fake = fake;
  await page.viewport(1800, 1200);
  const table = await readyWhen(await mountTable(fake), (mounted) =>
    vi.waitFor(() => expect(mounted.cell("row-1", "notes")).not.toBeNull()),
  );
  return { fake, ...table };
}

describe("grid keyboard", () => {
  it("opens the row menu from a cell with Shift+F10", async () => {
    const { screen, cell } = await mount();
    await using _screen = screen;
    cell("row-3", "notes")!.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(page.getByRole("menuitem", { name: "Open as full page" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: /^Open\s*(⌘↵|Ctrl\+Enter)/ }))
      .toBeVisible();
  });

  it("resizes a column by keyboard and saves once when the key is released", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    const handle = page.getByRole("separator", { name: "Resize Notes" });
    await expect.element(handle).toHaveAttribute("aria-orientation", "vertical");
    const before = Number(handle.element().getAttribute("aria-valuenow"));
    (handle.element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", String(before + 16));
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(2));
    expect(fake.callsOf("updateView").at(-1)?.input).toMatchObject({
      properties: { set: { notes: { width: before + 16 + 64 } } },
    });
  });
});

describe("number entry", () => {
  it("reads a comma as the decimal mark under a comma-decimal locale", async () => {
    using _locale = vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "amount")!.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Control>}a{/Control}1.234,5{Enter}");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("updateRows")[0]!.input).toMatchObject({
      rows: [{ pageId: "row-1", cells: { amount: 1234.5 } }],
    });
  });
});

describe("marked text", () => {
  it("keeps the marks around an edit made as plain text", async () => {
    const { fake, screen, cell } = await mountMarked();
    await using _screen = screen;
    cell("row-1", "notes")!.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Control>}a{/Control}hello! world{Enter}");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("updateRows")[0]!.input).toMatchObject({
      rows: [
        {
          pageId: "row-1",
          cells: {
            notes: [
              { text: "hello! ", marks: [] },
              { text: "world", marks: [{ type: "bold", version: 1 }] },
            ],
          },
        },
      ],
    });
  });
});

describe("truncated groups", () => {
  it("says so under the grid when the server cut the groups short", async () => {
    const fake = new FakeDatabase({ quietRowWrites: true, rows: 6 });
    const query = fake.query.bind(fake);
    fake.query = async (registry, input) => ({
      ...(await query(registry, input)),
      groupsTruncated: true,
    });
    fake.views = fake.views.map((view) =>
      view.id === FIXTURE_IDS.tableView
        ? ({ ...view, group: { property: "status", by: "option" } } as typeof view)
        : view,
    );
    state.fake = fake;
    await page.viewport(1800, 1200);
    const { screen } = await readyWhen(await mountTable(fake), (mounted) =>
      vi.waitFor(() =>
        expect(mounted.grid().querySelectorAll('[role="row"]').length).toBeGreaterThan(4),
      ),
    );
    await using _screen = screen;
    await expect.element(page.getByText(/Showing the first \d+ groups/)).toBeVisible();
  });
});
