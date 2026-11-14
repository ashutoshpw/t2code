import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
import { readyWhen } from "../test/readyWhen";

import { mountBoard } from "./boardHarness";

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

async function mount(options: ConstructorParameters<typeof FakeDatabase>[0] = {}) {
  const fake = new FakeDatabase({ quietRowWrites: true, rows: 7, ...options });
  state.fake = fake;
  await page.viewport(1400, 900);
  const board = await readyWhen(await mountBoard(fake), (mounted) =>
    vi.waitFor(() => expect(mounted.card("row-1")).not.toBeNull()),
  );
  return { fake, ...board };
}

const press = (key: string) => userEvent.keyboard(key);

describe("columns", () => {
  it("renders a column per group with its count and cards", async () => {
    const { screen, cardsIn, column } = await mount();
    await using _screen = screen;
    expect(cardsIn("Not started")).toEqual(["row-1", "row-4", "row-7"]);
    expect(cardsIn("In progress")).toEqual(["row-2", "row-5"]);
    expect(cardsIn("Done")).toEqual(["row-3", "row-6"]);
    expect(column("Not started").querySelector("header")!.textContent).toContain("3");
    expect(column("No Status").querySelector("header")!.textContent).toContain("0");
    // The grouping property is the column; other values show on the card.
    expect(column("Done").textContent).not.toContain("Not started");
  });

  it("opens the row when a card is clicked", async () => {
    const { screen, host } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByText("Task 2"));
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-2" }));
  });

  it("loads the rest of a column through its own scope", async () => {
    const { fake, screen, cardsIn } = await mount({ rows: 100 });
    await using _screen = screen;
    expect(cardsIn("Not started")).toHaveLength(25);
    const before = fake.callsOf("query").length;
    await userEvent.click(
      screen
        .getByRole("region", { name: "Not started" })
        .getByRole("button", { name: "Load more" }),
    );
    await vi.waitFor(() => expect(cardsIn("Not started")).toHaveLength(34));
    const scoped = fake.callsOf("query").slice(before);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.input).toMatchObject({ scope: { group: { optionId: "todo" } } });
    expect(cardsIn("In progress")).toHaveLength(25);
  });
});

describe("dragging", () => {
  it("moves a card to another column by keyboard and writes the cell", async () => {
    const { fake, screen, cardsIn, card } = await mount();
    await using _screen = screen;
    card("row-1")!.querySelector("button")!.focus();
    await press(" ");
    await vi.waitFor(() => expect(document.querySelector("[aria-live]")).not.toBeNull());
    await press("{ArrowRight}");
    await press(" ");
    await vi.waitFor(() => expect(cardsIn("In progress")).toContain("row-1"));
    expect(cardsIn("Not started")).not.toContain("row-1");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("updateRows")[0]!.input).toMatchObject({
      rows: [{ pageId: "row-1", cells: { status: "doing" } }],
    });
    expect(fake.callsOf("moveRows")).toHaveLength(1);
  });

  it("drops a card on another column with the pointer and shows it there at once", async () => {
    const { fake, screen, cardsIn, card, column } = await mount();
    await using _screen = screen;
    const source = card("row-1")!.querySelector("button")!.getBoundingClientRect();
    const target = column("Done").getBoundingClientRect();
    const fire = (type: string, x: number, y: number, element: EventTarget) =>
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
          clientX: x,
          clientY: y,
        }),
      );
    const x = source.left + 20;
    const y = source.top + 10;
    fire("pointerdown", x, y, card("row-1")!.querySelector("button")!);
    fire("pointermove", x + 8, y, document);
    // The overlay measures itself once mounted; moving before that would count the delta twice.
    await vi.waitFor(() =>
      expect(document.querySelector('[style*="z-index: 999"]')).not.toBeNull(),
    );
    fire("pointermove", target.left + 40, target.top + 60, document);
    fire("pointermove", target.left + 42, target.top + 62, document);
    await vi.waitFor(() => expect(column("Done").className).toContain("ring-2"));
    // The line is painted inside the card's contained box, not outside where it would be clipped.
    await vi.waitFor(() => {
      const marked = document.querySelector<HTMLElement>("[data-drop-before],[data-drop-after]");
      expect(marked).not.toBeNull();
      const pseudo = getComputedStyle(
        marked!,
        marked!.hasAttribute("data-drop-before") ? "::before" : "::after",
      );
      expect(pseudo.position).toBe("absolute");
      expect(pseudo.height).toBe("2px");
      expect(marked!.hasAttribute("data-drop-before") ? pseudo.top : pseudo.bottom).toBe("0px");
      expect(pseudo.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    });
    fire("pointerup", target.left + 42, target.top + 62, document);
    await vi.waitFor(() => expect(cardsIn("Done")).toContain("row-1"));
    expect(cardsIn("Not started")).toEqual(["row-4", "row-7"]);
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("updateRows")[0]!.input).toMatchObject({
      rows: [{ pageId: "row-1", cells: { status: "done" } }],
    });
  });

  it("reorders inside a column with moveRows only and no cell write", async () => {
    const { fake, screen, card } = await mount();
    await using _screen = screen;
    card("row-1")!.querySelector("button")!.focus();
    await press(" ");
    await press("{ArrowDown}");
    await press(" ");
    await vi.waitFor(() => expect(fake.callsOf("moveRows")).toHaveLength(1));
    expect(fake.callsOf("moveRows")[0]!.input).toMatchObject({
      pageIds: ["row-1"],
      beforeRowId: "row-7",
    });
    expect(fake.callsOf("updateRows")).toHaveLength(0);
  });

  it("puts the card back when the in-column move is refused", async () => {
    const { fake, screen, card, cardsIn } = await mount();
    await using _screen = screen;
    fake.failNext.set("moveRows", { _tag: "SpaceDatabaseError", reason: "not_found" });
    card("row-1")!.querySelector("button")!.focus();
    await press(" ");
    await press("{ArrowDown}");
    await press(" ");
    await vi.waitFor(() => expect(fake.callsOf("moveRows")).toHaveLength(1));
    await vi.waitFor(() => expect(cardsIn("Not started")).toEqual(["row-1", "row-4", "row-7"]));
  });

  it("does not reorder inside a column when the view has sorts", async () => {
    const fake = new FakeDatabase({ quietRowWrites: true, rows: 7 });
    fake.views = fake.views.map((view) => ({
      ...view,
      sorts: [{ property: "title", direction: "ascending" }],
    })) as never;
    state.fake = fake;
    await page.viewport(1400, 900);
    const board = await mountBoard(fake);
    await using _screen = board.screen;
    await vi.waitFor(() => expect(board.card("row-1")).not.toBeNull());
    board.card("row-1")!.querySelector("button")!.focus();
    await press(" ");
    await press("{ArrowRight}");
    await press(" ");
    await vi.waitFor(() => expect(fake.callsOf("updateRows")).toHaveLength(1));
    expect(fake.callsOf("moveRows")).toHaveLength(0);
  });

  it("reorders columns by keyboard and writes a manual group order", async () => {
    const { fake, screen } = await mount();
    await using _screen = screen;
    screen.getByRole("button", { name: "Move In progress column" }).element().focus();
    await press(" ");
    await press("{ArrowLeft}");
    await press(" ");
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    expect(fake.callsOf("updateView")[0]!.input).toMatchObject({
      group: {
        property: "status",
        sort: "manual",
        order: [
          { kind: "option", optionId: "doing" },
          { kind: "option", optionId: "todo" },
          { kind: "option", optionId: "done" },
        ],
      },
    });
  });
});

describe("new cards", () => {
  it("creates a card with the column's value and opens it", async () => {
    const { fake, screen, host } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Add a card to In progress" }));
    await vi.waitFor(() => expect(fake.callsOf("createRows")).toHaveLength(1));
    expect(fake.callsOf("createRows")[0]!.input).toMatchObject({
      rows: [{ cells: { status: "doing" } }],
    });
    await vi.waitFor(() => expect(host.openPage).toHaveBeenCalled());
    await expect
      .element(screen.getByRole("region", { name: "In progress" }).getByText("Untitled"))
      .toBeVisible();
  });
});

describe("hidden groups", () => {
  it("hides a group from its menu and shows it again", async () => {
    const { fake, screen, cardsIn } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Done options" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide group" }));
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    expect(fake.callsOf("updateView")[0]!.input).toMatchObject({
      group: { hidden: [{ kind: "option", optionId: "done" }] },
    });
    await expect
      .element(screen.getByRole("complementary", { name: "Hidden groups" }))
      .toBeVisible();
    expect(screen.container.querySelector('[data-column-id][aria-label="Done"]')).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show Done" }));
    await vi.waitFor(() => expect(cardsIn("Done")).toEqual(["row-3", "row-6"]));
    expect(fake.callsOf("updateView")[1]!.input).toMatchObject({ group: { hidden: [] } });
  });
});

describe("read-only", () => {
  it("offers no drag, add or hide without permission", async () => {
    const { screen, card } = await mount({
      permissions: { cells: false, rows: false, views: false },
    });
    await using _screen = screen;
    expect(card("row-1")!.querySelector("button")!.hasAttribute("aria-roledescription")).toBe(
      false,
    );
    expect(screen.container.querySelector('[aria-label^="Add a card"]')).toBeNull();
    expect(screen.container.querySelector('[aria-label$="options"]')).toBeNull();
    expect(screen.container.querySelector('[aria-label^="Move"]')).toBeNull();
    await expect.element(screen.getByText("Task 1")).toBeVisible();
  });
});

describe("setup", () => {
  it("asks for a group and writes the chosen property", async () => {
    const fake = new FakeDatabase({ quietRowWrites: true, rows: 3 });
    fake.views = fake.views.map((view) => {
      const { group: _group, ...rest } = view as unknown as Record<string, unknown>;
      return rest;
    }) as never;
    state.fake = fake;
    await page.viewport(1400, 900);
    const board = await mountBoard(fake);
    await using _screen = board.screen;
    await expect.element(board.screen.getByText("Group this board by a property")).toBeVisible();
    expect(fake.callsOf("query")).toHaveLength(0);
    await userEvent.click(board.screen.getByRole("combobox", { name: "Group by" }));
    await userEvent.click(board.screen.getByRole("option", { name: "Status" }));
    await vi.waitFor(() => expect(fake.callsOf("updateView")).toHaveLength(1));
    expect(fake.callsOf("updateView")[0]!.input).toMatchObject({
      group: { property: "status", by: "option" },
    });
  });
});
