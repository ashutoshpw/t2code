import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { fixtureView } from "../test/fixtures";
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

describe("group aggregates", () => {
  it("shows the column calculation under each group's rows as well as in the footer", async () => {
    const view = fixtureView("view-table", "table", "Table", 0) as unknown as {
      properties: { propertyId: string }[];
    };
    const fake = new FakeDatabase({
      rows: 6,
      quietRowWrites: true,
      views: [
        {
          ...view,
          group: { property: "status", by: "option" },
          properties: view.properties.map((entry) =>
            entry.propertyId === "amount" ? { ...entry, aggregate: "sum" } : entry,
          ),
        } as never,
      ],
    });
    state.fake = fake;
    await page.viewport(1800, 900);
    const { screen, grid } = await mountTable(fake);
    await using _screen = screen;
    await vi.waitFor(() =>
      expect(grid().querySelectorAll('[role="row"]').length).toBeGreaterThan(5),
    );
    const sums = () =>
      [...grid().querySelectorAll<HTMLElement>('[role="row"]')].filter((row) =>
        /Sum \d/.test(row.textContent ?? ""),
      );
    // Four groups (three options and the empty one) plus the footer.
    await vi.waitFor(() => expect(sums()).toHaveLength(5));
    // Group lines sit among the rows, the footer is the last row of the grid.
    expect(sums().at(-1)!.className).toContain("sticky");
    expect(
      sums()
        .slice(0, -1)
        .every((row) => row.className.includes("absolute")),
    ).toBe(true);
  });
});
