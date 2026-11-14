import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { FakeDatabase } from "../test/fakeDatabase";
import { fixtureRows, fixtureView } from "../test/fixtures";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { readyWhen } from "../test/readyWhen";

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

/** Three rows: two Not started, one In progress, none Done. */
async function mount(group: boolean = true) {
  const view = {
    ...fixtureView("view-chart", "table", "Chart", 0),
    type: "chart",
    ...(group ? { group: { property: "status" } } : {}),
  } as never;
  const rowData = fixtureRows(3).map((row) =>
    row.page.id === "row-3" ? { ...row, cells: { ...row.cells, status: "todo" } } : row,
  );
  const fake = new FakeDatabase({ quietRowWrites: true, views: [view], rowData });
  state.fake = fake;
  const { controller } = fakeController();
  const host = testHost(controller);
  await page.viewport(1400, 900);
  const screen = await readyWhen(
    {
      screen: await render(
        <DatabaseHarness host={host} initialViewIds={["view-chart"]} layout="page" />,
      ),
    },
    () =>
      vi.waitFor(() =>
        expect(
          page.getByRole("button", { name: /View as table|Choose X axis/ }).elements(),
        ).toHaveLength(1),
      ),
  );
  return { fake, host, screen: screen.screen };
}

const queriesWithScope = (fake: FakeDatabase) =>
  fake.callsOf("query").filter((call) => (call.input as { scope?: unknown }).scope !== undefined);

describe("chart view", () => {
  it("lists every bucket with its count in the data table", async () => {
    const { screen } = await mount();
    await using _screen = screen;
    const table = page.getByRole("table");
    await expect.element(table.getByRole("row", { name: /Not started 2/ })).toBeInTheDocument();
    await expect.element(table.getByRole("row", { name: /In progress 1/ })).toBeInTheDocument();
    await expect.element(table.getByRole("row", { name: /Done 0/ })).toBeInTheDocument();
  });

  it("opens the rows behind a bar in a peek scoped to that bucket", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    const bars = screen.container.querySelectorAll<SVGRectElement>('svg rect[fill="transparent"]');
    expect(bars.length).toBeGreaterThanOrEqual(3);
    // The empty bucket comes first, then Not started.
    bars[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Task 1" }))
      .toBeVisible();
    await expect.element(page.getByRole("dialog").getByText("Task 3")).toBeVisible();
    expect(queriesWithScope(fake).at(-1)?.input).toMatchObject({
      mode: "rows",
      scope: { group: { kind: "option", optionId: "todo" } },
    });
  });

  it("shows the table on request and opens the same peek from its button", async () => {
    const { screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "View as table" }));
    await expect.element(page.getByRole("button", { name: "View as chart" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Show rows for In progress" }));
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "Task 2" }))
      .toBeVisible();
  });

  it("asks for the X axis when the view has no group", async () => {
    const { screen } = await mount(false);
    await using _screen = screen;
    await expect.element(page.getByText("Choose a property for the X axis")).toBeVisible();
  });

  it("writes the chart type from the layout settings", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "View settings" }));
    await userEvent.click(page.getByRole("button", { name: /^Layout/ }));
    await userEvent.click(page.getByRole("combobox", { name: "Chart type" }));
    await userEvent.click(page.getByRole("option", { name: "Donut", exact: true }));
    await vi.waitFor(() =>
      expect(fake.callsOf("updateView").at(-1)?.input).toMatchObject({
        layout: { chartType: "donut" },
      }),
    );
  });
});
