import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceId,
  SpaceMutationId,
  SpaceReceiptEpoch,
  SpaceBlockId,
  SpacePageId,
} from "@t2code/contracts/spaces";
import {
  checkSpaceStructureDrafts,
  spaceStructureMaxBytes,
  decodeSpaceStructureJournal,
  spaceJsonBytes,
  type SpaceStructureJournal,
  decodeSpaceDocumentDraft,
  spaceDraftMaxBytes,
  type SpaceDocumentDraft,
} from "@t2code/client-runtime/spaces";
import { createSpaceStructureStore } from "./structureDraftStore";
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
  it("retains invalid saved-history data instead of admitting a mismatched or oversized compensation", () => {
    const before = {
      id: SpaceBlockId.make("a"),
      parentId: null,
      order: "40000000000000000000000000000000",
      type: "paragraph",
      version: 1,
      content: { runs: [{ text: "before", marks: [] }] },
    };
    const after = { ...before, content: { runs: [{ text: "after", marks: [] }] } };
    const history = {
      base: [after],
      undo: { before: [before], after: [after], revision: 7 },
      redo: null,
      action: null,
      reason: null,
    };
    const value = { ...draft(), blocks: [after], mutations: [], pending: null, history };
    expect(decodeSpaceDocumentDraft(value, key)).toEqual(value);
    for (const invalid of [
      { ...history, action: "redo" },
      { ...history, redo: history.undo },
      { ...history, base: [before] },
      { ...history, undo: { ...history.undo, before: [{ ...before, id: "retired-other" }] } },
      {
        ...history,
        undo: {
          ...history.undo,
          before: [{ ...before, type: "image", version: 2, content: { assetId: "a" } }],
          after: [{ ...after, type: "image", content: { assetId: "b" } }],
        },
      },
      {
        ...history,
        undo: {
          ...history.undo,
          before: [
            {
              ...before,
              content: { runs: [{ text: "unknown", marks: [{ type: "future", version: 7 }] }] },
            },
          ],
        },
      },
      {
        ...history,
        undo: {
          ...history.undo,
          before: [{ ...before, content: { runs: [{ text: "x".repeat(65536), marks: [] }] } }],
        },
      },
      { ...history, future: true },
    ]) {
      const stored = { ...value, history: invalid },
        original = JSON.stringify(stored);
      expect(() => decodeSpaceDocumentDraft(stored, key)).toThrow();
      expect(JSON.stringify(stored)).toBe(original);
    }
  });
});

it("fails closed for the structural journal on repeated missing-IndexedDB recovery attempts", async () => {
  const store = createSpaceStructureStore();
  const journal = {
    version: 1 as const,
    environmentId: key.environmentId,
    pending: null,
    history: null,
  };
  await expect(store.load(key.environmentId)).rejects.toThrow("IndexedDB is unavailable");
  await expect(store.write(key.environmentId, journal)).rejects.toThrow("IndexedDB is unavailable");
  await expect(store.load(key.environmentId)).rejects.toThrow("IndexedDB is unavailable");
});

it("rejects invalid structural records and guard overflows without altering their retained source", () => {
  const spaceId = SpaceId.make("s");
  const guards = {
    pages: [{ pageId: key.pageId, revision: 0 }],
    roots: [{ spaceId, rootOrderRevision: 0 }],
  };
  const destination = { kind: "root" as const, spaceId, beforePageId: null };
  const journal: SpaceStructureJournal = {
    version: 1,
    environmentId: key.environmentId,
    history: null,
    pending: {
      request: {
        operation: "movePage",
        input: {
          ...key,
          mutationId: SpaceMutationId.make("move"),
          receiptEpoch: SpaceReceiptEpoch.make("epoch"),
          destination,
          guards,
        },
      },
      inverse: destination,
      observed: guards,
      direction: "move",
      conflict: false,
    },
  };
  for (const change of [
    (v: SpaceStructureJournal) => ({ ...v, environmentId: "other" }),
    (v: SpaceStructureJournal) => ({
      ...v,
      pending: { ...v.pending!, request: { ...v.pending!.request, extra: true } },
    }),
    (v: SpaceStructureJournal) => ({
      ...v,
      pending: {
        ...v.pending!,
        request: {
          operation: "movePage",
          input: { ...v.pending!.request.input, receiptEpoch: undefined },
        },
      },
    }),
    (v: SpaceStructureJournal) => ({
      ...v,
      pending: {
        ...v.pending!,
        observed: {
          ...guards,
          pages: Array.from({ length: 9 }, (_, i) => ({
            pageId: SpacePageId.make(`p-${i}`),
            revision: 0,
          })),
        },
      },
    }),
    (v: SpaceStructureJournal) => ({
      ...v,
      pending: {
        ...v.pending!,
        observed: { ...guards, pages: [...guards.pages, ...guards.pages] },
      },
    }),
    (v: SpaceStructureJournal) => ({
      ...v,
      pending: {
        ...v.pending!,
        observed: { ...guards, roots: [{ spaceId, rootOrderRevision: 1 }] },
      },
    }),
  ]) {
    const value = change(journal);
    const before = JSON.stringify(value);
    expect(() => decodeSpaceStructureJournal(value, key.environmentId)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  }
  const eight = Array.from({ length: 8 }, (_, i) => ({
    pageId: i === 0 ? key.pageId : SpacePageId.make(`p-${i}`),
    revision: 0,
  }));
  expect(
    decodeSpaceStructureJournal(
      { ...journal, pending: { ...journal.pending!, observed: { ...guards, pages: eight } } },
      key.environmentId,
    ).pending?.observed.pages,
  ).toHaveLength(8);
});

it("bounds retained placement history by exact UTF8 bytes at the boundary and one byte beyond", () => {
  const spaceId = SpaceId.make("s");
  const pageId = key.pageId;
  const guards = { pages: [{ pageId, revision: 1 }], roots: [{ spaceId, rootOrderRevision: 1 }] };
  const h = {
    pageId,
    direction: "undo" as const,
    guards,
    observed: guards,
    destination: { kind: "root" as const, spaceId, beforePageId: SpacePageId.make("é") },
    opposite: { kind: "root" as const, spaceId, beforePageId: null },
  };
  const used = spaceJsonBytes(h, 256 * 1024);
  const exact = {
    ...h,
    destination: {
      ...h.destination,
      beforePageId: SpacePageId.make("é" + "x".repeat(256 * 1024 - used)),
    },
  };
  expect(spaceJsonBytes(exact, 256 * 1024)).toBe(256 * 1024);
  const journal = { version: 1, environmentId: key.environmentId, pending: null, history: exact };
  expect(decodeSpaceStructureJournal(journal, key.environmentId).history).toEqual(exact);
  expect(() =>
    decodeSpaceStructureJournal(
      {
        ...journal,
        history: {
          ...exact,
          destination: { ...exact.destination, beforePageId: exact.destination.beforePageId + "x" },
        },
      },
      key.environmentId,
    ),
  ).toThrow("byte limit");
});

it("enforces the independent retained wire and whole journal byte ceilings without applying new-policy limits", () => {
  const spaceId = SpaceId.make("s");
  const guards = {
    pages: [{ pageId: key.pageId, revision: 0 }],
    roots: [{ spaceId, rootOrderRevision: 0 }],
  };
  const destination = { kind: "root" as const, spaceId, beforePageId: null };
  const journal: SpaceStructureJournal = {
    version: 1,
    environmentId: key.environmentId,
    history: null,
    pending: {
      request: {
        operation: "movePage",
        input: {
          ...key,
          mutationId: SpaceMutationId.make("move"),
          receiptEpoch: SpaceReceiptEpoch.make("epoch"),
          destination,
          guards,
        },
      },
      inverse: destination,
      observed: guards,
      direction: "move",
      conflict: false,
    },
  };
  const wireBytes = spaceJsonBytes(journal.pending!.request, 1024 * 1024);
  const exactWire = {
    ...journal,
    pending: {
      ...journal.pending!,
      request: {
        ...journal.pending!.request,
        input: {
          ...journal.pending!.request.input,
          receiptEpoch: SpaceReceiptEpoch.make("epoch" + "x".repeat(1024 * 1024 - wireBytes)),
        },
      },
    },
  };
  expect(spaceJsonBytes(exactWire.pending.request, 1024 * 1024)).toBe(1024 * 1024);
  expect(decodeSpaceStructureJournal(exactWire, key.environmentId)).toEqual(exactWire);
  expect(() =>
    decodeSpaceStructureJournal(
      {
        ...exactWire,
        pending: {
          ...exactWire.pending,
          request: {
            ...exactWire.pending.request,
            input: {
              ...exactWire.pending.request.input,
              receiptEpoch: exactWire.pending.request.input.receiptEpoch + "x",
            },
          },
        },
      },
      key.environmentId,
    ),
  ).toThrow("byte limit");
  const withPeer = {
    ...journal,
    pending: {
      ...journal.pending!,
      observed: {
        ...guards,
        pages: [...guards.pages, { pageId: SpacePageId.make("peer"), revision: 0 }],
      },
    },
  };
  const used = spaceJsonBytes(withPeer, spaceStructureMaxBytes);
  const exactRecord = {
    ...withPeer,
    pending: {
      ...withPeer.pending,
      observed: {
        ...withPeer.pending.observed,
        pages: [
          ...guards.pages,
          {
            pageId: SpacePageId.make("peer" + "x".repeat(spaceStructureMaxBytes - used)),
            revision: 0,
          },
        ],
      },
    },
  };
  expect(spaceJsonBytes(exactRecord, spaceStructureMaxBytes)).toBe(spaceStructureMaxBytes);
  expect(decodeSpaceStructureJournal(exactRecord, key.environmentId)).toEqual(exactRecord);
  expect(() =>
    decodeSpaceStructureJournal(
      { ...exactRecord, environmentId: key.environmentId + "x" },
      key.environmentId,
    ),
  ).toThrow("byte limit");
});

it("admits exactly eight draft checks and four MiB cumulative decoded records, refusing the whole over-budget operation", async () => {
  const keys = Array.from({ length: 9 }, (_, i) => ({
    ...key,
    pageId: SpacePageId.make(`budget-${i}`),
  }));
  const records = new Map<string, SpaceDocumentDraft>();
  for (const target of keys.slice(0, 2)) {
    const b = { ...draft().blocks[0]!, content: { retained: "" } };
    const value = {
      ...draft(),
      key: target,
      generation: 0,
      mutations: [],
      pending: null,
      blocks: [b],
    };
    const size = spaceJsonBytes(value, spaceDraftMaxBytes);
    b.content.retained = "x".repeat(spaceDraftMaxBytes - size);
    records.set(target.pageId, decodeSpaceDocumentDraft(value, target));
  }
  const loaded: string[] = [];
  const store = {
    load: async (target: typeof key) => {
      loaded.push(target.pageId);
      return records.get(target.pageId) ?? null;
    },
    write: async () => {},
  };
  await checkSpaceStructureDrafts(
    store,
    key.environmentId,
    keys.slice(0, 8).map((k) => k.pageId),
  );
  expect(loaded).toHaveLength(8);
  loaded.length = 0;
  await expect(
    checkSpaceStructureDrafts(
      store,
      key.environmentId,
      keys.map((k) => k.pageId),
    ),
  ).rejects.toThrow("eight");
  expect(loaded).toHaveLength(0);
  const target = keys[2]!;
  records.set(
    target.pageId,
    decodeSpaceDocumentDraft(
      { ...draft(), key: target, generation: 0, mutations: [], pending: null },
      target,
    ),
  );
  await expect(
    checkSpaceStructureDrafts(
      store,
      key.environmentId,
      keys.slice(0, 3).map((k) => k.pageId),
    ),
  ).rejects.toThrow("read budget");
  expect(records.size).toBe(3);
});

it("decodes exact nested placement receipts with zero root guards and refuses missing child context or excess roots", () => {
  const parent = SpacePageId.make("owner-parent"),
    other = SpacePageId.make("destination-parent"),
    spaceId = SpaceId.make("space");
  const guards = {
    pages: [
      { pageId: key.pageId, revision: 1 },
      { pageId: parent, revision: 4 },
      { pageId: other, revision: 8 },
    ],
    roots: [],
  };
  const value: SpaceStructureJournal = {
    version: 1,
    environmentId: key.environmentId,
    history: null,
    pending: {
      request: {
        operation: "movePage",
        input: {
          ...key,
          mutationId: SpaceMutationId.make("nested-intent"),
          receiptEpoch: SpaceReceiptEpoch.make("original-epoch"),
          guards,
          destination: {
            kind: "child",
            placement: { pageId: other, parentId: null, beforeBlockId: null },
          },
        },
      },
      inverse: {
        kind: "child",
        placement: { pageId: parent, parentId: null, beforeBlockId: null },
      },
      sourceLocation: {
        kind: "child",
        spaceId,
        parentPageId: parent,
        ownerBlockId: SpaceBlockId.make("existing-owner"),
      },
      targetSpaceId: spaceId,
      observed: guards,
      direction: "move",
      conflict: false,
    },
  };
  expect(decodeSpaceStructureJournal(value, key.environmentId)).toEqual(value);
  const before = JSON.stringify(value);
  expect(() =>
    decodeSpaceStructureJournal(
      { ...value, pending: { ...value.pending, targetSpaceId: undefined } },
      key.environmentId,
    ),
  ).toThrow();
  expect(() =>
    decodeSpaceStructureJournal(
      {
        ...value,
        pending: {
          ...value.pending,
          observed: {
            ...guards,
            roots: [1, 2, 3].map((i) => ({ spaceId: `root-${i}`, rootOrderRevision: 0 })),
          },
        },
      },
      key.environmentId,
    ),
  ).toThrow();
  expect(JSON.stringify(value)).toBe(before);
});

it("retains the exact block-move operation and selected-root order and rejects malformed ownership or duplicate roots", () => {
  const destination = SpacePageId.make("block-destination");
  const guards = {
    pages: [
      { pageId: key.pageId, revision: 1 },
      { pageId: destination, revision: 2 },
    ],
    roots: [],
  };
  const ids = [SpaceBlockId.make("a"), SpaceBlockId.make("b")];
  const value: SpaceStructureJournal = {
    version: 1,
    environmentId: key.environmentId,
    history: null,
    pending: {
      request: {
        operation: "moveBlocks",
        input: {
          environmentId: key.environmentId,
          sourcePageId: key.pageId,
          blockIds: ids,
          destination: { pageId: destination, parentId: null, beforeBlockId: null },
          guards,
          mutationId: SpaceMutationId.make("original-block-move"),
          receiptEpoch: SpaceReceiptEpoch.make("original-block-epoch"),
        },
      },
      inverse: {
        kind: "child",
        placement: { pageId: key.pageId, parentId: null, beforeBlockId: null },
      },
      observed: guards,
      direction: "move",
      conflict: false,
    },
  };
  const pending = value.pending;
  if (!pending || pending.request.operation !== "moveBlocks")
    throw new Error("Expected block move");
  const input = pending.request.input;
  const exact = { ...value, pending };
  expect(decodeSpaceStructureJournal(exact, key.environmentId)).toEqual(exact);
  const before = JSON.stringify(exact);
  expect(() =>
    decodeSpaceStructureJournal(
      {
        ...exact,
        pending: {
          ...exact.pending,
          request: { ...exact.pending.request, input: { ...input, blockIds: [...ids, ids[0]] } },
        },
      },
      key.environmentId,
    ),
  ).toThrow();
  expect(() =>
    decodeSpaceStructureJournal(
      {
        ...exact,
        pending: {
          ...exact.pending,
          inverse: {
            kind: "child",
            placement: { pageId: destination, parentId: null, beforeBlockId: null },
          },
        },
      },
      key.environmentId,
    ),
  ).toThrow("ownership or inverse");
  expect(() =>
    decodeSpaceStructureJournal(
      {
        ...exact,
        pending: {
          ...exact.pending,
          request: {
            ...exact.pending.request,
            input: { ...input, guards: { pages: [guards.pages[0]], roots: [] } },
          },
        },
      },
      key.environmentId,
    ),
  ).toThrow();
  expect(JSON.stringify(exact)).toBe(before);
});

it("retains exact child/recovery journal identities and rejects inconsistent operation metadata without changing source", () => {
  const pageId = SpacePageId.make("parent");
  const guards = { pages: [{ pageId, revision: 3 }], roots: [] };
  const input = {
    environmentId: key.environmentId,
    mutationId: SpaceMutationId.make("new-operation"),
    receiptEpoch: SpaceReceiptEpoch.make("captured"),
    guards,
  };
  const common = { inverse: null, observed: guards, direction: "move", conflict: false };
  const records = [
    {
      ...common,
      targetSpaceId: SpaceId.make("space"),
      knownBlockIds: [],
      request: {
        operation: "createChildPage",
        input: {
          ...input,
          title: "Child",
          placement: { pageId, parentId: null, beforeBlockId: null },
        },
      },
    },
    ...["trashPage", "restorePage"].map((operation) => ({
      ...common,
      recoveryPageIds: [pageId],
      request: { operation, input: { ...input, pageId } },
    })),
  ];
  for (const pending of records) {
    const journal = { version: 1, environmentId: key.environmentId, pending, history: null };
    expect(decodeSpaceStructureJournal(journal, key.environmentId)).toEqual(journal);
    const invalid =
      pending.request.operation === "createChildPage"
        ? [
            { ...pending, knownBlockIds: undefined },
            { ...pending, recoveryPageIds: [pageId] },
            { ...pending, inverse: { kind: "root", spaceId: "space", beforePageId: null } },
          ]
        : [
            { ...pending, recoveryPageIds: [] },
            { ...pending, recoveryPageIds: [pageId, pageId] },
            { ...pending, recoveryPageIds: ["unguarded"] },
            { ...pending, knownBlockIds: [] },
          ];
    for (const value of invalid) {
      const retained = { ...journal, pending: value };
      const before = JSON.stringify(retained);
      expect(() => decodeSpaceStructureJournal(retained, key.environmentId)).toThrow();
      expect(JSON.stringify(retained)).toBe(before);
    }
  }
});

it("validates retained recovery compensation context and pending direction without altering invalid data", () => {
  const pageId = SpacePageId.make("recovery-root");
  const spaceId = SpaceId.make("space");
  const order = "40000000000000000000000000000000";
  const page = {
    id: pageId,
    spaceId,
    title: "Retained",
    revision: 3,
    rootOrder: order,
    location: { kind: "root", spaceId, order },
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    trash: { batchId: "batch", originalRootPageId: pageId, trashedAt: "2026-10-27T00:00:00.000Z" },
  };
  const guards = { pages: [{ pageId, revision: 3 }], roots: [{ spaceId, rootOrderRevision: 2 }] };
  const history = {
    operation: "restorePage",
    scope: "page recovery",
    pageId,
    pageIds: [pageId],
    pages: [page],
    guards,
    observed: guards,
    direction: "undo",
  };
  const pending = {
    request: {
      operation: "restorePage",
      input: {
        environmentId: key.environmentId,
        pageId,
        mutationId: SpaceMutationId.make("undo-recovery"),
        receiptEpoch: SpaceReceiptEpoch.make("fixed"),
        guards,
      },
    },
    recoveryPageIds: [pageId],
    recoveryBefore: [page],
    recoveryScope: "page recovery",
    inverse: null,
    observed: guards,
    direction: "undo",
    conflict: false,
  };
  const journal = { version: 1, environmentId: key.environmentId, pending, history };
  expect(decodeSpaceStructureJournal(journal, key.environmentId)).toEqual(journal);
  for (const invalid of [
    { ...journal, history: { ...history, pageIds: [pageId, pageId] } },
    { ...journal, history: { ...history, pages: [{ ...page, revision: 4 }] } },
    { ...journal, history: { ...history, operation: "trashPage" } },
    { ...journal, pending: { ...pending, recoveryBefore: [] } },
    { ...journal, pending: { ...pending, direction: "redo" } },
    { ...journal, pending: { ...pending, recoveryScope: "created child" } },
    { ...journal, pending: { ...pending, rejection: "invalid_input", conflict: true } },
  ]) {
    const before = JSON.stringify(invalid);
    expect(() => decodeSpaceStructureJournal(invalid, key.environmentId)).toThrow();
    expect(JSON.stringify(invalid)).toBe(before);
  }
});

it("rejects restored library intents whose retained target or affected-draft proof differs from the exact wire request", () => {
  const pageId = SpacePageId.make("rename-target"),
    spaceId = SpaceId.make("library-space");
  const page = {
    id: pageId,
    spaceId,
    title: "Before",
    revision: 3,
    rootOrder: "40000000000000000000000000000000",
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
  };
  const pending = {
    request: {
      operation: "updatePage",
      input: {
        environmentId: key.environmentId,
        pageId,
        baseRevision: 3,
        title: "After",
        mutationId: SpaceMutationId.make("fixed-library"),
        receiptEpoch: SpaceReceiptEpoch.make("fixed-library-epoch"),
      },
    },
    library: { version: 2, page },
    inverse: null,
    direction: "move",
    conflict: false,
    observed: { pages: [{ pageId, revision: 3 }], roots: [] },
  };
  const journal = { version: 1, environmentId: key.environmentId, pending, history: null };
  for (const invalid of [
    { ...pending, library: undefined },
    { ...pending, library: { ...pending.library, page: { ...page, id: "other" } } },
    { ...pending, library: { ...pending.library, page: { ...page, revision: 4 } } },
    {
      ...pending,
      library: {
        ...pending.library,
        page: {
          ...page,
          trash: { batchId: "trash", originalRootPageId: pageId, trashedAt: page.updatedAt },
        },
      },
    },
    { ...pending, observed: { pages: [], roots: [] } },
    {
      ...pending,
      library: { ...pending.library, knownIds: Array.from({ length: 51 }, (_, i) => `known-${i}`) },
    },
    { ...pending, direction: "undo" },
    { ...pending, recoveryPageIds: [] },
    {
      ...pending,
      request: { ...pending.request, input: { ...pending.request.input, unexpected: "retain" } },
    },
    {
      ...pending,
      request: { ...pending.request, input: { ...pending.request.input, environmentId: "other" } },
    },
  ]) {
    const value = { ...journal, pending: invalid },
      before = JSON.stringify(value);
    expect(() => decodeSpaceStructureJournal(value, key.environmentId)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  }
});
