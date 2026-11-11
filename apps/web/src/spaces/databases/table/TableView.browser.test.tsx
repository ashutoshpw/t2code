import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { FakeDatabase } from "../test/fakeDatabase";
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

async function mount(options: ConstructorParameters<typeof FakeDatabase>[0] = {}) {
  const fake = new FakeDatabase({ quietRowWrites: true, ...options });
  state.fake = fake;
  return { fake, ...(await mountTable(fake)) };
}
const cursorQueries = (fake: FakeDatabase) =>
  fake.callsOf("query").filter((call) => call.input.cursor !== undefined);

describe("windowing", () => {
  it("mounts a window of 5000 rows and loads the next window once when scrolled to the end", async () => {
    const { fake, screen, grid } = await mount({ rows: 5000 });
    await using _screen = screen;
    await expect.element(screen.getByRole("grid", { name: "Rows" })).toBeVisible();
    await vi.waitFor(() =>
      expect(grid().querySelectorAll('[data-col="title"]').length).toBeGreaterThan(5),
    );
    expect(grid().querySelectorAll('[data-col="title"]').length).toBeLessThan(60);
    expect(grid().getAttribute("aria-rowcount")).toBe("5003");
    const first = fake.callsOf("query")[0]!.input;
    expect(first).toMatchObject({ mode: "rows", include: { total: true, aggregates: true } });

    grid().scrollTop = grid().scrollHeight;
    await vi.waitFor(() => expect(cursorQueries(fake)).toHaveLength(1));
    expect(cursorQueries(fake)[0]!.input.include).toBeUndefined();
    await vi.waitFor(() => expect(grid().querySelector('[data-row="row-101"]')).not.toBeNull());
    expect(grid().querySelectorAll('[data-col="title"]').length).toBeLessThan(60);
    expect(cursorQueries(fake)).toHaveLength(1);
  });

  it("keeps the rows and offers Retry when a continuation fails", async () => {
    const { fake, screen, grid } = await mount({ rows: 500 });
    await using _screen = screen;
    await vi.waitFor(() => expect(grid().querySelector('[data-row="row-1"]')).not.toBeNull());
    fake.failNext.set("query", new Error("socket"));
    grid().scrollTop = grid().scrollHeight;
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(grid().getAttribute("aria-rowcount")).toBe("503");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(cursorQueries(fake)).toHaveLength(2));
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it("windows columns too: far right columns mount only after a horizontal scroll", async () => {
    const { screen, grid } = await mount({ rows: 5 });
    await using _screen = screen;
    await vi.waitFor(() => expect(grid().querySelector('[data-row="row-1"]')).not.toBeNull());
    expect(grid().querySelector('[data-row="row-1"][data-col="amount"]')).toBeNull();
    grid().scrollLeft = grid().scrollWidth;
    await vi.waitFor(() =>
      expect(grid().querySelector('[data-row="row-1"][data-col="amount"]')).not.toBeNull(),
    );
    expect(grid().querySelector('[data-row="row-1"][data-col="title"]')).not.toBeNull();
    expect(grid().querySelector('[data-row="row-1"][data-col="status"]')).toBeNull();
  });
});

describe("states", () => {
  it("shows the empty state", async () => {
    const { screen } = await mount({ rows: 0 });
    await using _screen = screen;
    await expect.element(screen.getByText("No rows yet")).toBeVisible();
  });

  it("recovers from a failed first load with Retry", async () => {
    const fake = new FakeDatabase({ quietRowWrites: true, rows: 3 });
    fake.failNext.set("query", new Error("boom"));
    state.fake = fake;
    const { screen } = await mountTable(fake);
    await using _screen = screen;
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await expect.element(screen.getByRole("grid", { name: "Rows" })).toBeVisible();
    await expect.element(screen.getByText("Task 1")).toBeVisible();
    void page;
  });
});
