import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { computedFake } from "../test/computedFixtures";
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
  default: (await import("../controls/controlsStub")).default,
}));

async function openEditor(options: Parameters<typeof computedFake>[0] = {}) {
  const fake = computedFake(options);
  state.fake = fake;
  const { controller } = fakeController();
  const screen = await render(
    <DatabaseHarness host={testHost(controller)} initialViewIds={["view-table"]} />,
    { router: false },
  );
  return readyWhen(
    { fake, screen, input: page.getByRole("combobox", { name: "Formula" }) },
    async () => {
      await userEvent.click(page.getByRole("button", { name: "Double", exact: true }));
      await userEvent.click(page.getByRole("menuitem", { name: "Edit property" }));
      await userEvent.click(page.getByRole("button", { name: "Edit formula" }));
      await expect
        .element(page.getByRole("dialog", { name: "Edit formula: Double" }))
        .toBeVisible();
    },
  );
}

/** Dialogs sit under an inert guard that blocks pointer hits; a DOM click is what Enter does. */
const press = (name: string) =>
  vi.waitFor(() => {
    const button = page.getByRole("button", { name, exact: true }).element() as HTMLButtonElement;
    // Save stays disabled until the check of the typed formula lands; a click before that is lost.
    expect(button.disabled).toBe(false);
    button.click();
  });
const schemaCalls = (fake: ReturnType<typeof computedFake>) => fake.callsOf("updateSchema");

describe("formula editor", () => {
  it("completes a property by keyboard, then saves the expression", async () => {
    const { fake, screen, input } = await openEditor();
    await using _screen = screen;
    await userEvent.fill(input, 'prop("Am');
    await expect.element(page.getByRole("option", { name: /Amount/ })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(input).toHaveValue('prop("Amount"');
    await userEvent.keyboard(") + 1");
    await expect.element(page.getByText("Result: number")).toBeVisible();
    await press("Save");
    await vi.waitFor(() =>
      expect(schemaCalls(fake).at(-1)?.input.operations).toEqual([
        { op: "updateProperty", propertyId: "dbl", config: { expression: 'prop("Amount") + 1' } },
      ]),
    );
    await expect
      .element(page.getByRole("dialog", { name: "Edit formula: Double" }))
      .not.toBeInTheDocument();
  });

  it("shows an inline error while typing, blocks saving, and clears it once fixed", async () => {
    const { screen, input } = await openEditor();
    await using _screen = screen;
    await userEvent.fill(input, 'prop("Nope")');
    await expect.element(page.getByText(/There is no property named "Nope"\./)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await userEvent.fill(input, 'prop("Amount")');
    await expect
      .element(page.getByText(/There is no property named "Nope"\./))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });

  it("previews the result on the first row and follows the text", async () => {
    const { screen, input } = await openEditor();
    await using _screen = screen;
    await expect.element(page.getByTestId("formula-preview")).toHaveTextContent("10");
    await userEvent.fill(input, 'prop("Amount") + 1');
    await expect.element(page.getByTestId("formula-preview")).toHaveTextContent("6");
  });

  it("ignores Enter while an IME composition is in progress", async () => {
    const { screen, input } = await openEditor();
    await using _screen = screen;
    await userEvent.fill(input, "pro");
    await expect.element(page.getByRole("option", { name: /prop/ })).toBeVisible();
    const textarea = input.element();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input).toHaveValue("pro");
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    const { fake, screen, input } = await openEditor();
    await using _screen = screen;
    fake.failNext.set("updateSchema", {
      _tag: "SpaceDatabaseError",
      reason: "invalid_property_config",
      detail: "1:1 The server disagrees.",
    });
    await userEvent.fill(input, 'prop("Amount") * 3');
    await press("Save");
    await expect.element(page.getByText(/The server disagrees\./)).toBeVisible();
    await expect.element(page.getByRole("dialog", { name: "Edit formula: Double" })).toBeVisible();
    await userEvent.fill(input, 'prop("Amount") * 4');
    await expect.element(page.getByText(/The server disagrees\./)).not.toBeInTheDocument();
  });

  it("closes the suggestions on the first Escape and asks before discarding edits on the second", async () => {
    const { screen, input } = await openEditor();
    await using _screen = screen;
    await userEvent.fill(input, "pro");
    await expect.element(page.getByRole("listbox", { name: "Suggestions" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("listbox", { name: "Suggestions" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog", { name: "Edit formula: Double" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Discard changes?")).toBeVisible();
    await press("Keep editing");
    await expect.element(page.getByRole("dialog", { name: "Edit formula: Double" })).toBeVisible();
    await press("Cancel");
    await press("Discard");
    await expect
      .element(page.getByRole("dialog", { name: "Edit formula: Double" }))
      .not.toBeInTheDocument();
  });

  it("inserts a property from the reference panel at the caret", async () => {
    const { screen, input } = await openEditor();
    await using _screen = screen;
    await userEvent.fill(input, "1 + ");
    await vi.waitFor(() =>
      (page.getByRole("button", { name: /^Amount/ }).element() as HTMLElement).click(),
    );
    await expect.element(input).toHaveValue('1 + prop("Amount")');
  });
});
