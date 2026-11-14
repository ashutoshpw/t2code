import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { DatabaseHarness, fakeController, testHost } from "../test/harness";
import { FakeDatabase } from "../test/fakeDatabase";
import { fixtureView } from "../test/fixtures";

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

const QUESTIONS = [{ propertyId: "title", required: true }, { propertyId: "status" }];

async function mount(options: ConstructorParameters<typeof FakeDatabase>[0] = {}) {
  const view = fixtureView("view-form", "form" as never, "Feedback", 0, {
    questions: QUESTIONS,
  });
  const fake = new FakeDatabase({ quietRowWrites: true, ...options, views: [view] });
  state.fake = fake;
  await page.viewport(1200, 900);
  const { controller } = fakeController();
  const screen = await render(
    <DatabaseHarness
      host={testHost(controller)}
      initialViewIds={[view.id]}
      layout="page"
      editable={options.permissions?.views !== false}
    />,
  );
  return { fake, screen };
}

const layoutOf = (fake: FakeDatabase) =>
  (fake.views[0] as unknown as { layout: { questions: Array<{ propertyId: string }> } }).layout;

describe("FormView", () => {
  it("creates one row from a double submit, with the title and the option id", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await userEvent.fill(screen.getByRole("textbox", { name: /Name/ }), "Ada");
    await userEvent.click(screen.getByRole("radio", { name: "In progress" }));
    await userEvent.dblClick(screen.getByRole("button", { name: "Submit" }));
    await expect.element(screen.getByText("Response recorded")).toBeVisible();
    const creates = fake.calls.filter((call) => call.method === "createRows");
    expect(creates).toHaveLength(1);
    expect(JSON.stringify(creates[0]!.input)).toContain('"title":"Ada"');
    expect(JSON.stringify(creates[0]!.input)).toContain('"status":"doing"');
  });

  it("blocks submit while a required question is empty", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Preview" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    await expect.element(screen.getByText("Answer this question.")).toBeVisible();
    expect(fake.calls.some((call) => call.method === "createRows")).toBe(false);
  });

  it("adds a question and reorders with the keyboard, writing layout.questions", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Add question" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Notes" }));
    await vi.waitFor(() =>
      expect(layoutOf(fake).questions.map((q) => q.propertyId)).toEqual([
        "title",
        "status",
        "notes",
      ]),
    );
    const handle = screen.getByRole("button", { name: "Reorder Notes" });
    await handle.click();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await vi.waitFor(() =>
      expect(layoutOf(fake).questions.map((q) => q.propertyId)).toEqual([
        "title",
        "notes",
        "status",
      ]),
    );
  });

  it("shows only the fill form to a viewer without view permission", async () => {
    const { screen } = await mount({ permissions: { views: false } as never });
    await using _screen = screen;
    await expect.element(screen.getByRole("button", { name: "Submit" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview" }).elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add question" }).elements()).toHaveLength(0);
  });
});
