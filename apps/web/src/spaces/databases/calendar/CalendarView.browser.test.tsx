import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { fixtureView, withProperty } from "../test/fixtures";
import { datedRow, dragBetween, mountDated } from "./calendarHarness";

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

const NOW = Date.UTC(2026, 10, 11, 12);

async function mount(
  rows: ReturnType<typeof datedRow>[],
  layout: Record<string, unknown> = {},
  options: Partial<ConstructorParameters<typeof FakeDatabase>[0]> = {},
) {
  const view = fixtureView("view-cal", "calendar", "Calendar", 0, {
    datePropertyId: "due",
    ...layout,
  });
  const fake = new FakeDatabase({ quietRowWrites: true, views: [view], rowData: rows, ...options });
  state.fake = fake;
  await page.viewport(1400, 900);
  const mounted = await readyWhen(
    await mountDated(view, options.permissions?.cells !== false),
    (dated) => vi.waitFor(() => expect(dated.root.querySelector('[role="grid"]')).not.toBeNull()),
  );
  return { fake, ...mounted };
}

const columnOf = (root: HTMLElement, id: string, nth = 0) =>
  root.querySelectorAll<HTMLElement>(`[data-item-id="${id}"]`)[nth]?.style.gridColumn;
const weekOf = (root: HTMLElement, id: string, nth = 0) =>
  [...root.querySelectorAll<HTMLElement>(`[data-item-id="${id}"]`)]
    .at(nth)
    ?.closest<HTMLElement>("[data-week]")?.dataset.week;
interface QueryInput {
  readonly extraFilter: { readonly and: ReadonlyArray<{ readonly value: string }> };
}
const queries = (fake: FakeDatabase): ReadonlyArray<QueryInput> =>
  fake.callsOf("query").map((call) => Object.assign({ extraFilter: { and: [] } }, call.input));
const bound = (fake: FakeDatabase, call: number, which: 0 | 1) =>
  queries(fake).at(call)?.extraFilter.and[which]?.value;

describe("month", () => {
  it("places items on their days, repeats a span in every week it crosses, and asks for the visible range", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-12" }),
      datedRow("span", "Span", { start: "2026-11-13", end: "2026-11-17" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    expect(weekOf(root, "a")).toBe("2026-11-08");
    expect(columnOf(root, "a")).toBe("5 / 6");
    expect(root.querySelectorAll('[data-item-id="span"]')).toHaveLength(2);
    expect([weekOf(root, "span", 0), columnOf(root, "span", 0)]).toEqual(["2026-11-08", "6 / 8"]);
    expect([weekOf(root, "span", 1), columnOf(root, "span", 1)]).toEqual(["2026-11-15", "1 / 4"]);
    expect(screen.getByText("November 2026")).toBeTruthy();
    expect(queries(fake)[0]!.extraFilter).toEqual({
      and: [
        { property: "due", operator: "on_or_before", value: "2026-12-05", part: "start" },
        { property: "due", operator: "on_or_after", value: "2026-11-01", part: "end" },
      ],
    });
  });

  it("fetches only the next range when navigating", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-12" }),
      datedRow("d", "December", { start: "2026-12-20" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="d"]')).not.toBeNull());
    expect(root.querySelector('[data-item-id="a"]')).toBeNull();
    expect(bound(fake, -1, 0)).toBe("2027-01-02");
    expect(bound(fake, -1, 1)).toBe("2026-11-29");
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    await vi.waitFor(() => expect(screen.getByText("November 2026")).toBeTruthy());
  });

  it("collapses items past six lanes into a +N more list", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const rows = Array.from({ length: 8 }, (_, i) =>
      datedRow(`r${i}`, `Item ${i}`, { start: "2026-11-12" }),
    );
    const { screen, root } = await mount(rows);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelectorAll("[data-item-id]")).toHaveLength(6));
    await userEvent.click(screen.getByRole("button", { name: "+2 more" }));
    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Item 7" }).element()).toBeTruthy(),
    );
    expect(page.getByRole("dialog").element().querySelectorAll("li")).toHaveLength(8);
  });
});

describe("week", () => {
  it("shows one week, steps by a week, and hides weekends", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, root } = await mount(
      [
        datedRow("a", "Alpha", { start: "2026-11-12" }),
        datedRow("w", "Weekend", { start: "2026-11-14" }),
      ],
      { mode: "week", weekStart: "monday", showWeekends: false },
    );
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    expect(root.querySelectorAll("[data-week]")).toHaveLength(1);
    expect(root.querySelectorAll('[role="columnheader"]')).toHaveLength(5);
    expect(columnOf(root, "a")).toBe("4 / 5");
    expect(root.querySelector('[data-item-id="w"]')).toBeNull();
    expect(bound(fake, 0, 1)).toBe("2026-11-09");
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    await vi.waitFor(() => expect(bound(fake, -1, 1)).toBe("2026-11-16"));
  });
});

describe("editing", () => {
  it("adds a row on a day with the date prefilled and opens it", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, host, screen, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-12" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Add on 2026-11-20" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    expect(fake.callsOf("createRows")[0]!.input).toMatchObject({
      rows: [{ cells: { due: { start: "2026-11-20" } } }],
    });
    await vi.waitFor(() => expect(host.openPage).toHaveBeenCalled());
  });

  it("drags an item to another day and writes the shifted date", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, root } = await mount([
      datedRow("a", "Alpha", {
        start: "2026-11-12T09:30:00",
        end: "2026-11-12T10:30:00",
        timeZone: "UTC",
      }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    const target = root.querySelector<HTMLElement>('[data-day="2026-11-19"]')!;
    await dragBetween(root.querySelector('[data-item-id="a"] button')!, target, () =>
      target.className.includes("ring-ring"),
    );
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("updateRows")[0]!.input).toMatchObject({
      rows: [
        {
          pageId: "a",
          cells: {
            due: { start: "2026-11-19T09:30:00", end: "2026-11-19T10:30:00", timeZone: "UTC" },
          },
        },
      ],
    });
    // The item sits on the new day before any refresh answers.
    await vi.waitFor(() => expect(weekOf(root, "a")).toBe("2026-11-15"));
  });

  it("resizes a span by its end edge and writes only the end", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-10", end: "2026-11-11" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    const target = root.querySelector<HTMLElement>('[data-day="2026-11-13"]')!;
    await dragBetween(root.querySelector('[data-item-id="a"] [data-edge="end"]')!, target, () =>
      target.className.includes("ring-ring"),
    );
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("updateRows")[0]!.input).toMatchObject({
      rows: [{ pageId: "a", cells: { due: { start: "2026-11-10", end: "2026-11-13" } } }],
    });
  });

  it("changes the date through the item menu", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, root } = await mount([datedRow("a", "Alpha", { start: "2026-11-12" })]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Change date…" }));
    const input = page.getByRole("textbox", { name: "Start date" });
    await userEvent.clear(input);
    await userEvent.type(input, "2026-11-25{Enter}");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("updateRows")[0]!.input).toMatchObject({
      rows: [{ pageId: "a", cells: { due: { start: "2026-11-25" } } }],
    });
  });

  it("lists items without a date and sets one", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-12" }),
      datedRow("n", "Nameless"),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "No date" }));
    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Nameless" }).element()).toBeTruthy(),
    );
    expect(
      page
        .getByRole("button", { name: "Alpha" })
        .elements()
        .filter((el) => el.closest("[role=dialog]")),
    ).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Set date" }));
    const input = page.getByRole("textbox", { name: "Start date" });
    await userEvent.type(input, "2026-11-30{Enter}");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
  });

  it("shows how many items have no date and loads the rest on request", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const undated = Array.from({ length: 120 }, (_, index) =>
      datedRow(`n${index}`, `Item ${index}`),
    );
    const { screen, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-12" }),
      ...undated,
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "No date" }));
    await expect.element(page.getByText("120 items without a date")).toBeVisible();
    const list = () => document.querySelectorAll("[aria-label='Items without a date'] li");
    await vi.waitFor(() => expect(list()).toHaveLength(100));
    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await vi.waitFor(() => expect(list()).toHaveLength(120));
    await expect.element(page.getByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});

describe("read only", () => {
  it("places rows by a created-time property without drag, edges or add", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 15));
    const dataSource = withProperty("created", "created_time");
    const { fake, screen, root } = await mount(
      [datedRow("a", "Alpha")],
      { datePropertyId: "created" },
      { dataSource },
    );
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    expect(weekOf(root, "a")).toBe("2025-12-28");
    expect(root.querySelector('[aria-label^="Add on"]')).toBeNull();
    expect(root.querySelector("[data-edge]")).toBeNull();
    expect(root.querySelector('[aria-label^="Actions for"]')).toBeNull();
    // No part on created time: the fake would drop every row otherwise.
    expect(JSON.stringify(queries(fake)[0]!.extraFilter)).not.toContain("part");
  });

  it("draws items but offers no add, menu or resize without cell permission", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { screen, root } = await mount(
      [datedRow("a", "Alpha", { start: "2026-11-12", end: "2026-11-13" })],
      {},
      { permissions: { cells: false } },
    );
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-item-id="a"]')).not.toBeNull());
    expect(root.querySelector('[aria-label^="Add on"]')).toBeNull();
    expect(root.querySelector('[aria-label^="Actions for"]')).toBeNull();
    expect(root.querySelector("[data-edge]")).toBeNull();
  });
});
