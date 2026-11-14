import "../../../../test/renderCounter";
import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { startCounting, stopCounting } from "../../../../test/renderCounter";
import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { mountTable } from "./tableHarness";

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

async function mount(options: ConstructorParameters<typeof FakeDatabase>[0] = { rows: 30 }) {
  const fake = new FakeDatabase({ quietRowWrites: true, ...options });
  state.fake = fake;
  // Wide enough that every column of the fixture is inside the column window.
  await page.viewport(1800, 900);
  const table = await readyWhen(await mountTable(fake), (mounted) =>
    vi.waitFor(() => expect(mounted.cell("row-1", "title")).not.toBeNull()),
  );
  return { fake, ...table };
}
const locate = (element: HTMLElement | null) => page.elementLocator(element!);
const focused = () => {
  const { row, col } = (document.activeElement as HTMLElement).dataset;
  return row === undefined ? null : `${row}:${col}`;
};
const writes = (fake: FakeDatabase) =>
  fake.callsOf("updateRows").map((call) => call.input.rows as unknown[]);
// Whether edits share a batch depends on timing; the writer's own tests cover batching.
const written = (fake: FakeDatabase, pageId: string) =>
  Object.assign(
    {},
    ...writes(fake)
      .flat()
      .filter((row) => (row as { pageId: string }).pageId === pageId)
      .map((row) => (row as { cells: object }).cells),
  );

describe("text editing", () => {
  it("edits a title in place, keeps the new value after the write lands and does not requery", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "title")));
    const input = screen.getByRole("textbox", { name: "Name" });
    await expect.element(input).toHaveFocus();
    await userEvent.fill(input, "Renamed");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(cell("row-1", "title")?.textContent).toContain("Renamed");
    expect(focused()).toBe("row-1:title");
    await vi.waitFor(() => expect(writes(fake)).toHaveLength(1));
    expect(writes(fake)[0]).toEqual([{ pageId: "row-1", cells: { title: "Renamed" } }]);
    const queries = fake.callsOf("query").length;
    // The write was acknowledged: the loaded row holds the value and nothing is fetched again.
    await vi.waitFor(() => expect(cell("row-1", "title")?.textContent).toContain("Renamed"));
    expect(fake.callsOf("query")).toHaveLength(queries);
  });

  it("cancels with Escape and writes nothing", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-2", "title")));
    await userEvent.keyboard("changed{Escape}");
    await expect.element(screen.getByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(cell("row-2", "title")?.textContent).toContain("Task 2");
    expect(focused()).toBe("row-2:title");
    expect(fake.callsOf("updateRows")).toHaveLength(0);
  });

  it("commits on blur and leaves focus where the click put it", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "title")));
    await userEvent.keyboard("A");
    await userEvent.click(locate(cell("row-3", "notes")));
    await vi.waitFor(() => expect(writes(fake)).toHaveLength(1));
    expect(writes(fake)[0]).toEqual([{ pageId: "row-1", cells: { title: "Task 1A" } }]);
    // The click also started editing the notes cell of row 3.
    await expect.element(screen.getByRole("textbox", { name: "Notes" })).toHaveFocus();
  });

  it("parses numbers and keeps the old value for text that is not a number", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "amount")));
    await userEvent.fill(screen.getByRole("textbox", { name: "Amount" }), "1,234.5");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(locate(cell("row-2", "amount")));
    await userEvent.fill(screen.getByRole("textbox", { name: "Amount" }), "abc");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(writes(fake)).toHaveLength(1));
    expect(writes(fake)[0]).toEqual([{ pageId: "row-1", cells: { amount: 1234.5 } }]);
  });

  it("writes text as one unmarked run", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "notes")));
    await userEvent.fill(screen.getByRole("textbox", { name: "Notes" }), "hello");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(writes(fake)).toHaveLength(1));
    expect(writes(fake)[0]).toEqual([
      { pageId: "row-1", cells: { notes: [{ text: "hello", marks: [] }] } },
    ]);
  });
});

describe("render cost", () => {
  it("typing renders no row, committing renders only the edited row, moving focus renders none", async () => {
    const { fake, screen, cell } = await mount({ rows: 60 });
    await using _screen = screen;
    await userEvent.click(locate(cell("row-1", "notes")));
    await expect.element(screen.getByRole("textbox", { name: "Notes" })).toHaveFocus();

    startCounting();
    await userEvent.keyboard("abcdef");
    const typing = stopCounting();
    expect(typing.components["TableRow"] ?? 0).toBe(0);
    expect(typing.components["TableCell"] ?? 0).toBe(0);
    expect(typing.components["TextEditor"]).toBeGreaterThan(0);

    startCounting();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(cell("row-1", "notes")?.textContent).toContain("abcdef"));
    const committing = stopCounting();
    // About 26 rows are mounted: only the edited row gets a new identity (once for the queued
    // edit, once when the acknowledged value is folded into the loaded rows), and its other
    // cells bail out.
    expect(committing.components["TableRow"]).toBeLessThanOrEqual(2);
    expect(committing.components["TableCell"]).toBeLessThanOrEqual(4);
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));

    cell("row-5", "title")!.focus();
    await vi.waitFor(() => expect(focused()).toBe("row-5:title"));
    startCounting();
    await userEvent.keyboard("{ArrowDown}{ArrowRight}{ArrowDown}");
    const moving = stopCounting();
    expect(focused()).toBe("row-7:status");
    expect(moving.components["TableRow"] ?? 0).toBe(0);
    expect(moving.components["TableCell"] ?? 0).toBe(0);
  });
});

describe("keyboard", () => {
  it("moves with arrows, Tab and Home or End, and wraps rows", async () => {
    const { screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "title")!.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(focused()).toBe("row-1:tags");
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe("row-2:tags");
    await userEvent.keyboard("{Home}");
    expect(focused()).toBe("row-2:title");
    await userEvent.keyboard("{End}");
    expect(focused()).toBe("row-2:amount");
    await userEvent.keyboard("{Tab}");
    expect(focused()).toBe("row-3:title");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(focused()).toBe("row-2:amount");
    await userEvent.keyboard("{Control>}{Home}{/Control}");
    expect(focused()).toBe("row-1:title");
  });

  it("starts editing with Enter, or with a typed character that seeds the editor", async () => {
    const { screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "notes")!.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("textbox", { name: "Notes" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    cell("row-2", "notes")!.focus();
    await userEvent.keyboard("xyz");
    await expect.element(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("xyz");
  });

  it("ignores Enter while an IME composition is active", async () => {
    const { screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "title")!.focus();
    await userEvent.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "Name" });
    await expect.element(input).toHaveFocus();
    input
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      );
    await expect.element(input).toBeVisible();
  });

  it("commits with Tab and moves right, with Shift+Tab and moves left", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "notes")!.focus();
    await userEvent.keyboard("{Enter}one{Tab}");
    expect(focused()).toBe("row-1:amount");
    await userEvent.keyboard("{Enter}5{Shift>}{Tab}{/Shift}");
    expect(focused()).toBe("row-1:notes");
    await vi.waitFor(() =>
      expect(written(fake, "row-1")).toEqual({ notes: [{ text: "one", marks: [] }], amount: 5 }),
    );
  });

  it("clears a writable cell with Backspace", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "status")!.focus();
    await userEvent.keyboard("{Backspace}");
    await vi.waitFor(() => expect(written(fake, "row-1")).toEqual({ status: null }));
  });

  it("swallows page shortcuts on a cell so they never reach the document", async () => {
    const { screen, cell } = await mount();
    await using _screen = screen;
    cell("row-1", "title")!.focus();
    const seen: boolean[] = [];
    for (const key of ["z", "a", "b", "i", "u"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      cell("row-1", "title")!.dispatchEvent(event);
      seen.push(event.defaultPrevented);
    }
    expect(seen).toEqual([true, true, true, true, true]);
  });
});

describe("checkbox", () => {
  it("toggles on click and on Space", async () => {
    const { fake, screen, cell } = await mount();
    await using _screen = screen;
    // row-1 starts checked (even rows), row-2 unchecked
    await userEvent.click(locate(cell("row-2", "done")));
    cell("row-1", "done")!.focus();
    await userEvent.keyboard(" ");
    await vi.waitFor(() => expect(writes(fake)).toHaveLength(1));
    const batch = writes(fake)[0] as { pageId: string; cells: Record<string, unknown> }[];
    expect(batch).toEqual(
      expect.arrayContaining([
        { pageId: "row-2", cells: { done: true } },
        { pageId: "row-1", cells: { done: null } },
      ]),
    );
    await expect
      .element(cell("row-2", "done")!.querySelector('[role="checkbox"]') as HTMLElement)
      .toHaveAttribute("aria-checked", "true");
  });
});
