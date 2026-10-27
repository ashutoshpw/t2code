import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, MessageId, ThreadId } from "@t2code/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t2code/shared/assistantCitations";

import { removeLocalStorageItem } from "./hooks/useLocalStorage";

import {
  MAX_STASH_ENTRIES,
  PROMPT_STASH_STORAGE_KEY,
  MAX_STASH_ENTRY_ATTACHMENT_CHARS,
  partitionStashAttachments,
  usePromptStashStore,
  writePromptStashStorageForTest,
  type PromptStashEntry,
} from "./promptStashStore";

function makeEntry(input: {
  id: string;
  prompt?: string;
  attachmentChars?: number;
}): PromptStashEntry {
  return {
    id: input.id,
    createdAt: "2026-07-24T12:00:00.000Z",
    prompt: input.prompt ?? `prompt ${input.id}`,
    attachments:
      input.attachmentChars !== undefined
        ? [
            {
              id: `${input.id}-img`,
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: input.attachmentChars,
              dataUrl: "x".repeat(input.attachmentChars),
            },
          ]
        : [],
    droppedImageNames: [],
  };
}

function resetPromptStashStore() {
  usePromptStashStore.setState({ entries: [] });
  writePromptStashStorageForTest("");
  removeLocalStorageItem(PROMPT_STASH_STORAGE_KEY);
}

describe("partitionStashAttachments", () => {
  it("keeps attachments within the budget and reports dropped names in order", () => {
    const small = {
      id: "a",
      name: "small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const huge = {
      id: "b",
      name: "huge.png",
      mimeType: "image/png",
      sizeBytes: MAX_STASH_ENTRY_ATTACHMENT_CHARS,
      dataUrl: "x".repeat(MAX_STASH_ENTRY_ATTACHMENT_CHARS),
    };
    const alsoSmall = {
      id: "c",
      name: "also-small.png",
      mimeType: "image/png",
      sizeBytes: 10,
      dataUrl: "x".repeat(10),
    };
    const { kept, droppedNames } = partitionStashAttachments([small, huge, alsoSmall]);
    expect(kept.map((attachment) => attachment.id)).toEqual(["a", "c"]);
    expect(droppedNames).toEqual(["huge.png"]);
  });
});

describe("promptStashStore", () => {
  beforeEach(() => {
    resetPromptStashStore();
  });

  afterEach(() => {
    resetPromptStashStore();
  });

  it("restores citations and bound comments from a persisted stash", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("remote-source"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: "A quote to revisit later.",
      comment: "Revisit this tomorrow.\nCheck whether the example still applies.",
      start: 0,
      end: 24,
      prefix: "",
      suffix: " Next.",
    };
    const prompt = `Revisit ${serializeAssistantCitation(citation)}`;
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [makeEntry({ id: "citation-stash", prompt })] },
      }),
    );
    const restored = usePromptStashStore.getState().takeEntry("citation-stash").entry;
    expect(restored?.prompt).toBe(prompt);
    expect(
      collectAssistantCitations(restored?.prompt ?? "").map((entry) => entry.citation),
    ).toEqual([citation]);
    expect(usePromptStashStore.getState().takeEntry("citation-stash").entry).toBeNull();
  });

  it("evicts the oldest entry past the cap and returns it", () => {
    const store = usePromptStashStore.getState();
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      expect(store.stashEntry(makeEntry({ id: `entry-${index}` })).evicted).toBeNull();
    }
    const { evicted } = store.stashEntry(makeEntry({ id: "overflow" }));
    expect(evicted?.id).toBe("entry-0");
    const entries = usePromptStashStore.getState().entries;
    expect(entries).toHaveLength(MAX_STASH_ENTRIES);
    expect(entries[0]?.id).toBe("overflow");
  });

  // regression: #4787 stashed prompts were lost when switching providers
  it("distinguishes a memory-only write (written, not durable) from a failed one", () => {
    const store = usePromptStashStore.getState();
    const result = store.stashEntry(makeEntry({ id: "memory-only" }));
    expect(result.written).toBe(true);
    expect(result.durable).toBe(false);
    expect(usePromptStashStore.getState().entries.map((entry) => entry.id)).toEqual([
      "memory-only",
    ]);
  });

  it("takeEntry returns images and drop metadata finalized after a menu snapshot", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "pending-restore" }), pendingImageCount: 1 });
    const menuSnapshot = usePromptStashStore.getState().entries[0];
    expect(menuSnapshot?.attachments).toEqual([]);

    store.finalizeEntryImages("pending-restore", {
      attachments: [
        {
          id: "img-finalized",
          name: "finalized.webp",
          mimeType: "image/webp",
          sizeBytes: 12,
          dataUrl: "data:image/webp;base64,BBBB",
        },
      ],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
    });

    const { entry: taken } = store.takeEntry("pending-restore");
    expect(taken).not.toBe(menuSnapshot);
    expect(taken).toMatchObject({
      attachments: [
        {
          id: "img-finalized",
          name: "finalized.webp",
        },
      ],
      droppedImageNames: ["too-large.png"],
      unreadableImageNames: ["unreadable.png"],
      pendingImageCount: 0,
    });
  });

  it("preserves uploaded file references without storing file contents", () => {
    const store = usePromptStashStore.getState();
    const file = {
      id: "file-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      attachmentId: "pending-report-pdf",
      environmentId: EnvironmentId.make("environment-1"),
    };

    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: { entries: [{ ...makeEntry({ id: "with-file" }), files: [file] }] },
      }),
    );
    store.finalizeEntryImages("with-file", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(usePromptStashStore.getState().entries[0]?.files).toEqual([file]);
  });

  it("finalizeEntryImages reports false when the entry was already taken", () => {
    const store = usePromptStashStore.getState();
    store.stashEntry({ ...makeEntry({ id: "racing" }), pendingImageCount: 1 });
    store.takeEntry("racing");

    const { attached } = store.finalizeEntryImages("racing", {
      attachments: [],
      droppedImageNames: [],
      unreadableImageNames: [],
    });

    expect(attached).toBe(false);
  });

  it("settles a pending count left behind by a crashed or closed session", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [{ ...makeEntry({ id: "orphan" }), pendingImageCount: 2 }],
        },
      }),
    );

    const entry = usePromptStashStore.getState().entries[0];
    expect(entry?.pendingImageCount).toBe(0);
    expect(entry?.unreadableImageNames).toHaveLength(2);
  });

  it("ignores an unreadable v1 payload seeded under the current key", () => {
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 1,
        state: { queuesByScopeKey: { "provider:claudeAgent": [] } },
      }),
    );
    expect(usePromptStashStore.getState().entries).toEqual([]);
  });
});

describe("prompt stash context records", () => {
  it("restores the records behind a persisted prompt's chips", () => {
    const records = [
      {
        version: 1 as const,
        contextId: "ctx-1" as never,
        kind: "terminal" as const,
        label: "Terminal 1 line 4",
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "boom",
      },
    ];
    writePromptStashStorageForTest(
      JSON.stringify({
        version: 2,
        state: {
          entries: [
            {
              id: "entry-records",
              createdAt: "2026-01-01T00:00:00.000Z",
              prompt: "see [Terminal 1 line 4](t2-context://v1/terminal/ctx-1)",
              attachments: [],
              droppedImageNames: [],
              records,
            },
          ],
        },
      }),
    );
    const taken = usePromptStashStore.getState().takeEntry("entry-records");
    expect(taken.entry?.records).toEqual(records);
  });
});

it("refuses automatic recovery in memory-only storage without adding an entry", () => {
  expect(
    usePromptStashStore.getState().reserveSendRecovery({
      ...makeEntry({ id: "automatic" }),
      recovery: {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        targetKey: "target",
        context: {},
      },
    }),
  ).toEqual({ written: false, durable: false });
  expect(usePromptStashStore.getState().entries).toEqual([]);
});

it("rehydrates exact recovery context and never evicts it or removes a different reservation", async () => {
  const values = new Map<string, string>();
  let rejectWrites = false;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (rejectWrites) throw new Error("Storage quota exceeded");
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  try {
    const first = await import("./promptStashStore");
    const entry = {
      ...makeEntry({ id: "recovery", prompt: "  Exact prompt  " }),
      recovery: {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        targetKey: "target",
        context: {},
      },
    };
    expect(first.usePromptStashStore.getState().reserveSendRecovery(entry)).toEqual({
      written: true,
      durable: true,
    });
    const other = { ...entry, id: "another-recovery", prompt: "A separate failed send" };
    expect(first.usePromptStashStore.getState().reserveSendRecovery(other).durable).toBe(true);
    first.usePromptStashStore.getState().settleSendRecovery(other.id, false);
    expect(
      first.usePromptStashStore
        .getState()
        .reserveSendRecovery({ ...entry, prompt: "Duplicate identity" }).written,
    ).toBe(false);
    for (let index = 0; index < 18; index += 1) {
      first.usePromptStashStore.getState().stashEntry(makeEntry({ id: `manual-${index}` }));
    }
    expect(
      first.usePromptStashStore.getState().reserveSendRecovery({ ...entry, id: "full" }),
    ).toEqual({ written: false, durable: false });
    // Manual stashing must not evict an in-flight or failed recovery.
    first.usePromptStashStore.getState().stashEntry(makeEntry({ id: "manual-overflow" }));
    expect(first.usePromptStashStore.getState().entries).toContainEqual(entry);
    expect(first.usePromptStashStore.getState().takeEntry(entry.id).entry).toBeNull();
    first.usePromptStashStore.getState().settleSendRecovery("missing-id", true);
    expect(first.usePromptStashStore.getState().entries).toContainEqual(entry);
    vi.resetModules();
    const reloaded = await import("./promptStashStore");
    expect(reloaded.usePromptStashStore.getState().entries).toContainEqual(entry);
    rejectWrites = true;
    expect(reloaded.usePromptStashStore.getState().settleSendRecovery(entry.id, true).durable).toBe(
      false,
    );
    expect(reloaded.usePromptStashStore.getState().entries).toContainEqual(entry);
    rejectWrites = false;
    reloaded.usePromptStashStore.getState().settleSendRecovery(entry.id, true);
    expect(reloaded.usePromptStashStore.getState().entries).toHaveLength(19);
    expect(reloaded.usePromptStashStore.getState().entries).toContainEqual(other);
    expect(JSON.parse(storage.getItem(PROMPT_STASH_STORAGE_KEY)!).state.entries).toHaveLength(19);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});
