import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageId,
  SpaceReceiptEpoch,
  type SpaceApplyBlockBatchInput,
  type SpaceBlock,
  type SpaceLimits,
  type SpaceReadSubtreeResult,
} from "@t2code/contracts/spaces";

import { render } from "../../../test/render";
import { SpaceEditorAdapter } from "../adapter";
import type { SpaceDocumentController } from "../documentController";
import { SpaceEditor } from "../SpaceEditor";
import {
  SyncedHostContext,
  SyncedPortsContext,
  type SyncedHost,
  type SyncedPorts,
} from "./SyncedContext";
import { syncedSession, type Found } from "./syncedController";

const environmentId = EnvironmentId.make("env");
const id = SpaceBlockId.make;
const hostPage = SpacePageId.make("host");
const sourcePage = SpacePageId.make("source");
const now = "2026-11-14T00:00:00.000Z";
const epoch = SpaceReceiptEpoch.make("epoch");
const limits: SpaceLimits = {
  maxListRows: 100,
  maxListResponseBytes: 262_144,
  maxBlockWindowBlocks: 100,
  maxBlockWindowResponseBytes: 262_144,
  maxMutationNodes: 100,
  maxMutationBytes: 262_144,
  maxBlockBytes: 32_768,
  maxDepth: 16,
  maxPageBlocks: 10_000,
  maxPageBytes: 8_388_608,
  maxIdBytes: 128,
  maxTitleBytes: 1_024,
  maxOrderBytes: 64,
  maxCursorBytes: 1_024,
  maxReceiptBytes: 1_048_576,
  maxReceiptRows: 1_000,
  maxReceiptStorageBytes: 8_388_608,
  maxEpochRows: 10,
  receiptRetentionMs: 86_400_000,
  cleanupBatchRows: 100,
};

const base = { version: 1 } as const;
// The editor bridge only allocates ranks between 32-digit hex orders.
const rank = (value: number) => (BigInt(value) << 100n).toString(16).padStart(32, "0");
const original: SpaceBlock = {
  ...base,
  id: id("s"),
  parentId: null,
  order: rank(1),
  type: "synced_block",
  content: {},
};
const nested: SpaceBlock = {
  ...base,
  id: id("n"),
  parentId: id("s"),
  order: rank(1),
  type: "paragraph",
  content: { runs: [{ text: "nested text", marks: [] }] },
};
const hostBlocks: SpaceBlock[] = [
  {
    ...base,
    id: id("h"),
    parentId: null,
    order: "a",
    type: "paragraph",
    content: { runs: [{ text: "host text", marks: [] }] },
  },
  {
    ...base,
    id: id("r"),
    parentId: null,
    order: "b",
    type: "synced_ref",
    content: { sourceBlockId: id("s") },
  },
];

/** The source page as the server holds it: saves apply to it and a conflict can be forced. */
function stand() {
  const server = { revision: 4, blocks: [original, nested] as readonly SpaceBlock[] };
  const applied: SpaceApplyBlockBatchInput[] = [];
  const control = { conflict: false };
  const controllers: SpaceDocumentController[] = [];
  const found = (): Found => ({
    status: "found",
    page: {
      id: sourcePage,
      spaceId: SpaceId.make("space"),
      title: "Source",
      revision: server.revision,
      rootOrder: "1",
      createdAt: now,
      updatedAt: now,
    },
    mutationAdmission: { epoch, acceptsUntil: now, retainUntil: now },
    revision: server.revision,
    blocks: server.blocks,
    complete: true,
    refs: [],
    refCount: 1,
  });
  const subtree: SpaceReadSubtreeResult = found();
  let sequence = 0;
  const ports: SyncedPorts = {
    useSubtree: () => ({ data: subtree, error: null }),
    useWritable: () => true,
    createController: (_registry, env, source) => {
      const controller = syncedSession(env, source, {
        readSubtree: () => Promise.resolve(found()),
        limits: () => limits,
        createMutationId: () => `mutation-${++sequence}`,
        lookupMutationReceipt: () => Promise.resolve({ status: "absent" }),
        applyBlockBatch: (input) => {
          applied.push(input);
          if (control.conflict)
            return Promise.resolve({
              status: "conflict",
              mutationId: input.mutationId,
              receiptEpoch: input.receiptEpoch,
              generation: input.generation,
              revision: server.revision + 1,
              current: {
                catalogRevision: 0,
                defaultSpaceId: SpaceId.make("space"),
                spaces: [],
                pages: [],
              },
            });
          const next = new Map(server.blocks.map((block) => [block.id, block]));
          for (const mutation of input.mutations) {
            if (mutation.kind === "delete") next.delete(mutation.blockId);
            else next.set(mutation.block.id, mutation.block);
          }
          server.blocks = [...next.values()];
          server.revision += 1;
          return Promise.resolve({
            status: "saved",
            mutationId: input.mutationId,
            receiptEpoch: input.receiptEpoch,
            generation: input.generation,
            revision: server.revision,
          });
        },
      });
      controllers.push(controller);
      return controller;
    },
  };
  return { ports, applied, control, controllers, server };
}

function hostAdapter() {
  let sequence = 0;
  return new SpaceEditorAdapter({
    target: { environmentId, pageId: hostPage },
    window: { revision: 0, blocks: hostBlocks, completeParents: [null] },
    maxBlocks: 50,
    maxDepth: 8,
    maxTextLength: 10000,
    maxClipboardBytes: 20000,
    allocateId: () => id(`new-${++sequence}`),
    allocateOrder: ({ before }) => `${before ?? ""}~${++sequence}`,
  });
}

const host: SyncedHost = {
  environmentId,
  pageId: hostPage,
  openPage: () => {},
  hostClean: () => true,
  saveHost: () => Promise.resolve(),
  refreshHost: () => Promise.resolve(),
  confirmUnsyncAll: () => {},
};

async function mount() {
  const source = stand();
  const onBatch = vi.fn();
  const screen = await render(
    <SyncedPortsContext.Provider value={source.ports}>
      <SyncedHostContext.Provider value={host}>
        <SpaceEditor adapter={hostAdapter()} onBatch={onBatch} blockFeatures={{ synced: true }} />
      </SyncedHostContext.Provider>
    </SyncedPortsContext.Provider>,
    // The bare editor renders no links or navigation.
    { router: false },
  );
  await using stack = new AsyncDisposableStack();
  stack.use(screen);
  await expect.element(screen.getByText("nested text")).toBeVisible();
  stack.move();
  return { screen, source, onBatch };
}

const nestedBlocks = (source: ReturnType<typeof stand>) =>
  source.controllers[0]!.session.getSnapshot().blocks;

describe("synced copy editor", () => {
  it("saves typing in the copy to the original's page and leaves the host page alone", async () => {
    const { screen, source, onBatch } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByText("nested text"));
    await userEvent.keyboard("{End}!");
    await userEvent.click(screen.getByText("host text"));
    await vi.waitFor(() => expect(source.applied).toHaveLength(1));
    const saved = source.applied[0]!;
    expect(saved).toMatchObject({ pageId: "source", baseRevision: 4, subtreeRootId: "s" });
    expect(saved.mutations).toMatchObject([{ kind: "replace", block: { id: "n", parentId: "s" } }]);
    expect(JSON.stringify(saved.mutations)).toContain("nested text!");
    expect(onBatch).not.toHaveBeenCalled();
  });

  it("keeps Enter, Backspace and undo inside the copy", async () => {
    const { screen, source, onBatch } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByText("nested text"));
    await userEvent.keyboard("{End}{Enter}");
    await vi.waitFor(() => expect(nestedBlocks(source)).toHaveLength(3));
    await userEvent.keyboard("{Backspace}");
    await vi.waitFor(() => expect(nestedBlocks(source)).toHaveLength(2));
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(JSON.stringify(nestedBlocks(source))).toContain("nested textx"));
    await userEvent.keyboard("{Control>}z{/Control}");
    await vi.waitFor(() =>
      expect(JSON.stringify(nestedBlocks(source))).not.toContain("nested textx"),
    );
    expect(onBatch).not.toHaveBeenCalled();
  });

  it("types into the host page after the copy without touching the original", async () => {
    const { screen, source, onBatch } = await mount();
    await using _screen = screen;
    await userEvent.click(screen.getByText("nested text"));
    await userEvent.keyboard("{End}!");
    await userEvent.click(screen.getByText("host text"));
    await userEvent.keyboard("{End}?");
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalled());
    const hostBatch = JSON.stringify(onBatch.mock.calls.at(-1)?.[0].mutations);
    expect(hostBatch).toContain("host text?");
    expect(hostBatch).not.toContain("nested");
    expect(JSON.stringify(nestedBlocks(source))).not.toContain("?");
  });

  it("puts the host handle on the copy and ignores host drags over its content", async () => {
    const { screen } = await mount();
    await using _screen = screen;
    await userEvent.hover(screen.getByText("nested text"));
    const grip = page.getByRole("button", { name: "Block menu" });
    await expect.element(grip).toBeVisible();
    await userEvent.click(grip);
    await expect.element(page.getByRole("menuitem", { name: "Unsync" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    const handle = screen.container.querySelector<HTMLElement>(
      "[data-space-block-handle] [draggable]",
    );
    const text = screen.getByText("nested text").element();
    const dispatch = (target: Element, type: string, clientY: number) =>
      target.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientY,
          dataTransfer: new DataTransfer(),
        }),
      );
    dispatch(handle!, "dragstart", 0);
    const indicator = () => screen.container.querySelector("div.bg-primary.h-0\\.5");
    // Control: once the drag is live, an ordinary host block takes a drop.
    const hostText = screen.getByText("host text").element();
    await vi.waitFor(() => {
      dispatch(hostText, "dragover", hostText.getBoundingClientRect().top + 1);
      expect(indicator()).not.toBeNull();
    });
    // Over the copy's content the host plans no drop at all.
    await vi.waitFor(() => {
      dispatch(text, "dragover", text.getBoundingClientRect().top + 1);
      expect(indicator()).toBeNull();
    });
  });

  it("shows a conflict and keeps the typed text when the original moved on", async () => {
    const { screen, source } = await mount();
    await using _screen = screen;
    source.control.conflict = true;
    await userEvent.click(screen.getByText("nested text"));
    await userEvent.keyboard("{End}!");
    await userEvent.click(screen.getByText("host text"));
    await expect
      .element(screen.getByText("Conflict: the original changed elsewhere"))
      .toBeVisible();
    await expect.element(screen.getByText("nested text!")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Discard my changes" })).toBeVisible();
  });
});
