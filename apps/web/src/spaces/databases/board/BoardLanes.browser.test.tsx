import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { fixtureDataSource, fixtureRows, fixtureView } from "../test/fixtures";
import { mountBoard } from "./boardHarness";

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

const withPriority = () => {
  const base = fixtureDataSource();
  return {
    ...base,
    properties: {
      ...base.properties,
      priority: {
        id: "priority",
        name: "Priority",
        type: "select",
        position: 9,
        config: {
          options: [
            { id: "p1", name: "High", color: "red" },
            { id: "p2", name: "Low", color: "gray" },
          ],
        },
      },
    },
  } as never;
};

async function mount(
  layout: Record<string, unknown> = {},
  subGroup = true,
  aggregate: string | null = null,
) {
  const board = fixtureView("view-board", "board", "Board", 0, layout) as unknown as Record<
    string,
    unknown
  >;
  const rows = fixtureRows(4).map((row, index) => ({
    ...row,
    cells: { ...row.cells, priority: index % 2 === 0 ? "p1" : "p2", amount: index + 1 },
  }));
  const fake = new FakeDatabase({
    quietRowWrites: true,
    dataSource: withPriority(),
    rowData: rows as never,
    views: [
      {
        ...board,
        ...(subGroup ? { subGroup: { property: "priority" } } : {}),
        properties: [
          ...(board.properties as object[]),
          { propertyId: "priority", visible: true },
        ].map((entry) =>
          aggregate !== null && (entry as { propertyId: string }).propertyId === "amount"
            ? { ...entry, aggregate }
            : entry,
        ),
      } as never,
    ],
  });
  state.fake = fake;
  await page.viewport(1800, 1000);
  const mounted = await mountBoard(fake);
  return { fake, ...mounted };
}
const lane = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`section[aria-label="Lane ${name}"]`)!;
const cardsIn = (section: HTMLElement) =>
  [...section.querySelectorAll<HTMLElement>("[data-card-id]")].map((card) => card.dataset.cardId);

describe("sub-group lanes", () => {
  it("renders one lane per sub-group value with the matching cards in each column", async () => {
    const { screen } = await mount();
    await using _screen = screen;
    await vi.waitFor(() => expect(lane(screen.container, "High")).not.toBeNull());
    // Rows 1 and 3 are High (todo, done), rows 2 and 4 are Low (doing, todo).
    expect(cardsIn(lane(screen.container, "High"))).toEqual(["row-1", "row-3"]);
    expect(cardsIn(lane(screen.container, "Low"))).toEqual(["row-4", "row-2"]);
    await userEvent.click(screen.getByRole("button", { name: "Collapse lane High" }));
    expect(cardsIn(lane(screen.container, "High"))).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Expand lane High" }));
    expect(cardsIn(lane(screen.container, "High"))).toEqual(["row-1", "row-3"]);
  });

  it("keeps the column layout when there is no sub-group", async () => {
    const { screen, cardsIn: inColumn } = await mount({}, false);
    await using _screen = screen;
    await vi.waitFor(() => expect(inColumn("Not started")).toContain("row-1"));
    expect(screen.container.querySelector('section[aria-label^="Lane"]')).toBeNull();
  });

  it("writes both properties when a card lands in another column and lane", async () => {
    const { fake, screen, card } = await mount();
    await using _screen = screen;
    await vi.waitFor(() => expect(card("row-1")).not.toBeNull());
    card("row-1")!.querySelector("button")!.focus();
    await userEvent.keyboard(" ");
    await vi.waitFor(() => expect(document.querySelector("[aria-live]")).not.toBeNull());
    await userEvent.keyboard("{ArrowRight}{ArrowDown}");
    await userEvent.keyboard(" ");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    // One row entry carries both patches; the lane it landed in is wherever the step ended.
    const [entry] = fake.callsOf("updateRows")[0]!.input.rows as {
      pageId: string;
      cells: Record<string, unknown>;
    }[];
    expect(entry!.pageId).toBe("row-1");
    expect(entry!.cells.status).toBe("doing");
    expect(entry!.cells).toHaveProperty("priority");
    expect(entry!.cells.priority).not.toBe("p1");
  });
});

describe("board card size and column calculation", () => {
  it("sizes columns from the layout and shows the calculation in the header", async () => {
    const { screen, column } = await mount({ cardSize: "large" }, false);
    await using _screen = screen;
    await vi.waitFor(() => expect(column("Not started")).not.toBeNull());
    expect(column("Not started").style.width).toBe("320px");
  });

  it("shows the column calculation next to each column's count", async () => {
    const { screen, column } = await mount({}, false, "sum");
    await using _screen = screen;
    await vi.waitFor(() => expect(column("Not started")).not.toBeNull());
    await vi.waitFor(() =>
      expect(
        [...column("Not started").querySelectorAll("header span")].map((el) => el.textContent),
      ).toContain("2"),
    );
    expect(column("Done").querySelector("header")!.textContent).toMatch(/\d+\d+/);
  });
});
