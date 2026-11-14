import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { mountRows } from "../list/listHarness";
import { fixtureView } from "../test/fixtures";
import { FakeDatabase } from "../test/fakeDatabase";
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

const preview = (text: string) => ({
  blocks: [{ type: "paragraph", runs: [{ text, marks: [] }] }],
  more: false,
});

async function mount(rows: number, layout: Record<string, unknown> = {}) {
  const view = { ...fixtureView("view-feed", "table", "Feed", 0, layout), type: "feed" } as never;
  const fake = new FakeDatabase({
    quietRowWrites: true,
    rows,
    views: [view],
    previews: { "row-1": preview("Body of one") } as never,
  });
  state.fake = fake;
  await page.viewport(1400, 900);
  const mounted = await readyWhen(await mountRows(view), (value) =>
    vi.waitFor(() => expect(value.scroller()).toBeTruthy()),
  );
  return { fake, ...mounted };
}
const preferred = (fake: FakeDatabase) =>
  fake.callsOf("query").map((call) => (call.input as { include?: { preview?: number } }).include);

describe("feed", () => {
  it("shows the title, a property and the page preview, asking for 3 blocks", async () => {
    const { screen, scroller, fake } = await mount(4);
    await using _screen = screen;
    await vi.waitFor(() => expect(scroller().textContent).toContain("Body of one"));
    const first = scroller().querySelector<HTMLElement>('[data-row-id="row-1"]')!;
    expect(first.textContent).toContain("Task 1");
    expect(first.textContent).toContain("Not started");
    expect(preferred(fake).some((include) => include?.preview === 3)).toBe(true);
  });

  it("asks for no preview when the layout turns it off", async () => {
    const { screen, scroller, fake } = await mount(3, { previewBlocks: 0 });
    await using _screen = screen;
    await vi.waitFor(() => expect(scroller().querySelector("[data-row-id]")).toBeTruthy());
    expect(fake.callsOf("query").length).toBeGreaterThan(0);
    expect(preferred(fake).every((include) => include?.preview === undefined)).toBe(true);
  });

  it("loads the next window once when the list scrolls to its end", async () => {
    const { screen, scroller, fake } = await mount(60);
    await using _screen = screen;
    await vi.waitFor(() => expect(scroller().querySelector("[data-row-id]")).toBeTruthy());
    const before = fake.callsOf("query").length;
    scroller().scrollTop = scroller().scrollHeight;
    await vi.waitFor(() => expect(fake.callsOf("query").length).toBe(before + 1));
    await vi.waitFor(() => expect(scroller().querySelector('[data-row-id="row-26"]')).toBeTruthy());
  });

  it("opens the row on click and on Enter", async () => {
    const { screen, host, scroller } = await mount(4);
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: /^Task 2\b/ }));
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-2" }));
    scroller().querySelector<HTMLElement>('[data-row-id="row-3"] button')!.focus();
    await userEvent.keyboard("{Enter}");
    expect(host.openPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "row-3" }));
  });
});
