import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { computedFake } from "../test/computedFixtures";
import { fixtureOtherDatabase } from "../test/fixtures";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";

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

function projectsDatabase() {
  const projects = fixtureOtherDatabase("projects", "Projects", ["Alpha"]);
  return {
    ...projects,
    dataSource: {
      ...projects.dataSource,
      properties: {
        ...projects.dataSource.properties,
        budget: {
          id: "budget",
          name: "Budget",
          type: "number",
          config: { format: "number" },
          position: 1,
        },
        start: { id: "start", name: "Start", type: "date", config: {}, position: 2 },
      },
    },
  } as never;
}

async function mount(options: Parameters<typeof computedFake>[0] = {}) {
  const fake = computedFake(options);
  state.fake = fake;
  const { controller } = fakeController();
  const screen = await render(
    <DatabaseHarness host={testHost(controller)} initialViewIds={["view-table"]} />,
    { router: false },
  );
  return { fake, screen };
}
const withRelation = {
  extra: {
    project: {
      id: "project",
      name: "Project",
      type: "relation",
      config: { dataSourceId: "projects-source", limit: "many" },
      position: 8,
    },
  },
  others: [projectsDatabase()],
};
const choose = async (trigger: string, option: string) => {
  await userEvent.click(page.getByRole("combobox", { name: trigger }));
  await userEvent.click(page.getByRole("option", { name: option, exact: true }));
};
const optionNames = () =>
  Array.from(document.querySelectorAll('[role="listbox"] [role="option"]'), (option) =>
    option.textContent?.trim(),
  );
const lastOperations = (fake: ReturnType<typeof computedFake>) =>
  fake.callsOf("updateSchema").at(-1)?.input.operations as Record<string, any>[] | undefined;
const lastView = (fake: ReturnType<typeof computedFake>) =>
  fake.callsOf("updateView").at(-1)?.input as Record<string, any> | undefined;

describe("rollup configuration", () => {
  it("cannot add a rollup before there is a relation", async () => {
    const { screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await expect.element(page.getByRole("menuitem", { name: /Rollup/ })).toBeDisabled();
    await expect.element(page.getByText("Needs a relation")).toBeVisible();
  });

  it("starts on the first relation and offers only the functions valid for the target type", async () => {
    const { fake, screen } = await mount(withRelation);
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Rollup/ }));
    await vi.waitFor(() =>
      expect(lastOperations(fake)).toMatchObject([
        {
          op: "addProperty",
          property: {
            type: "rollup",
            config: {
              relationPropertyId: "project",
              targetPropertyId: "title",
              function: "show_original",
            },
          },
        },
      ]),
    );
    // A text target has the generic functions only.
    await userEvent.click(page.getByRole("combobox", { name: "Rollup calculation" }));
    await vi.waitFor(() => expect(optionNames()).toContain("Count values"));
    expect(optionNames()).not.toContain("Sum");
    await userEvent.keyboard("{Escape}");

    await choose("Rollup property", "Budget");
    await vi.waitFor(() =>
      expect(lastOperations(fake)?.[0]?.config).toMatchObject({
        targetPropertyId: "budget",
        function: "show_original",
      }),
    );
    await userEvent.click(page.getByRole("combobox", { name: "Rollup calculation" }));
    await vi.waitFor(() => expect(optionNames()).toContain("Sum"));
    expect(optionNames()).not.toContain("Earliest date");
    await userEvent.click(page.getByRole("option", { name: "Sum", exact: true }));
    await vi.waitFor(() => expect(lastOperations(fake)?.[0]?.config.function).toBe("sum"));
    // A number result offers a number format.
    await expect.element(page.getByRole("combobox", { name: "Number format" })).toBeVisible();

    await choose("Rollup property", "Start");
    await userEvent.click(page.getByRole("combobox", { name: "Rollup calculation" }));
    await vi.waitFor(() => expect(optionNames()).toContain("Earliest date"));
    expect(optionNames()).not.toContain("Sum");
    // The chosen function was not valid for a date, so it went back to showing the original.
    expect(lastOperations(fake)?.[0]?.config.function).toBe("show_original");
  });
});

describe("computed properties in view controls", () => {
  it("finds a relation target that is only on a later page of the database list", async () => {
    const { fake, screen } = await mount({ ...withRelation, listLimit: 1 });
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Rollup/ }));
    await choose("Rollup property", "Budget");
    await vi.waitFor(() =>
      expect(lastOperations(fake)?.[0]?.config).toMatchObject({ targetPropertyId: "budget" }),
    );
    expect(fake.callsOf("listPage").length).toBeGreaterThan(0);
  });

  it("filters a number formula with number operators", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("button", { name: "Add rule" }));
    await choose("Filter property", "Double");
    await vi.waitFor(() =>
      expect(lastView(fake)?.filter.and[0]).toEqual({
        property: "dbl",
        operator: "equals",
        value: 0,
      }),
    );
    await userEvent.click(page.getByRole("combobox", { name: "Filter operator" }));
    await vi.waitFor(() => expect(optionNames()).toContain("≥"));
    expect(optionNames()).not.toContain("Contains");
    await userEvent.click(page.getByRole("option", { name: ">", exact: true }));
    await userEvent.fill(page.getByRole("spinbutton", { name: "Filter value" }), "12");
    await vi.waitFor(() =>
      expect(lastView(fake)?.filter.and[0]).toEqual({
        property: "dbl",
        operator: "greater_than",
        value: 12,
      }),
    );
  });

  it("lists a formula that uses now() as disabled, with the reason", async () => {
    const { screen } = await mount({
      extra: {
        now: {
          id: "now",
          name: "Now",
          type: "formula",
          config: { expression: "now()" },
          position: 9,
        },
      },
    });
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("button", { name: "Add rule" }));
    await userEvent.click(page.getByRole("combobox", { name: "Filter property" }));
    await expect
      .element(page.getByText("Uses now() or today(), so it can't be filtered or sorted").first())
      .toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /^Now/ }))
      .toHaveAttribute("aria-disabled", "true");
  });
});
