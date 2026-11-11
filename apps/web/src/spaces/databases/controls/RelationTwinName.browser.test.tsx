import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { fixtureOtherDatabase } from "../test/fixtures";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { EditableFakeDatabase } from "../test/editableDatabase";
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
vi.mock(import("../table/TableView"), async () => ({
  default: (await import("./controlsStub")).default,
}));

describe("related property name", () => {
  it("refuses a name the target already uses before anything is sent", async () => {
    const fake = new EditableFakeDatabase({
      others: [fixtureOtherDatabase("projects", "Projects", ["Alpha"])],
    });
    state.fake = fake;
    const { controller } = fakeController();
    const { screen } = await readyWhen(
      {
        screen: await render(
          <DatabaseHarness host={testHost(controller)} initialViewIds={["view-table"]} />,
          { router: false },
        ),
      },
      () => expect.element(page.getByRole("button", { name: "Add property" })).toBeVisible(),
    );
    await using _screen = screen;
    await userEvent.click(page.getByRole("button", { name: "Add property" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Relation" }));
    await userEvent.click(page.getByRole("option", { name: "Projects" }));
    await userEvent.click(page.getByRole("switch", { name: "Show on Projects" }));
    await userEvent.fill(page.getByRole("textbox", { name: "Related property name" }), "name");
    await expect
      .element(page.getByText("Projects already has a property with this name."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add relation" })).toBeDisabled();
    expect(fake.callsOf("updateSchema")).toHaveLength(0);
    await userEvent.fill(page.getByRole("textbox", { name: "Related property name" }), "Linked");
    await expect.element(page.getByRole("button", { name: "Add relation" })).toBeEnabled();
  });
});
