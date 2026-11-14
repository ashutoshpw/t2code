import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { dragWithKeyboard } from "../controls/keyboardDrag";
import { FakeDatabase } from "../test/fakeDatabase";
import { fixtureView } from "../test/fixtures";
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
  default: (await import("../controls/controlsStub")).default,
}));

const IDS = ["v1", "v2", "v3", "v4", "v5", "v6"];

function setup(
  options: ConstructorParameters<typeof FakeDatabase>[0] = {},
  name = (index: number) => `Roadmap ${index + 1}`,
) {
  const fake = new FakeDatabase({
    ...options,
    views: IDS.map((id, index) => fixtureView(id, "table", name(index), index)),
  });
  state.fake = fake;
  const { controller } = fakeController();
  return testHost(controller);
}

const sized = (width: number) => {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  return container;
};
const overflow = () => page.getByRole("button", { name: /more views$/ });

describe("view tabs that do not fit", () => {
  it("shows N more… in a narrow row and every tab once it widens", async () => {
    const host = setup();
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={IDS} />, {
      container: sized(420),
      router: false,
    });
    await expect.element(overflow()).toBeVisible();
    screen.container.style.width = "1400px";
    await expect.element(overflow()).not.toBeInTheDocument();
    await expect.element(screen.getByRole("tab", { name: "Roadmap 6" })).toBeVisible();
  });

  it("fits long view names without clipping a tab or widening a scroll container", async () => {
    const host = setup({}, (index) => `Roadmap long view name number ${index + 1}`);
    const container = sized(700);
    container.style.overflow = "auto";
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={IDS} />, {
      container,
      router: false,
    });
    await expect.element(overflow()).toBeVisible();
    const tablist = screen.getByRole("tablist").element();
    expect(tablist.scrollWidth).toBeLessThanOrEqual(tablist.clientWidth);
    expect(container.scrollWidth).toBe(container.clientWidth);
  });

  it("puts a view chosen from the overflow in the strip as the active tab", async () => {
    const host = setup();
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={IDS} />, {
      container: sized(420),
      router: false,
    });
    await userEvent.click(overflow());
    await userEvent.click(page.getByRole("button", { name: "Roadmap 6", exact: true }));
    await expect
      .element(screen.getByRole("tab", { name: "Roadmap 6" }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("searches the overflow and reorders its views from the keyboard", async () => {
    const host = setup();
    const onSetViews = vi.fn();
    await using screen = await render(
      <DatabaseHarness host={host} initialViewIds={IDS} onSetViews={onSetViews} />,
      { container: sized(420), router: false },
    );
    await userEvent.click(overflow());
    await userEvent.fill(page.getByRole("searchbox", { name: "Search views" }), "Roadmap 5");
    await expect
      .element(page.getByRole("button", { name: "Roadmap 4", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Roadmap 5", exact: true }))
      .toBeVisible();
    await userEvent.clear(page.getByRole("searchbox", { name: "Search views" }));
    await dragWithKeyboard("Reorder Roadmap 1", "{ArrowDown}");
    await vi.waitFor(() =>
      expect(onSetViews).toHaveBeenCalledWith(["v2", "v1", "v3", "v4", "v5", "v6"]),
    );
    void screen;
  });
});

describe("the toolbar", () => {
  it("expands search from its icon and folds it back on Escape", async () => {
    const host = setup();
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={IDS} />, {
      container: sized(1400),
      router: false,
    });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await expect.element(screen.getByRole("searchbox", { name: "Search rows" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("searchbox", { name: "Search rows" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Search" })).toBeVisible();
  });

  it("collapses to the active view and survives a remount, until it is shown again", async () => {
    const host = setup();
    const harness = <DatabaseHarness host={host} initialViewIds={IDS} blockId="block-collapse" />;
    await using first = await render(harness, { container: sized(1400), router: false });
    await userEvent.click(first.getByRole("button", { name: "Hide views and toolbar" }));
    await expect.element(first.getByRole("tab", { name: "Roadmap 2" })).not.toBeInTheDocument();
    await expect.element(first.getByRole("button", { name: "Filter" })).not.toBeInTheDocument();
    await first.unmount();
    await using second = await render(harness, { container: sized(1400), router: false });
    await expect
      .element(second.getByRole("button", { name: "Show views and toolbar" }))
      .toBeVisible();
    await expect.element(second.getByRole("tab", { name: "Roadmap 2" })).not.toBeInTheDocument();
    await userEvent.click(second.getByRole("button", { name: "Show views and toolbar" }));
    await expect.element(second.getByRole("tab", { name: "Roadmap 2" })).toBeVisible();
    await expect.element(second.getByRole("button", { name: "Filter" })).toBeVisible();
  });
});

describe("a read-only viewer", () => {
  it("sees the tabs without add, grips or per-view menus", async () => {
    const host = setup({ permissions: { views: false, rename: false } });
    await using screen = await render(<DatabaseHarness host={host} initialViewIds={IDS} />, {
      container: sized(420),
      router: false,
    });
    await userEvent.click(overflow());
    await expect
      .element(page.getByRole("button", { name: "Roadmap 6", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Add a view" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: /^Reorder/ }).first()).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: /view options$/ }))
      .not.toBeInTheDocument();
  });
});
