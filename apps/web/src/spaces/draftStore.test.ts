import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpacePageId } from "@t2code/contracts/spaces";
import {
  decodeSpaceDocumentDraft,
  spaceDraftMaxBytes,
  type SpaceDocumentDraft,
} from "@t2code/client-runtime/spaces";
import { createSpaceDraftStore } from "./draftStore";

const key = {
  environmentId: EnvironmentId.make("draft-env"),
  pageId: SpacePageId.make("draft-page"),
};
function draft(): SpaceDocumentDraft {
  const block = {
    id: SpaceBlockId.make("a"),
    parentId: null,
    order: "00000000000000000000000000000001",
    type: "paragraph",
    version: 1,
    content: { runs: [{ text: "retained", marks: [] }], opaque: { constructor: "preserved" } },
    extra: [false, null, "future"],
  };
  const mutations = [{ kind: "replace" as const, block }];
  return {
    version: 1,
    key,
    baseRevision: 7,
    generation: 3,
    memberIds: [block.id],
    blocks: [block],
    mutations,
    pending: { key, mutationId: "legacy", baseRevision: 7, generation: 3, mutations },
  };
}

describe("Spaces draft decoding and unavailable storage", () => {
  it("retains opaque fields and legacy intent without manufacturing an epoch", () => {
    const value = draft();
    expect(decodeSpaceDocumentDraft(value, key)).toEqual(value);
    expect(decodeSpaceDocumentDraft(value, key).pending).not.toHaveProperty("receiptEpoch");
  });
  it.each([
    (value: SpaceDocumentDraft) => ({ ...value, version: 2 }),
    (value: SpaceDocumentDraft) => ({ ...value, key: { ...key, pageId: "other" } }),
    (value: SpaceDocumentDraft) => ({ ...value, generation: Number.MAX_SAFE_INTEGER + 1 }),
    (value: SpaceDocumentDraft) => ({ ...value, memberIds: [] }),
    (value: SpaceDocumentDraft) => ({ ...value, pending: { ...value.pending!, generation: 4 } }),
    (value: SpaceDocumentDraft) => ({
      ...value,
      pending: { ...value.pending!, mutations: [{ kind: "delete", blockId: "a" }] },
    }),
    (value: SpaceDocumentDraft) => ({
      ...value,
      blocks: [{ ...value.blocks[0]!, content: { tooLarge: "x".repeat(spaceDraftMaxBytes) } }],
    }),
  ])("rejects an invalid record without changing its source", (change) => {
    const value = change(draft());
    const before = JSON.stringify(value);
    expect(() => decodeSpaceDocumentDraft(value, key)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });
  it("reports missing IndexedDB on repeated load/write rather than pretending to persist", async () => {
    const store = createSpaceDraftStore();
    await expect(store.load(key)).rejects.toThrow("IndexedDB is unavailable");
    await expect(store.write(key, draft())).rejects.toThrow("IndexedDB is unavailable");
    await expect(store.write(key, null)).rejects.toThrow("IndexedDB is unavailable");
  });
});
