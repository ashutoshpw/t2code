import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { SpacePageId } from "@t2code/contracts/spaces";

import { render } from "../../../../test/render";
import { DatabaseHarness, fakeController, testHost, TEST_ENVIRONMENT } from "../test/harness";
import { FIXTURE_IDS, fixtureView } from "../test/fixtures";
import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";
import RowProperties from "./RowProperties";

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

const row = SpacePageId.make("row-1");

/** A table of the fake database next to the properties of its first row, as a peek shows them. */
async function mount(options: ConstructorParameters<typeof FakeDatabase>[0] = {}) {
  const fake = new FakeDatabase({ rows: 5, quietRowWrites: true, ...options });
  state.fake = fake;
  await page.viewport(1800, 900);
  const { controller } = fakeController();
  const screen = await render(
    <>
      <DatabaseHarness
        host={testHost(controller)}
        initialViewIds={[FIXTURE_IDS.tableView]}
        layout="page"
      />
      <RowProperties environmentId={TEST_ENVIRONMENT} pageId={row} />
    </>,
  );
  // The table has columns and buttons of the same names.
  const fields = screen.getByRole("region", { name: "Row properties" });
  const cell = (rowId: string, column: string) =>
    screen.container.querySelector<HTMLElement>(`[data-row="${rowId}"][data-col="${column}"]`);
  return readyWhen({ fake, screen, cell, fields }, () => expect.element(fields).toBeVisible());
}
const writes = (fake: FakeDatabase) =>
  fake.callsOf("updateRows").map((call) => call.input.rows as unknown[]);

describe("row properties", () => {
  it("lists every property but the title, including ones the view hides", async () => {
    const hidden = fixtureView(FIXTURE_IDS.tableView, "table", "Table", 0);
    const view = {
      ...hidden,
      properties: hidden.properties.map((entry) =>
        entry.propertyId === "amount" ? { ...entry, visible: false } : entry,
      ),
    };
    const { screen, fields } = await mount({ views: [view] });
    await using _screen = screen;
    const names = ["Status", "Tags", "Due", "Done", "Notes", "Amount"];
    for (const name of names)
      await expect
        .element(fields.getByRole("button", { name: `${name} property menu` }))
        .toBeVisible();
    await expect
      .element(fields.getByRole("button", { name: "Name property menu" }))
      .not.toBeInTheDocument();
  });

  it("edits a text property and the table shows it without querying again", async () => {
    const { fake, screen, fields, cell } = await mount();
    await using _screen = screen;
    await vi.waitFor(() => expect(cell("row-1", "title")).not.toBeNull());
    const queries = fake.callsOf("query").length;
    await userEvent.click(fields.getByRole("button", { name: "Notes", exact: true }));
    const input = fields.getByRole("textbox", { name: "Notes" });
    await expect.element(input).toHaveFocus();
    await userEvent.fill(input, "Hello");
    await userEvent.keyboard("{Enter}");
    await expect.element(fields.getByRole("button", { name: "Notes: Hello" })).toHaveFocus();
    await vi.waitFor(() => expect(cell("row-1", "notes")?.textContent).toContain("Hello"));
    await vi.waitFor(() => expect(writes(fake)).toHaveLength(1));
    expect(writes(fake)[0]).toMatchObject([{ pageId: "row-1" }]);
    // The acknowledged value stays in the header while the row answer is on its way.
    await expect.element(fields.getByRole("button", { name: "Notes: Hello" })).toBeVisible();
    expect(fake.callsOf("query")).toHaveLength(queries);
  });

  it("changes a status from its popover and toggles a checkbox", async () => {
    const { fake, screen, fields, cell } = await mount();
    await using _screen = screen;
    await vi.waitFor(() => expect(cell("row-1", "status")).not.toBeNull());
    await userEvent.click(fields.getByRole("button", { name: "Status: Not started" }));
    await userEvent.click(page.getByRole("option", { name: "In progress" }));
    await vi.waitFor(() => expect(cell("row-1", "status")?.textContent).toContain("In progress"));
    const done = fields.getByRole("checkbox", { name: "Done", exact: true });
    await expect.element(done).toHaveAttribute("aria-checked", "true");
    await userEvent.click(done);
    await expect.element(done).toHaveAttribute("aria-checked", "false");
    await vi.waitFor(() => expect(writes(fake)).toHaveLength(1));
    expect(JSON.stringify(writes(fake))).toContain('"done":null');
  });

  it("moves between properties with the arrow keys", async () => {
    const { screen, fields } = await mount();
    await using _screen = screen;
    const status = fields.getByRole("button", { name: "Status: Not started" });
    await expect.element(status).toBeVisible();
    status.element().focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(fields.getByRole("button", { name: "Tags", exact: true })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(status).toHaveFocus();
  });

  it("adds a property from the row", async () => {
    const { fake, screen, fields } = await mount();
    await using _screen = screen;
    await userEvent.click(fields.getByRole("button", { name: "Add a property" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Text" }));
    await vi.waitFor(() =>
      expect(JSON.stringify(fake.callsOf("updateSchema")[0]?.input)).toContain("addProperty"),
    );
    await expect
      .element(fields.getByRole("button", { name: "Property property menu" }))
      .toBeVisible();
  });

  it("is read only without the cell and schema permissions", async () => {
    const { fake, screen, fields } = await mount({ permissions: { cells: false, schema: false } });
    await using _screen = screen;
    const notes = fields.getByRole("button", { name: "Notes", exact: true });
    await expect.element(notes).toBeVisible();
    await expect.element(notes).toHaveAttribute("aria-readonly", "true");
    await userEvent.click(notes);
    await expect.element(fields.getByRole("textbox", { name: "Notes" })).not.toBeInTheDocument();
    await expect
      .element(fields.getByRole("button", { name: "Add a property" }))
      .not.toBeInTheDocument();
    await expect
      .element(fields.getByRole("button", { name: "Notes property menu" }))
      .not.toBeInTheDocument();
    expect(fake.callsOf("updateRows")).toHaveLength(0);
  });
});
