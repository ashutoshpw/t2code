import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpacePageId,
  type SpaceBlock,
  type SpaceCapability,
} from "@t2code/contracts/spaces";
import { SpaceDocumentSession, type SpaceDraftStore } from "@t2code/client-runtime/spaces";
import { MobileSpaceEditing } from "./editing";
import type { SpacesReadAccess } from "./reader";
import type { SpacesNativeMark } from "./nativeSpacesProtocol";

const key = {
  environmentId: EnvironmentId.make("edit-environment"),
  pageId: SpacePageId.make("edit-page"),
};
const capability: SpaceCapability = {
  version: 2,
  limits: {
    maxListRows: 20,
    maxListResponseBytes: 32768,
    maxBlockWindowBlocks: 100,
    maxBlockWindowResponseBytes: 2097152,
    maxMutationNodes: 100,
    maxMutationBytes: 32768,
    maxBlockBytes: 512,
    maxDepth: 16,
    maxPageBlocks: 1000,
    maxPageBytes: 1048576,
    maxIdBytes: 256,
    maxTitleBytes: 1024,
    maxOrderBytes: 64,
    maxCursorBytes: 1024,
    maxReceiptBytes: 32768,
    maxReceiptRows: 100,
    maxReceiptStorageBytes: 1048576,
    maxEpochRows: 10,
    receiptRetentionMs: 60000,
    cleanupBatchRows: 100,
  },
};
const block: SpaceBlock = {
  id: SpaceBlockId.make("focused"),
  parentId: null,
  order: "a",
  type: "heading",
  version: 1,
  content: { level: 2, runs: [{ text: "Original😀", marks: [{ type: "bold", version: 1 }] }] },
};

function setup(drafts: SpaceDraftStore = { load: async () => null, write: async () => {} }) {
  let access: SpacesReadAccess = { availability: "writable", capability, current: () => true };
  const session = new SpaceDocumentSession(key, {
    drafts,
    maxLoadedBlocks: 100,
    maxMutations: 100,
    createMutationId: () => "unused",
    adapter: {
      getMutationAdmission: async () => {
        throw new Error("This test must not send or invent admission");
      },
      save: async () => {
        throw new Error("This test must not invent a save result");
      },
      lookupReceipt: async () => {
        throw new Error("This test must not invent a receipt");
      },
    },
  });
  const editing = new MobileSpaceEditing({
    session,
    access: () => access,
    readWindow: async () => {
      throw new Error("This test must not fetch a replacement window");
    },
  });
  return {
    session,
    editing,
    setAccess: (next: SpacesReadAccess) => {
      access = next;
    },
  };
}
function event(text: string, revision: number, composing = false) {
  return {
    version: 1,
    revision,
    composing,
    selection: { start: 0, end: 0 },
    runs: [{ text, bold: true, italic: true, code: true, link: "https://t2.codes" }],
    typing: { bold: true, italic: true, code: true, link: "https://t2.codes" },
  };
}

describe("production native page editing boundary", () => {
  it("retains a newer rejected native revision through older commits and recovers only consistent content without leaking across owners", async () => {
    const test = setup();
    await test.session.hydrate({ revision: 40, blocks: [block] });
    const owner = Symbol();
    const focus = test.editing.focus(owner, block.id);
    const publication = focus.publication;
    publication.receive(event("😀y", 1, true), true);
    const before = publication.getSnapshot();
    const rejected = { ...event("😀z", 2), selection: { start: 1, end: 2 } };
    publication.receive(rejected, true);
    expect(publication.getSnapshot()).toMatchObject({
      blocked: true,
      error: expect.stringContaining("UTF-16"),
      observed: before.observed,
      admitted: before.admitted,
    });
    publication.receive(event("😀y", 1), true);
    expect(publication.getSnapshot().blocked).toBe(true);
    expect(publication.getSnapshot().observed).toBe(before.observed);
    expect(test.session.getSnapshot()).toMatchObject({ generation: 0, blocks: [block] });
    expect(() => publication.formatCommand("bold", publication.getSnapshot().observed)).toThrow();

    publication.receive(event("different content at rejected revision", 2), true);
    expect(publication.getSnapshot().error).toContain("without a new revision");
    expect(test.session.getSnapshot().generation).toBe(0);
    const corrected = { ...rejected, selection: { start: 2, end: 3 } };
    publication.receive(corrected, false);
    expect(publication.getSnapshot().blocked).toBe(true);
    expect(test.session.getSnapshot().generation).toBe(0);
    publication.receive(corrected, true);
    expect(publication.getSnapshot().blocked).toBe(false);
    expect(test.session.getSnapshot().generation).toBe(1);
    expect(test.session.getSnapshot().blocks[0]?.content).toMatchObject({
      runs: [{ text: "😀z" }],
    });
    publication.receive(corrected, true);
    expect(test.session.getSnapshot().generation).toBe(1);
    publication.receive({ ...event("😀bad", 3), selection: { start: 1, end: 2 } }, true);
    publication.receive(corrected, true);
    expect(publication.getSnapshot().blocked).toBe(true);
    expect(test.session.getSnapshot().generation).toBe(1);
    publication.receive(event("Recovered newer revision", 4), true);
    expect(publication.getSnapshot().blocked).toBe(false);
    await test.editing.finish(owner, focus.token);

    const next = test.editing.focus(Symbol(), block.id);
    expect(next.publication.getSnapshot().observed.revision).toBe(0);
    publication.receive(event("Released owner with very high revision", 100), true);
    expect(publication.getSnapshot().blocked).toBe(true);
    next.publication.receive(event("New owner starts at revision one", 1), true);
    expect(next.publication.getSnapshot().blocked).toBe(false);
    expect(test.session.getSnapshot().blocks[0]?.content).toMatchObject({
      runs: [{ text: "New owner starts at revision one" }],
    });
    await test.editing.finish(next.owner, next.token);
  });

  it("does not trust revisions from malformed native envelopes when recovering publication", async () => {
    for (const patch of [
      { revision: -1 },
      { revision: 1.5 },
      { revision: Number.NaN },
      { revision: Number.POSITIVE_INFINITY },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { revision: "100" },
      { revision: 100, version: 2 },
      { revision: 100, runs: [{ text: "Missing styles" }] },
      { revision: 100, selection: { start: -1, end: 0 } },
      { revision: 100, composing: "false" },
      { revision: 100, typing: null },
      { revision: 100, unexpected: true },
    ]) {
      const test = setup();
      await test.session.hydrate({ revision: 40, blocks: [block] });
      const focus = test.editing.focus(Symbol(), block.id);
      const publication = focus.publication;
      const initial = publication.getSnapshot();
      publication.receive({ ...event("Must not be admitted", 100), ...patch }, true);
      expect(publication.getSnapshot()).toMatchObject({
        blocked: true,
        observed: initial.observed,
        admitted: initial.admitted,
      });
      expect(test.session.getSnapshot().generation).toBe(0);
      publication.receive(event("Valid lower native revision", 1), true);
      expect(publication.getSnapshot().blocked).toBe(false);
      expect(test.session.getSnapshot().blocks[0]?.content).toMatchObject({
        runs: [{ text: "Valid lower native revision" }],
      });
      await test.editing.finish(focus.owner, focus.token);
    }
  });

  it("targets only the current native selection and refuses stale, composing, unsupported or rejected formatting while retaining local history recovery", async () => {
    const test = setup();
    await test.session.hydrate({ revision: 40, blocks: [block] });
    const owner = Symbol();
    const focus = test.editing.focus(owner, block.id);
    const publication = focus.publication;
    const initial = publication.getSnapshot().observed;
    publication.receive({ ...initial, selection: { start: 8, end: 10 } }, false);
    const selected = publication.getSnapshot().observed;
    expect(JSON.parse(publication.formatCommand("italic", selected))).toEqual({
      revision: 0,
      selection: { start: 8, end: 10 },
      mark: "italic",
      enabled: true,
    });
    expect(test.session.getSnapshot().generation).toBe(0);
    expect(() => publication.formatCommand("italic", initial)).toThrow("selection changed");
    expect(() => publication.formatCommand("strike" as SpacesNativeMark, selected)).toThrow(
      "read-only",
    );
    publication.receive({ ...selected, revision: 1, composing: true }, true);
    const composing = publication.getSnapshot().observed;
    expect(() => publication.formatCommand("bold", composing)).toThrow("composition");
    expect(() => publication.historyRevision(composing)).toThrow("composition");
    publication.receive(initial, true);
    expect(publication.getSnapshot().observed).toBe(composing);
    publication.receive({ ...selected, revision: 2 }, true);
    publication.receive({ ...selected, revision: 3, selection: { start: 9, end: 10 } }, true);
    expect(publication.getSnapshot().blocked).toBe(true);
    expect(() => publication.formatCommand("bold", publication.getSnapshot().observed)).toThrow(
      "rejected",
    );
    expect(publication.historyRevision(publication.getSnapshot().observed)).toBe(2);
    publication.receive({ ...selected, revision: 2 }, false);
    expect(publication.getSnapshot().blocked).toBe(true);
    publication.receive({ ...selected, revision: 4 }, true);
    expect(publication.getSnapshot().blocked).toBe(false);
    test.editing.assertFocused(owner, focus.token);
    await test.editing.finish(owner, focus.token);
    expect(() => test.editing.assertFocused(owner, focus.token)).toThrow("no longer owns");
  });
  it("retains a rejected native edit through selection and waits for persistence before releasing its owner", async () => {
    const writing = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const test = setup({
      load: async () => null,
      write: async () => {
        writing.resolve();
        await commit.promise;
      },
    });
    await test.session.hydrate({ revision: 4, blocks: [block] });
    const owner = Symbol();
    const focus = test.editing.focus(owner, block.id);
    focus.publication.receive(event("x".repeat(600), 1), true);
    expect(focus.publication.getSnapshot()).toMatchObject({
      blocked: true,
      observed: { revision: 1 },
      admitted: { revision: 0 },
    });
    expect(test.session.getSnapshot().blocks).toEqual([block]);
    await expect(test.editing.finish(owner, focus.token)).rejects.toThrow("recover");
    expect(() => test.editing.focus(Symbol(), block.id)).toThrow("Finish");
    focus.publication.receive(event("Recovered😀", 2), false);
    expect(focus.publication.getSnapshot().blocked).toBe(true);
    expect(test.session.getSnapshot().generation).toBe(0);
    focus.publication.receive(event("Recovered😀", 2), true);
    expect(focus.publication.getSnapshot().blocked).toBe(false);
    expect(test.session.getSnapshot()).toMatchObject({
      generation: 1,
      dirty: true,
      blocks: [
        {
          ...block,
          content: {
            level: 2,
            runs: [
              {
                text: "Recovered😀",
                marks: [
                  { type: "bold", version: 1 },
                  { type: "italic", version: 1 },
                  { type: "code", version: 1 },
                  { type: "link", version: 1, href: "https://t2.codes" },
                ],
              },
            ],
          },
        },
      ],
    });
    const ending = test.editing.finish(owner, focus.token);
    await writing.promise;
    expect(test.editing.getSnapshot().focus?.owner).toBe(owner);
    focus.publication.receive(event("Late bridge delivery😀", 3), true);
    commit.resolve();
    await expect(ending).rejects.toThrow("changed while retaining");
    expect(test.editing.getSnapshot().focus?.owner).toBe(owner);
    await test.editing.finish(owner, focus.token);
    expect(test.editing.getSnapshot().focus).toBeNull();
    const next = test.editing.focus(owner, block.id);
    focus.publication.receive(event("Stale unmounted native editor", 4), true);
    expect(focus.publication.getSnapshot().blocked).toBe(true);
    expect(test.session.getSnapshot().generation).toBe(2);
    await expect(test.editing.finish(owner, focus.token)).rejects.toThrow("no longer owns");
    expect(test.editing.getSnapshot().focus?.token).toBe(next.token);
  });

  it("does not overwrite another generation or accept new content at an already observed native revision", async () => {
    const test = setup();
    await test.session.hydrate({ revision: 4, blocks: [block] });
    const focus = test.editing.focus(Symbol(), block.id);
    focus.publication.receive(event("Committed native", 1), true);
    const accepted = test.session.getSnapshot();
    focus.publication.receive(event("Conflicting same revision", 1), true);
    expect(focus.publication.getSnapshot().blocked).toBe(true);
    expect(test.session.getSnapshot().blocks).toEqual(accepted.blocks);
    test.session.apply([
      {
        kind: "replace",
        block: {
          ...block,
          content: { level: 2, runs: [{ text: "Other owner generation", marks: [] }] },
        },
      },
    ]);
    focus.publication.receive(event("Native must remain recoverable", 2), true);
    expect(focus.publication.getSnapshot()).toMatchObject({
      blocked: true,
      error: expect.stringContaining("outside this native input"),
    });
    expect(test.session.getSnapshot().blocks[0]?.content).toEqual({
      level: 2,
      runs: [{ text: "Other owner generation", marks: [] }],
    });
    await test.session.persistDraft();
  });

  it("keeps composition unpublished and rechecks live permission when it commits", async () => {
    const test = setup();
    await test.session.hydrate({ revision: 4, blocks: [block] });
    const owner = Symbol();
    const focus = test.editing.focus(owner, block.id);
    focus.publication.receive(event("Composing😀", 1, true), true);
    expect(test.session.getSnapshot().generation).toBe(0);
    await expect(test.editing.finish(owner, focus.token)).rejects.toThrow("composition");
    test.setAccess({ availability: "read-only", capability, current: () => true });
    focus.publication.receive(event("Composing😀", 1), true);
    expect(focus.publication.getSnapshot().blocked).toBe(true);
    expect(test.session.getSnapshot().blocks).toEqual([block]);
    test.setAccess({ availability: "writable", capability, current: () => true });
    focus.publication.receive(event("Composing😀", 1), true);
    expect(test.session.getSnapshot().generation).toBe(1);
    expect(focus.publication.getSnapshot().blocked).toBe(false);
    await test.session.persistDraft();
  });
  it("refuses unsupported envelopes and older or read-only write execution without changing canonical content", async () => {
    const test = setup();
    const unsupported: SpaceBlock[] = [
      {
        ...block,
        id: SpaceBlockId.make("future-fields"),
        content: { level: 2, runs: [{ text: "Keep extras", marks: [], future: { retain: true } }] },
      },
      {
        ...block,
        id: SpaceBlockId.make("unsupported-todo"),
        type: "todo_item",
        content: {
          checked: false,
          runs: [
            { text: "Keep mention", marks: [{ type: "future", version: 2, payload: "keep" }] },
          ],
        },
      },
      {
        ...block,
        id: SpaceBlockId.make("code"),
        type: "code",
        content: { language: "ts", text: "keep code" },
      },
    ];
    await test.session.hydrate({ revision: 4, blocks: [block, ...unsupported] });
    for (const original of unsupported)
      expect(() => test.editing.focus(Symbol(), original.id)).toThrow("read-only");
    expect(() => test.editing.toggleTodo(SpaceBlockId.make("unsupported-todo"))).toThrow(
      "read-only",
    );
    expect(() => test.editing.focus(Symbol(), SpaceBlockId.make("unloaded"))).toThrow("not loaded");
    for (const access of [
      {
        availability: "writable" as const,
        capability: { ...capability, version: 1 },
        current: () => true,
      },
      { availability: "read-only" as const, capability, current: () => true },
      { availability: "writable" as const, capability, current: () => false },
    ]) {
      test.setAccess(access);
      expect(() => test.editing.focus(Symbol(), block.id)).toThrow("permission");
      await test.editing.save();
      expect(test.editing.getSnapshot().error).toContain("permission");
    }
    expect(test.session.getSnapshot()).toMatchObject({
      generation: 0,
      dirty: false,
      blocks: [block, ...unsupported],
    });
  });

  it("retains the draft if access changes while discard reads the current saved window", async () => {
    const test = setup();
    await test.session.hydrate({ revision: 4, blocks: [block] });
    test.session.apply([
      {
        kind: "replace",
        block: { ...block, content: { level: 2, runs: [{ text: "Local retained", marks: [] }] } },
      },
    ]);
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{ revision: number; blocks: SpaceBlock[] }>();
    const editing = new MobileSpaceEditing({
      session: test.session,
      access: () => access,
      readWindow: () => {
        requested.resolve();
        return response.promise;
      },
    });
    let access: SpacesReadAccess = { availability: "writable", capability, current: () => true };
    const before = test.session.getSnapshot();
    const discard = editing.discard();
    await requested.promise;
    access = { availability: "read-only", capability, current: () => true };
    response.resolve({ revision: 5, blocks: [block] });
    await discard;
    expect(editing.getSnapshot().error).toContain("permission");
    expect(test.session.getSnapshot().blocks).toEqual(before.blocks);
    expect(test.session.getSnapshot().dirty).toBe(true);
    await test.session.persistDraft();
  });
  it("refuses a to-do toggle that would exceed the current service block byte limit", async () => {
    const test = setup();
    const todo = {
      ...block,
      type: "todo_item",
      content: { checked: true, runs: [{ text: "", marks: [] }] },
    };
    todo.content.runs[0]!.text = "x".repeat(
      512 - new TextEncoder().encode(JSON.stringify(todo)).byteLength,
    );
    await test.session.hydrate({ revision: 4, blocks: [todo] });
    expect(() => test.editing.toggleTodo(todo.id)).toThrow("byte limit");
    expect(test.session.getSnapshot()).toMatchObject({
      generation: 0,
      dirty: false,
      blocks: [todo],
    });
  });
});
