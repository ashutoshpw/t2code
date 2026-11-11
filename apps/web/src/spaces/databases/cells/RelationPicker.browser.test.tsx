import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { fixtureOtherDatabase, fixtureView, withRelation } from "../test/fixtures";
import { mountTable } from "../table/tableHarness";

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

async function mount(projectTitles: ReadonlyArray<string>, limit: "one" | "many" = "many") {
  const projects = fixtureOtherDatabase("projects", "Projects", projectTitles);
  const table = fixtureView("view-table", "table", "Table", 0);
  const fake = new FakeDatabase({
    rows: 3,
    quietRowWrites: true,
    dataSource: withRelation("projects-source", "project", "Project", limit),
    others: [projects],
    views: [
      {
        ...table,
        properties: [...table.properties, { propertyId: "project", visible: true }],
      } as typeof table,
    ],
  });
  state.fake = fake;
  await page.viewport(1800, 900);
  const mounted = await readyWhen(await mountTable(fake), (table) =>
    vi.waitFor(() => expect(table.cell("row-1", "project")).not.toBeNull()),
  );
  return { fake, ...mounted };
}
const locate = (element: HTMLElement | null) => page.elementLocator(element!);

describe("relation picker", () => {
  it("searches another database, picks a page and shows its chip at once", async () => {
    const { fake, screen, cell } = await mount(["Alpha", "Beta"]);
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "project")));
    await userEvent.type(screen.getByRole("combobox", { name: "Search Project" }), "Alp");
    await expect.element(screen.getByRole("option", { name: "Alpha" })).toBeVisible();
    await expect.element(screen.getByRole("option", { name: "Beta" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Alpha" }));
    await vi.waitFor(() => expect(cell("row-1", "project")?.textContent).toContain("Alpha"));
    await vi.waitFor(() =>
      expect(fake.callsOf("updateRows").at(-1)?.input.rows).toEqual([
        { pageId: "row-1", cells: { project: ["projects-row-1"] } },
      ]),
    );
    expect(
      fake.callsOf("query").some((call) => call.input.dataSourceId === "projects-source"),
    ).toBe(true);
  });

  it("loads the next window of results", async () => {
    const titles = Array.from(
      { length: 25 },
      (_, index) => `Page ${String(index).padStart(2, "0")}`,
    );
    const { screen, cell } = await mount(titles);
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "project")));
    await expect.element(screen.getByRole("option", { name: "Page 19" })).toBeVisible();
    await expect.element(screen.getByRole("option", { name: "Page 20" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await expect.element(screen.getByRole("option", { name: "Page 24" })).toBeVisible();
  });

  it("creates a page in the target database and links it", async () => {
    const { fake, screen, cell } = await mount(["Alpha"]);
    await using _screen = screen;
    await userEvent.click(locate(cell("row-2", "project")));
    await userEvent.type(screen.getByRole("combobox", { name: "Search Project" }), "Zed");
    await userEvent.click(screen.getByRole("button", { name: 'Create "Zed" in Projects' }));
    await vi.waitFor(() => expect(cell("row-2", "project")?.textContent).toContain("Zed"));
    const created = fake.callsOf("createRows").at(-1)!.input;
    expect(created.dataSourceId).toBe("projects-source");
    expect(created.rows).toEqual([{ title: "Zed" }]);
    expect(fake.others[0]!.rows.map((row) => row.page.title)).toEqual(["Alpha", "Zed"]);
  });

  it("replaces the value of a limit-one relation and closes", async () => {
    const { screen, cell } = await mount(["Alpha", "Beta"], "one");
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "project")));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    await expect
      .element(screen.getByRole("combobox", { name: "Search Project" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() => expect(cell("row-1", "project")?.textContent).toContain("Beta"));
  });
});
