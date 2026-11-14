import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { fixtureOtherDatabase } from "../test/fixtures";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { EditableFakeDatabase } from "./controlsFake";

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
vi.mock(import("../table/TableView"), async () => ({
  default: (await import("./controlsStub")).default,
}));

const projects = fixtureOtherDatabase("projects", "Projects", ["Alpha"]);

async function mount(listLimit?: number) {
  const fake = new EditableFakeDatabase({
    others: [projects, fixtureOtherDatabase("notes", "Notes", [])],
    ...(listLimit === undefined ? {} : { listLimit }),
  });
  state.fake = fake;
  const { controller } = fakeController();
  const screen = await render(
    <DatabaseHarness host={testHost(controller)} initialViewIds={["view-table"]} />,
    { router: false },
  );
  return { fake, screen };
}
const press = (name: string) =>
  vi.waitFor(() =>
    (page.getByRole("button", { name, exact: true }).element() as HTMLElement).click(),
  );
const operations = (fake: EditableFakeDatabase) =>
  fake.callsOf("updateSchema").map((call) => call.input);

describe("relation configuration", () => {
  it("adds a two-way relation to another database and names the twin there", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Relation" }));
    // The current database comes first, then the rest of the space.
    const names = Array.from(
      document.querySelectorAll('[role="listbox"][aria-label="Databases"] [role="option"]'),
      (option) => option.textContent,
    );
    expect(names).toEqual(["Tasks", "Projects", "Notes"]);
    await userEvent.click(page.getByRole("option", { name: "Projects" }));
    await userEvent.click(page.getByRole("switch", { name: "Show on Projects" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Related property name" }), "Linked");
    await userEvent.click(page.getByRole("button", { name: "Add relation" }));
    await vi.waitFor(() => expect(operations(fake)).toHaveLength(2));

    const [add, rename] = operations(fake) as Record<string, any>[];
    const config = add!.operations[0].property.config;
    expect(add!.dataSourceId).toBe("data-source-1");
    expect(config).toMatchObject({ dataSourceId: "projects-source", limit: "many" });
    expect(config.twoWay.propertyId).toMatch(/^[a-z0-9]{6}$/);
    expect(rename).toMatchObject({
      dataSourceId: "projects-source",
      operations: [{ op: "updateProperty", propertyId: config.twoWay.propertyId, name: "Linked" }],
    });
    expect(fake.others[0]!.dataSource.properties[config.twoWay.propertyId]!.name).toBe("Linked");
  });

  it("turns two-way off after a confirmation and shows the target read-only", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Relation" }));
    await userEvent.click(page.getByRole("option", { name: "Projects" }));
    await userEvent.click(page.getByRole("switch", { name: "Show on Projects" }));
    await userEvent.click(page.getByRole("button", { name: "Add relation" }));
    // The property editor opens on the new relation: the target is text, the twin switch is on.
    const dialog = page.getByRole("dialog", { name: "Edit property" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Projects", { exact: true }).first()).toBeVisible();
    const twinSwitch = dialog.getByRole("switch", { name: "Show on Projects" });
    await expect.element(twinSwitch).toBeChecked();
    await userEvent.click(twinSwitch);
    await expect.element(page.getByText("Remove the related property?")).toBeVisible();
    await press("Remove");
    await vi.waitFor(() => {
      const last = operations(fake).at(-1) as Record<string, any>;
      expect(last.operations[0].config.twoWay).toBeUndefined();
    });
    expect(Object.keys(fake.others[0]!.dataSource.properties)).toEqual(["title"]);
  });

  it("pages the database list with Load more", async () => {
    const { fake, screen } = await mount(2);
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Relation" }));
    await expect.element(page.getByRole("option", { name: "Notes" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Load more" }));
    await expect.element(page.getByRole("option", { name: "Notes" })).toBeVisible();
    expect(fake.callsOf("listPage")).toHaveLength(1);
  });
});
