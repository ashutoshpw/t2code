import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpacePageId } from "@t2code/contracts/spaces";

import { render } from "../../test/render";
import { SpaceEditorAdapter } from "./adapter";
import { SpaceEditor } from "./SpaceEditor";

function adapter() {
  let sequence = 0;
  return new SpaceEditorAdapter({
    target: { environmentId: EnvironmentId.make("env"), pageId: SpacePageId.make("page") },
    window: {
      revision: 0,
      completeParents: [null],
      blocks: [
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

describe("SpaceEditor", () => {
  it("shows the page contents once the editor mounts, before any edit", async () => {
    // The bare editor renders no links or navigation.
    await using screen = await render(<SpaceEditor adapter={adapter()} />, { router: false });
    await expect.element(screen.getByRole("textbox", { name: "Page editor" })).toBeVisible();
    await expect.element(screen.getByText("Hello page")).toBeVisible();
  });
});
