import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { toastManager } from "~/components/ui/toast";
import { render } from "../../../../test/render";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { EditableFakeDatabase } from "../test/editableDatabase";

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

async function mount(options: ConstructorParameters<typeof EditableFakeDatabase>[0] = {}) {
  const fake = new EditableFakeDatabase(options);
  state.fake = fake;
  const { controller } = fakeController();
  const screen = await render(
    <DatabaseHarness host={testHost(controller)} initialViewIds={["view-table"]} />,
    { router: false },
  );
  return { fake, screen };
}
const operations = (fake: EditableFakeDatabase) =>
  fake.callsOf("updateSchema").flatMap((call) => call.input.operations as Record<string, any>[]);
const lastOperation = (fake: EditableFakeDatabase) => operations(fake).at(-1);
const property = (fake: EditableFakeDatabase, id: string) => fake.dataSource.properties[id]!;

/** The dialogs sit under an inert guard that blocks pointer hits; a DOM click is what Enter does. */
const press = (name: string) =>
  vi.waitFor(() =>
    (page.getByRole("button", { name, exact: true }).element() as HTMLElement).click(),
  );
const choose = async (trigger: string, option: string) => {
  await userEvent.click(page.getByRole("combobox", { name: trigger }));
  await userEvent.click(page.getByRole("option", { name: option, exact: true }));
};
async function openEditor(header: string) {
  await userEvent.click(page.getByRole("button", { name: header, exact: true }));
  await userEvent.click(page.getByRole("menuitem", { name: "Edit property" }));
  await expect.element(page.getByRole("dialog", { name: "Edit property" })).toBeVisible();
}

describe("property menu", () => {
  it("renames a property and keeps the typed name until the schema answers", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    const name = page.getByRole("textbox", { name: "Property name" });
    await userEvent.fill(name, "Memo");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toEqual({
        op: "updateProperty",
        propertyId: "notes",
        name: "Memo",
      }),
    );
    await expect.element(name).toHaveValue("Memo");
  });

  it("puts the stored name back when the name is taken", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    const name = page.getByRole("textbox", { name: "Property name" });
    await userEvent.fill(name, "Status");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(fake.callsOf("updateSchema")).toHaveLength(1));
    await expect.element(name).toHaveValue("Notes");
    expect(property(fake, "notes").name).toBe("Notes");
  });

  it("sorts, groups, hides, and filters from the header menu", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    const last = () => fake.callsOf("updateView").at(-1)?.input as Record<string, any>;
    await userEvent.click(page.getByRole("button", { name: "Status", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Sort descending" }));
    await vi.waitFor(() =>
      expect(last().sorts).toEqual([{ property: "status", direction: "descending" }]),
    );
    await userEvent.click(page.getByRole("button", { name: "Status", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Group" }));
    await vi.waitFor(() => expect(last().group).toEqual({ property: "status", by: "option" }));
    await userEvent.click(page.getByRole("button", { name: "Status", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Filter" }));
    await vi.waitFor(() => expect(last().filter.and[0].property).toBe("status"));
    // The filter popover opens so the new rule can be completed.
    await expect.element(page.getByRole("button", { name: "Add rule" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Hide in view" }));
    await vi.waitFor(() => expect(last().properties.set).toEqual({ notes: { visible: false } }));
  });

  it("inserts a text property to the left and shows it in that place", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Insert left" }));
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toMatchObject({
        op: "addProperty",
        property: { name: "Property", type: "text" },
        beforePropertyId: "notes",
      }),
    );
    const { id } = lastOperation(fake)!.property;
    await vi.waitFor(() => {
      const order = (fake.callsOf("updateView").at(-1)!.input as any).properties.order as string[];
      expect(order.indexOf(id)).toBe(order.indexOf("notes") - 1);
    });
  });

  it("deletes a property after confirmation, and the title cannot be deleted", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete property" }));
    await expect.element(page.getByText("You can restore it from Properties.")).toBeVisible();
    await press("Delete property");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toEqual({ op: "removeProperty", propertyId: "notes" }),
    );
    await userEvent.click(page.getByRole("button", { name: "Name", exact: true }));
    await expect
      .element(page.getByRole("menuitem", { name: "Delete property" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: "Hide in view" }))
      .not.toBeInTheDocument();
  });

  it("is read-only without schema permission", async () => {
    const { screen } = await mount({ permissions: { schema: false } });
    await using _screen = screen;
    await expect
      .element(page.getByRole("button", { name: "Add property" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Notes", exact: true }));
    await expect.element(page.getByRole("textbox", { name: "Property name" })).toBeDisabled();
    await expect
      .element(page.getByRole("menuitem", { name: "Delete property" }))
      .toHaveAttribute("aria-disabled", "true");
  });
});

describe("property editor", () => {
  it("changes text to url at once and asks before a lossy change", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    const toast = vi.spyOn(toastManager, "add");
    fake.clearedCells = 3;
    await openEditor("Notes");
    await choose("Property type", "URL");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toEqual({
        op: "changePropertyType",
        propertyId: "notes",
        type: "url",
      }),
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "3 values cleared" }));
    await choose("Property type", "Number");
    await expect
      .element(page.getByText("Values that cannot be converted are cleared."))
      .toBeVisible();
    expect(operations(fake)).toHaveLength(1);
    await press("Change type");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toMatchObject({
        type: "number",
        config: { format: "number" },
      }),
    );
    toast.mockRestore();
  });

  it("does not change anything when the warning is cancelled", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await openEditor("Notes");
    await choose("Property type", "Checkbox");
    await press("Cancel");
    await expect
      .element(page.getByText("Values that cannot be converted are cleared."))
      .not.toBeInTheDocument();
    expect(fake.callsOf("updateSchema")).toHaveLength(0);
  });

  it("sets the number format", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await openEditor("Amount");
    await choose("Number format", "Percent");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toEqual({
        op: "updateProperty",
        propertyId: "amount",
        config: { format: "percent" },
      }),
    );
  });

  it("adds, recolors, reorders, and deletes options", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await openEditor("Tags");
    await userEvent.fill(page.getByRole("textbox", { name: "New option" }), "Docs");
    await userEvent.click(page.getByRole("button", { name: "Add option" }));
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toMatchObject({
        op: "addOption",
        propertyId: "tags",
        option: { name: "Docs" },
      }),
    );
    await userEvent.click(page.getByRole("button", { name: "Color of Bug" }));
    await userEvent.click(page.getByRole("radio", { name: "green" }));
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toEqual({
        op: "updateOption",
        propertyId: "tags",
        optionId: "bug",
        color: "green",
      }),
    );
    await userEvent.keyboard("{Escape}");
    page.getByRole("button", { name: "Reorder Bug" }).element().focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toMatchObject({
        op: "moveOption",
        optionId: "idea",
        beforeOptionId: "bug",
      }),
    );
    expect(
      (property(fake, "tags").config as { options: { id: string }[] }).options.map((o) => o.id),
    ).toEqual(["idea", "bug", expect.any(String)]);
    await userEvent.click(page.getByRole("button", { name: "Delete Idea" }));
    await expect.element(page.getByText("Rows lose this option.", { exact: false })).toBeVisible();
    await press("Delete option");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toEqual({
        op: "removeOption",
        propertyId: "tags",
        optionId: "idea",
      }),
    );
  });

  it("adds a status option to a group and picks the default", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await openEditor("Status");
    await userEvent.fill(page.getByRole("textbox", { name: "New In progress option" }), "Blocked");
    await userEvent.click(page.getByRole("button", { name: "Add In progress option" }));
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toMatchObject({
        op: "addOption",
        option: { name: "Blocked", group: "in_progress" },
      }),
    );
    await choose("Default option", "Done");
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toEqual({
        op: "updateProperty",
        propertyId: "status",
        config: { defaultOptionId: "done" },
      }),
    );
  });
});

describe("add property", () => {
  it("adds a typed property, shows it in the view, and opens its settings", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Number" }));
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toMatchObject({
        op: "addProperty",
        property: { name: "Property", type: "number", config: { format: "number" } },
      }),
    );
    const { id } = lastOperation(fake)!.property;
    await vi.waitFor(() =>
      expect((fake.callsOf("updateView").at(-1)!.input as any).properties.set).toEqual({
        [id]: { visible: true },
      }),
    );
    await expect.element(page.getByRole("dialog", { name: "Edit property" })).toBeVisible();
    await expect.element(page.getByRole("combobox", { name: "Number format" })).toBeVisible();
  });

  it("uses the typed name", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.fill(page.getByRole("textbox", { name: "New property name" }), "Owner");
    await userEvent.click(page.getByRole("menuitem", { name: "Checkbox" }));
    await vi.waitFor(() =>
      expect(lastOperation(fake)).toMatchObject({ property: { name: "Owner", type: "checkbox" } }),
    );
  });
});
