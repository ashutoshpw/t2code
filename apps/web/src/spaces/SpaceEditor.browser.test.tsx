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
});
