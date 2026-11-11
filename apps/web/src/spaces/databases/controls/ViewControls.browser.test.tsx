import { SpacePropertyId } from "@t2code/contracts/spaces";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { fixtureView } from "../test/fixtures";
import { EditableFakeDatabase } from "./controlsFake";
import { dragWithKeyboard } from "./keyboardDrag";

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

function setup(options: ConstructorParameters<typeof EditableFakeDatabase>[0] = {}) {
  const fake = new EditableFakeDatabase(options);
  state.fake = fake;
  const { controller } = fakeController();
  return { fake, host: testHost(controller) };
}
const TABLE = ["view-table"];
const lastView = (fake: EditableFakeDatabase) =>
  fake.callsOf("updateView").at(-1)?.input as Record<string, any> | undefined;

async function mount(options?: ConstructorParameters<typeof EditableFakeDatabase>[0]) {
  const { fake, host } = setup(options);
  const screen = await render(<DatabaseHarness host={host} initialViewIds={TABLE} />, {
    router: false,
  });
  return { fake, screen };
}
/** Switches have no layout without the app stylesheet, so a pointer click cannot reach them. */
const toggle = (name: string) =>
  vi.waitFor(() => (page.getByRole("switch", { name }).element() as HTMLElement).click());
const choose = async (trigger: string, option: string) => {
  await userEvent.click(page.getByRole("combobox", { name: trigger }));
  await userEvent.click(page.getByRole("option", { name: option, exact: true }));
};

describe("filter popover", () => {
  it("adds a rule, changes its operator, and commits the typed value after the debounce", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("button", { name: "Add rule" }));
    await vi.waitFor(() =>
      expect(lastView(fake)?.filter).toEqual({
        and: [{ property: "title", operator: "equals", value: "" }],
      }),
    );
    await choose("Filter operator", "Contains");
    await vi.waitFor(() => expect(lastView(fake)?.filter.and[0].operator).toBe("contains"));
    await userEvent.type(page.getByRole("textbox", { name: "Filter value" }), "bug");
    await vi.waitFor(() => expect(lastView(fake)?.filter.and[0].value).toBe("bug"));
    // The toolbar button shows the condition count once the view has it.
    await expect.element(page.getByRole("button", { name: "Filter 1" })).toBeVisible();
  });

  it("nests a group up to the depth limit, switches its connective, and removes it", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("button", { name: "Add rule" }));
    await userEvent.click(page.getByRole("button", { name: "Add group" }));
    await vi.waitFor(() =>
      expect(lastView(fake)?.filter.and[1]).toEqual({
        and: [{ property: "title", operator: "equals", value: "" }],
      }),
    );
    await choose("Connective", "Or");
    await vi.waitFor(() => expect(lastView(fake)?.filter.or).toHaveLength(2));
    // maxFilterDepth is 3: a group inside the group fits, one more does not.
    await userEvent.click(page.getByRole("button", { name: "Add group" }).first());
    await vi.waitFor(() => expect(lastView(fake)?.filter.or[1].and[1].and).toHaveLength(1));
    // Only the root and the first nested group can still take a group.
    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Add group" }).elements()).toHaveLength(2),
    );
    await userEvent.click(page.getByRole("button", { name: "Remove group" }).last());
    await vi.waitFor(() => expect(lastView(fake)?.filter.or).toHaveLength(1));
  });

  it("turns a rule into a group and removes the last rule to clear the filter", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("button", { name: "Add rule" }));
    await userEvent.click(page.getByRole("button", { name: "Rule options" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Turn into group" }));
    await vi.waitFor(() => expect(lastView(fake)?.filter.and[0].and).toHaveLength(1));
    await userEvent.click(page.getByRole("button", { name: "Rule options" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Remove" }));
    await vi.waitFor(() => expect(lastView(fake)?.filter).toBeNull());
  });

  it("disables the controls with a hint without edit permission", async () => {
    const { screen } = await mount({ permissions: { views: false } });
    await using _screen = screen;
    for (const name of ["Filter", "Sort", "Group", "Properties"])
      await expect.element(page.getByRole("button", { name })).toBeDisabled();
  });
});

describe("sort popover", () => {
  it("adds, reorders from the keyboard, changes direction, and removes sorts", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Sort" }));
    await userEvent.click(page.getByRole("button", { name: "Add sort" }));
    await userEvent.click(page.getByRole("button", { name: "Add sort" }));
    await vi.waitFor(() => expect(lastView(fake)?.sorts).toHaveLength(2));
    const [first, second] = lastView(fake)!.sorts as { property: string }[];
    await dragWithKeyboard(/Reorder/, "{ArrowDown}");
    await vi.waitFor(() =>
      expect(
        (lastView(fake)!.sorts as { property: string }[]).map((sort) => sort.property),
      ).toEqual([second!.property, first!.property]),
    );
    await choose("Direction of Status", "Descending");
    await vi.waitFor(() => expect(lastView(fake)?.sorts[0].direction).toBe("descending"));
    await userEvent.click(page.getByRole("button", { name: "Delete sort" }));
    await vi.waitFor(() => expect(lastView(fake)?.sorts).toEqual([]));
  });
});

describe("group popover", () => {
  it("groups by a property, hides a group, and removes the grouping", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Group" }));
    await choose("Group property", "Status");
    await vi.waitFor(() =>
      expect(lastView(fake)?.group).toEqual({ property: "status", by: "option" }),
    );
    await choose("Grouping", "Group");
    await vi.waitFor(() => expect(lastView(fake)?.group.by).toBe("status_group"));
    await toggle("Show Complete");
    await vi.waitFor(() =>
      expect(lastView(fake)?.group.hidden).toEqual([{ kind: "status_group", group: "complete" }]),
    );
    await toggle("Hide empty groups");
    await vi.waitFor(() => expect(lastView(fake)?.group.hideEmpty).toBe(true));
    await userEvent.click(page.getByRole("button", { name: "Remove grouping" }));
    await vi.waitFor(() => expect(lastView(fake)?.group).toBeNull());
  });
});

describe("properties popover", () => {
  it("hides and shows a property, reorders, and restores a deleted one", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    fake.dataSource = {
      ...fake.dataSource,
      deletedProperties: [
        { id: SpacePropertyId.make("old"), name: "Old", type: "text", deletedAt: "t" },
      ],
    };
    await userEvent.click(page.getByRole("button", { name: "Properties" }));
    await toggle("Show Notes");
    await vi.waitFor(() =>
      expect(lastView(fake)?.properties.set).toEqual({ notes: { visible: false } }),
    );
    await expect.element(screen.getByRole("button", { name: "Notes" })).not.toBeInTheDocument();
    await toggle("Show Notes");
    await expect.element(screen.getByRole("button", { name: "Notes" })).toBeVisible();
    await dragWithKeyboard("Reorder Status", "{ArrowDown}");
    await vi.waitFor(() =>
      expect(lastView(fake)?.properties.order.slice(0, 3)).toEqual(["title", "tags", "status"]),
    );
    await userEvent.click(page.getByRole("button", { name: "Restore Old" }));
    await vi.waitFor(() =>
      expect(fake.callsOf("updateSchema").at(-1)?.input.operations).toEqual([
        { op: "restoreProperty", propertyId: "old" },
      ]),
    );
  });
});

describe("layout popover", () => {
  it("edits the layout of the active view and keeps the keys it does not touch", async () => {
    const { fake, host } = setup({
      views: [fixtureView("view-list", "list", "List", 0, { showPropertyNames: true })],
    });
    await using _screen = await render(
      <DatabaseHarness host={host} initialViewIds={["view-list"]} />,
      { router: false },
    );
    await userEvent.click(page.getByRole("button", { name: "Layout" }));
    await toggle("Show property names");
    await vi.waitFor(() => expect(lastView(fake)?.layout).toEqual({ showPropertyNames: false }));
    await choose("Open pages in", "Full page");
    await vi.waitFor(() =>
      expect(lastView(fake)?.layout).toEqual({
        showPropertyNames: false,
        openPagesIn: "full_page",
      }),
    );
  });
});
