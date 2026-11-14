import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpacePageId, type SpaceBlock } from "@t2code/contracts/spaces";

import { render } from "../../../test/render";
import { SpaceEditorAdapter } from "../adapter";
import { SpaceEditor } from "../SpaceEditor";

const id = SpaceBlockId.make;
const base = { parentId: null, version: 1 } as const;

function tabsAdapter() {
  let sequence = 0;
  const blocks: SpaceBlock[] = [
    { ...base, id: id("t"), order: "a", type: "tabs", content: {} },
    {
      ...base,
      id: id("p1"),
      parentId: id("t"),
      order: "a",
      type: "tab_pane",
      content: { title: "One" },
    },
    {
      ...base,
      id: id("a"),
      parentId: id("p1"),
      order: "a",
      type: "paragraph",
      content: { runs: [{ text: "alpha", marks: [] }] },
    },
    {
      ...base,
      id: id("p2"),
      parentId: id("t"),
      order: "b",
      type: "tab_pane",
      content: { title: "Two" },
    },
    {
      ...base,
      id: id("b"),
      parentId: id("p2"),
      order: "a",
      type: "paragraph",
      content: { runs: [{ text: "beta", marks: [] }] },
    },
  ];
  return new SpaceEditorAdapter({
    target: { environmentId: EnvironmentId.make("env"), pageId: SpacePageId.make("page") },
    window: { revision: 0, blocks, completeParents: [null, id("t"), id("p1"), id("p2")] },
    maxBlocks: 50,
    maxDepth: 8,
    maxTextLength: 10000,
    maxClipboardBytes: 20000,
    allocateId: () => id(`new-${++sequence}`),
    allocateOrder: ({ before }) => `${before ?? ""}~${++sequence}`,
  });
}

describe("SpaceEditor tabs", () => {
  it("shows one pane at a time and types into the open pane", async () => {
    const onBatch = vi.fn();
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={tabsAdapter()} onBatch={onBatch} />, {
      router: false,
    });
    await expect.element(screen.getByText("alpha")).toBeVisible();
    await expect.element(screen.getByText("beta")).not.toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Two" }));
    await expect.element(screen.getByText("beta")).toBeVisible();
    await expect.element(screen.getByText("alpha")).not.toBeVisible();
    await userEvent.click(screen.getByText("beta"));
    await userEvent.keyboard("{End}!");
    const batch = onBatch.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(batch.mutations)).toContain("beta!");
    expect(JSON.stringify(batch.mutations)).not.toContain("alpha!");
  });

  it("renames on Enter, adds, reorders and deletes tabs", async () => {
    const onBatch = vi.fn();
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={tabsAdapter()} onBatch={onBatch} />, {
      router: false,
    });
    await userEvent.dblClick(screen.getByRole("tab", { name: "One" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Tab name" }), "Plans");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("tab", { name: "Plans" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add a tab" }));
    await expect
      .element(screen.getByRole("tab", { name: "Tab 3" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Plans" }));
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    const tabs = () =>
      page
        .getByRole("tab")
        .elements()
        .map((tab) => tab.textContent);
    await vi.waitFor(() => expect(tabs()).toEqual(["Two", "Plans", "Tab 3"]));
    await userEvent.click(screen.getByRole("button", { name: "Tab options" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete tab" }));
    // The dialog's inert guard sits over real pointer hits; a DOM click is what a keyboard Enter does.
    await vi.waitFor(() =>
      (page.getByRole("button", { name: "Delete tab" }).element() as HTMLElement).click(),
    );
    await vi.waitFor(() => expect(tabs()).toEqual(["Two", "Tab 3"]));
    expect(JSON.stringify(onBatch.mock.calls.at(-1)?.[0].mutations)).toContain('"kind":"delete"');
  });
});
