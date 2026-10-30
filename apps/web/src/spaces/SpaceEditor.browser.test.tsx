import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpaceId, SpacePageId, SpaceReceiptEpoch } from "@t2code/contracts/spaces";

import { render } from "../../test/render";
import { SpaceEditorAdapter } from "./adapter";
import { SpaceDocumentController } from "./documentController";
import { SpaceEditor } from "./SpaceEditor";
import { SpaceEditorBridge } from "./editorBridge";

function adapter(blocks = true) {
  let sequence = 0;
  return new SpaceEditorAdapter({
    target: { environmentId: EnvironmentId.make("env"), pageId: SpacePageId.make("page") },
    window: {
      revision: 0,
      completeParents: [null],
      blocks: !blocks
        ? []
        : [
            {
              id: SpaceBlockId.make("first"),
              parentId: null,
              order: "a",
              type: "paragraph",
              version: 1,
              content: { runs: [{ text: "Hello page", marks: [] }] },
            },
          ],
    },
    maxBlocks: 50,
    maxDepth: 8,
    maxTextLength: 10000,
    maxClipboardBytes: 20000,
    allocateId: () => SpaceBlockId.make(`new-${++sequence}`),
    allocateOrder: ({ before }) => `${before ?? ""}~${++sequence}`,
  });
}

async function emptyPageBridge() {
  const now = "2026-10-26T00:00:00.000Z";
  const key = { environmentId: EnvironmentId.make("env"), pageId: SpacePageId.make("page") };
  const spaceId = SpaceId.make("space");
  const offline = async (): Promise<never> => {
    throw new Error("No backend in editor test");
  };
  const controller = new SpaceDocumentController(
    key,
    {
      adapter: { getMutationAdmission: offline, save: offline, lookupReceipt: offline },
      drafts: { load: async () => null, write: async () => {} },
      createMutationId: () => "unused",
      maxLoadedBlocks: 100,
      maxMutations: 100,
    },
    {
      getPage: async () => ({
        page: {
          id: key.pageId,
          spaceId,
          title: "Page",
          revision: 1,
          rootOrder: "1",
          createdAt: now,
          updatedAt: now,
        },
        space: {
          id: spaceId,
          title: "Space",
          revision: 1,
          rootOrderRevision: 1,
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        },
        mutationAdmission: {
          epoch: SpaceReceiptEpoch.make("unused"),
          acceptsUntil: now,
          retainUntil: now,
        },
      }),
      readBlocks: async () => ({ revision: 1, blocks: [], nextCursor: null }),
      windowLimit: () => 100,
    },
  );
  await controller.open();
  let ids = 0;
  return new SpaceEditorBridge(controller, () => SpaceBlockId.make(`fresh-${++ids}`));
}

describe("SpaceEditor", () => {
  it("shows the page contents once the editor mounts, before any edit", async () => {
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={adapter()} />, { router: false });
    await expect.element(screen.getByRole("textbox", { name: "Page editor" })).toBeVisible();
    await expect.element(screen.getByText("Hello page")).toBeVisible();
  });

  it("lets an empty page be typed into without opening a menu", async () => {
    const onBatch = vi.fn();
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={adapter(false)} onBatch={onBatch} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("Hello");
    await expect.element(screen.getByText("Hello")).toBeVisible();
    const batch = onBatch.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(batch)).toContain("Hello");
    expect(JSON.stringify(batch)).toContain("paragraph");
  });

  it("lets an empty saved page be typed into on first click", async () => {
    const bridge = await emptyPageBridge();
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={bridge.adapter} bridge={bridge} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("Hello");
    await expect.element(screen.getByText("Hello")).toBeVisible();
  });

  it("turns a slash command into the chosen block and removes the slash text", async () => {
    const onBatch = vi.fn();
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={adapter(false)} onBatch={onBatch} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("/");
    await expect.element(screen.getByRole("option", { name: "Heading 1" })).toBeVisible();
    await userEvent.keyboard("h1{Enter}");
    await expect.element(screen.getByRole("heading", { level: 1 })).toBeVisible();
    const batch = JSON.stringify(onBatch.mock.calls.at(-1)?.[0]);
    expect(batch).toContain("heading");
    expect(batch).not.toContain("/");
  });

  it("offers a Page slash command that reports the cursor block after removing the slash text", async () => {
    const onCreatePage = vi.fn();
    const bridge = await emptyPageBridge();
    // The bare editor renders no links or navigation.
    await using screen = await render(
      <SpaceEditor adapter={bridge.adapter} bridge={bridge} onCreatePage={onCreatePage} />,
      { router: false },
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("/page");
    await expect.element(screen.getByRole("option", { name: "Page" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(onCreatePage).toHaveBeenCalledTimes(1);
    expect(onCreatePage.mock.calls[0]?.[0]).toEqual(expect.any(String));
    expect(
      screen.getByRole("textbox", { name: "Page editor" }).element().textContent,
    ).not.toContain("/page");
  });

  it("hides the Page slash command without a create handler", async () => {
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={adapter(false)} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("/");
    await expect.element(screen.getByRole("option", { name: "Heading 1" })).toBeVisible();
    await expect.element(screen.getByRole("option", { name: "Page" })).not.toBeInTheDocument();
  });

  it("formats selected text from the selection toolbar", async () => {
    const onBatch = vi.fn();
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={adapter()} onBatch={onBatch} />, {
      router: false,
    });
    await userEvent.dblClick(screen.getByText("Hello page"));
    await userEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(JSON.stringify(onBatch.mock.calls.at(-1)?.[0])).toContain("bold");
  });

  it("turns markdown shortcuts at the start of a block into styled blocks", async () => {
    const onBatch = vi.fn();
    await using screen = await render(<SpaceEditor adapter={adapter(false)} onBatch={onBatch} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("- item");
    expect(JSON.stringify(onBatch.mock.calls.at(-1)?.[0])).toContain("bulleted_item");
    await userEvent.keyboard("{Enter}{Enter}## Title");
    const batch = JSON.stringify(onBatch.mock.calls.at(-1)?.[0]);
    expect(batch).toContain('"level":2');
    expect(batch).not.toContain("## ");
  });

  it("exits an empty list item on Enter and an empty quote on Backspace", async () => {
    const onBatch = vi.fn();
    await using screen = await render(<SpaceEditor adapter={adapter(false)} onBatch={onBatch} />, {
      router: false,
    });
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("[[] task{Enter}");
    expect(screen.getByRole("checkbox").elements()).toHaveLength(2);
    await userEvent.keyboard("{Enter}after");
    expect(screen.getByRole("checkbox").elements()).toHaveLength(1);
    expect(JSON.stringify(onBatch.mock.calls.at(-1)?.[0])).toContain("after");
    await userEvent.keyboard("{Enter}> ");
    expect(document.querySelectorAll("blockquote")).toHaveLength(1);
    await userEvent.keyboard("{Backspace}more");
    expect(document.querySelectorAll("blockquote")).toHaveLength(0);
    await expect.element(screen.getByText("more")).toBeVisible();
  });

  it("toggles a to-do from its checkbox", async () => {
    await using screen = await render(<SpaceEditor adapter={adapter(false)} />, { router: false });
    await userEvent.click(screen.getByRole("textbox", { name: "Page editor" }));
    await userEvent.keyboard("[[] task");
    const box = screen.getByRole("checkbox", { name: "Done" });
    await userEvent.click(box);
    await expect.element(screen.getByRole("checkbox", { name: "Done" })).toBeChecked();
  });

  it("inserts a code block at the caret instead of the end of the page", async () => {
    const onBatch = vi.fn();
    await using screen = await render(<SpaceEditor adapter={adapter()} onBatch={onBatch} />, {
      router: false,
    });
    await userEvent.click(screen.getByText("Hello page"));
    await userEvent.keyboard("{Enter}/code{Enter}");
    expect(JSON.stringify(onBatch.mock.calls.at(-1)?.[0])).toContain('"type":"code"');
  });

  it("hides the selection toolbar when the editor loses focus", async () => {
    await using screen = await render(<SpaceEditor adapter={adapter()} />, { router: false });
    await userEvent.dblClick(screen.getByText("Hello page"));
    await expect.element(screen.getByRole("button", { name: "Bold" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await expect.element(screen.getByRole("button", { name: "Bold" })).not.toBeInTheDocument();
  });
});
