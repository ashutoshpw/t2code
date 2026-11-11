import "~/index.css";

import { SpacePropertyId } from "@t2code/contracts/spaces";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { datedRow, mountDated } from "../calendar/calendarHarness";
import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { fixtureView, withProperty } from "../test/fixtures";
import { makeScale, xToDay } from "./timelineScale";

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

const STATUS_GROUP = { property: SpacePropertyId.make("status") };
const NOW = Date.UTC(2026, 10, 11, 12);
const PX_PER_DAY = 120;
// Zoom "day" centres the anchor, so 2026-11-11 sits 60 days from the canvas origin.
const xOf = (day: string) =>
  (60 + (Date.parse(day) - Date.parse("2026-11-11")) / 86_400_000) * PX_PER_DAY;

async function mount(
  rows: ReturnType<typeof datedRow>[],
  layout: Record<string, unknown> = {},
  options: Partial<ConstructorParameters<typeof FakeDatabase>[0]> = {},
  group?: { property: SpacePropertyId },
) {
  const view = {
    ...fixtureView("view-tl", "timeline", "Timeline", 0, {
      startPropertyId: "due",
      zoom: "day",
      ...layout,
    }),
    ...(group === undefined ? {} : { group }),
  };
  const fake = new FakeDatabase({ quietRowWrites: true, views: [view], rowData: rows, ...options });
  state.fake = fake;
  await page.viewport(1400, 900);
  const mounted = await readyWhen(
    await mountDated(view, options.permissions?.cells !== false),
    (dated) => vi.waitFor(() => expect(dated.root.querySelector("[data-today]")).not.toBeNull()),
  );
  const bar = (id: string) => mounted.root.querySelector<HTMLElement>(`[data-bar-id="${id}"]`)!;
  return { fake, bar, ...mounted };
}
const written = (fake: FakeDatabase) => fake.callsOf("updateRows").map((call) => call.input);

describe("bars", () => {
  it("positions a bar by date and draws a range through the end of its last day", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { screen, bar, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-13", end: "2026-11-14" }),
      datedRow("b", "Beta", { start: "2026-11-11" }),
      datedRow("none", "Nameless"),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(bar("a")).not.toBeNull());
    expect([bar("a").style.left, bar("a").style.width]).toEqual([
      `${xOf("2026-11-13")}px`,
      `${2 * PX_PER_DAY}px`,
    ]);
    expect([bar("b").style.left, bar("b").style.width]).toEqual([
      `${xOf("2026-11-11")}px`,
      `${PX_PER_DAY}px`,
    ]);
    expect(bar("a").getAttribute("aria-label")).toBe("Alpha, 2026-11-13 to 2026-11-14");
    expect(root.querySelector('[data-bar-id="none"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Set dates for Nameless" })).toBeTruthy();
    expect(root.querySelectorAll('[role="listitem"][data-row-id]')).toHaveLength(3);
  });

  it("windows rows vertically", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const rows = Array.from({ length: 500 }, (_, i) =>
      datedRow(`r${i}`, `Item ${i}`, { start: "2026-11-12" }),
    );
    const { screen, root } = await mount(rows);
    await using _screen = screen;
    await vi.waitFor(() =>
      expect(root.querySelectorAll("[data-bar-id]").length).toBeGreaterThan(0),
    );
    expect(root.querySelectorAll("[data-bar-id]").length).toBeLessThan(60);
  });
});

describe("keyboard", () => {
  it("moves a bar by a day, and resizes either edge, as one mutation each", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, bar } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-13", end: "2026-11-14" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(bar("a")).not.toBeNull());
    bar("a").focus();
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(written(fake)).toHaveLength(1));
    expect(written(fake)[0]).toMatchObject({
      rows: [{ pageId: "a", cells: { due: { start: "2026-11-14", end: "2026-11-15" } } }],
    });
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await vi.waitFor(() => expect(written(fake)).toHaveLength(2));
    expect(written(fake)[1]).toMatchObject({
      rows: [{ cells: { due: { start: "2026-11-14", end: "2026-11-16" } } }],
    });
    await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    await vi.waitFor(() => expect(written(fake)).toHaveLength(3));
    expect(written(fake)[2]).toMatchObject({
      rows: [{ cells: { due: { start: "2026-11-13", end: "2026-11-16" } } }],
    });
  });

  it("opens the page on Enter", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { host, screen, bar } = await mount([datedRow("a", "Alpha", { start: "2026-11-13" })]);
    await using _screen = screen;
    await vi.waitFor(() => expect(bar("a")).not.toBeNull());
    bar("a").focus();
    await userEvent.keyboard("{Enter}");
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "a" }));
  });
});

describe("pointer", () => {
  it("moves a bar on release by the snapped distance and writes once", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, bar, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-13", end: "2026-11-14" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(bar("a")).not.toBeNull());
    const track = root.querySelector<HTMLElement>('[role="list"].relative')!;
    const box = bar("a").getBoundingClientRect();
    const trackBox = track.getBoundingClientRect();
    // Grab the middle of the bar and drop it 2.4 days to the right: rounds to 2.
    await userEvent.dragAndDrop(page.elementLocator(bar("a")), page.elementLocator(track), {
      targetPosition: { x: box.left - trackBox.left + box.width / 2 + 2.4 * PX_PER_DAY, y: 18 },
    });
    await vi.waitFor(() => expect(written(fake)).toHaveLength(1));
    expect(written(fake)[0]).toMatchObject({
      rows: [{ pageId: "a", cells: { due: { start: "2026-11-15", end: "2026-11-16" } } }],
    });
  });

  it("resizes the end edge", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, bar, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-13", end: "2026-11-14" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(bar("a")).not.toBeNull());
    const track = root.querySelector<HTMLElement>('[role="list"].relative')!;
    const edge = bar("a").querySelector<HTMLElement>('[data-edge="end"]')!;
    const box = edge.getBoundingClientRect();
    const trackBox = track.getBoundingClientRect();
    await userEvent.dragAndDrop(page.elementLocator(edge), page.elementLocator(track), {
      targetPosition: { x: box.left - trackBox.left + box.width / 2 + PX_PER_DAY, y: 18 },
    });
    await vi.waitFor(() => expect(written(fake)).toHaveLength(1));
    expect(written(fake)[0]).toMatchObject({
      rows: [{ cells: { due: { start: "2026-11-13", end: "2026-11-15" } } }],
    });
  });

  it("sets the dates of a row without any from a click on its track", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen } = await mount([datedRow("n", "Nameless")]);
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Set dates for Nameless" }));
    await vi.waitFor(() => expect(written(fake)).toHaveLength(1));
    // The track is as wide as the canvas, so its centre is the anchor day.
    const start = (written(fake)[0] as { rows: Array<{ cells: { due: { start: string } } }> })
      .rows[0]!.cells.due.start;
    expect([xToDay(makeScale("day", "2026-11-11"), 7199), "2026-11-11"]).toContain(start);
  });
});

describe("two properties", () => {
  it("resizes only the end property and moves both together", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const dataSource = withProperty("until", "date");
    const rows = [
      {
        ...datedRow("a", "Alpha", { start: "2026-11-13" }),
        cells: { title: "Alpha", due: { start: "2026-11-13" }, until: { start: "2026-11-15" } },
      },
    ] as never;
    const { fake, screen, bar } = await mount(rows, { endPropertyId: "until" }, { dataSource });
    await using _screen = screen;
    await vi.waitFor(() => expect(bar("a")).not.toBeNull());
    expect(bar("a").style.width).toBe(`${3 * PX_PER_DAY}px`);
    bar("a").focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await vi.waitFor(() => expect(written(fake)).toHaveLength(1));
    expect(written(fake)[0]).toMatchObject({
      rows: [{ pageId: "a", cells: { until: { start: "2026-11-16" } } }],
    });
    expect(JSON.stringify(written(fake)[0])).not.toContain('"due"');
    await userEvent.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(written(fake)).toHaveLength(2));
    expect(written(fake)[1]).toMatchObject({
      rows: [{ cells: { due: { start: "2026-11-14" }, until: { start: "2026-11-17" } } }],
    });
  });
});

describe("side table", () => {
  it("lists the titles, opens a page, and writes its width once on release", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, host, screen, root } = await mount([
      datedRow("a", "Alpha", { start: "2026-11-13" }),
    ]);
    await using _screen = screen;
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy());
    const handle = root.querySelector<HTMLElement>('[role="separator"]')!;
    const scroller = handle.closest<HTMLElement>(".overflow-auto")!;
    const box = handle.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    await userEvent.dragAndDrop(page.elementLocator(handle), page.elementLocator(scroller), {
      targetPosition: { x: box.left - scrollerBox.left + box.width / 2 + 60, y: 20 },
    });
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    const width = (fake.callsOf("updateView")[0]!.input as { layout: { tableWidth: number } })
      .layout.tableWidth;
    expect(Math.abs(width - 300)).toBeLessThanOrEqual(2);
    await userEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "a" }));
  });
});

describe("groups", () => {
  const statusRow = (id: string, title: string, status: string, day: string) => {
    const row = datedRow(id, title, { start: day });
    return { ...row, cells: { ...row.cells, status } };
  };

  it("draws a header per group and loads more rows of one group", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const many = Array.from({ length: 26 }, (_, i) =>
      statusRow(`t${i}`, `Todo ${i}`, "todo", "2026-11-12"),
    );
    const { fake, screen, root } = await mount(many, {}, {}, STATUS_GROUP);
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-bar-id="t0"]')).not.toBeNull());
    expect(fake.callsOf("query")[0]?.input).toMatchObject({ mode: "groups" });
    await expect
      .element(screen.getByRole("button", { name: "Collapse Not started" }))
      .toBeVisible();
    root.querySelector<HTMLElement>("[aria-busy]")!.scrollTop = 900;
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await vi.waitFor(() =>
      expect(
        fake
          .callsOf("query")
          .some((call) => (call.input as { scope?: object }).scope !== undefined),
      ).toBe(true),
    );
  });

  it("collapses a group and hides its bars", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { screen, root } = await mount(
      [
        statusRow("a", "Alpha", "todo", "2026-11-12"),
        statusRow("d1", "Shipped", "done", "2026-11-13"),
      ],
      {},
      {},
      STATUS_GROUP,
    );
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-bar-id="d1"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Collapse Done" }));
    await vi.waitFor(() => expect(root.querySelector('[data-bar-id="d1"]')).toBeNull());
    expect(root.querySelector('[data-bar-id="a"]')).not.toBeNull();
    await expect.element(screen.getByRole("button", { name: "Expand Done" })).toBeVisible();
  });

  it("keeps the group header reachable when the side table is hidden", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { screen, root } = await mount(
      [statusRow("a", "Alpha", "todo", "2026-11-12")],
      { showTable: false },
      {},
      STATUS_GROUP,
    );
    await using _screen = screen;
    await vi.waitFor(() => expect(root.querySelector('[data-bar-id="a"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Collapse Not started" }));
    await vi.waitFor(() => expect(root.querySelector('[data-bar-id="a"]')).toBeNull());
  });
});

describe("read only", () => {
  it("draws bars without edges, keys or click-to-set", async () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { fake, screen, bar, root } = await mount(
      [datedRow("a", "Alpha", { start: "2026-11-13" }), datedRow("n", "Nameless")],
      {},
      { permissions: { cells: false } },
    );
    await using _screen = screen;
    await vi.waitFor(() => expect(bar("a")).not.toBeNull());
    expect(root.querySelector("[data-edge]")).toBeNull();
    bar("a").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(
      screen
        .getByRole("button", { name: "Set dates for Nameless" })
        .element()
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(written(fake)).toHaveLength(0);
  });
});
