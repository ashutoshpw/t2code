import { SpaceId, SpacePageId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "@effect/vitest";
import {
  ComposerContextId,
  EnvironmentId,
  type PageContextRecord,
  type SpaceContextSelector,
} from "@t2code/contracts";
import { prepareSpaceContextSend } from "./sendContext.ts";

const environmentId = EnvironmentId.make("env");
const selector = (id = "p"): SpaceContextSelector => ({
  version: 1,
  selection: "current",
  kind: "page",
  contextId: ComposerContextId.make(id),
  label: id,
  environmentId,
  pageId: SpacePageId.make(id),
  includeChildPages: false,
});
const record = (id = "p", text = "current"): PageContextRecord => ({
  version: 1,
  kind: "page",
  contextId: ComposerContextId.make(id),
  label: id,
  environmentId,
  spaceId: SpaceId.make("s"),
  pageId: SpacePageId.make(id),
  title: id,
  snapshot: {
    version: 1,
    includeChildPages: false,
    truncated: false,
    text,
    contentHash: `sha256:${"a".repeat(64)}`,
    sources: [
      {
        environmentId,
        spaceId: SpaceId.make("s"),
        pageId: SpacePageId.make(id),
        revision: 2,
        blockIds: [],
      },
    ],
  },
});
const ref = (id = "p") => `[Page](t2-context://v1/terminal/${id})`;
function setup() {
  let session: object | null = {};
  let current = true;
  let enabled = true;
  let canRead = true;
  const requests: string[] = [];
  const access = () => ({ session, canRead, supportsCapture: enabled });
  return {
    requests,
    access,
    isCurrentDraft: () => current,
    changeDraft: () => {
      current = false;
    },
    replaceSession: () => {
      session = {};
    },
    disable: () => {
      enabled = false;
    },
    revokeRead: () => {
      canRead = false;
    },
    disconnect: () => {
      session = null;
    },
    capture: async (input: { contextId: string }) => {
      requests.push(input.contextId);
      return { status: "captured" as const, record: record(input.contextId) };
    },
  };
}

describe("send-time Spaces preparation", () => {
  it("selects by ID regardless of href kind, prunes unused selectors and recaptures copied snapshots", async () => {
    const state = setup();
    const copied = record("p", "old snapshot");
    const context = await prepareSpaceContextSend({
      environmentId,
      text: ref(),
      context: { version: 1, records: [copied] },
      selectors: [selector("unused")],
      ...state,
    });
    expect(state.requests).toEqual(["p"]);
    expect(context?.records).toEqual([record()]);
    expect(copied.snapshot.text).toBe("old snapshot");
  });
  it("rejects nine, foreign, missing and ambiguous references before any request", async () => {
    for (const selectors of [
      Array.from({ length: 9 }, (_, i) => selector(`p${i}`)),
      [{ ...selector(), environmentId: EnvironmentId.make("foreign") }],
      [selector(), selector()],
      [],
    ]) {
      const state = setup();
      const text =
        selectors.length === 9
          ? selectors.map((s) => ref(s.contextId)).join(" ")
          : `[Page](t2-context://v1/page/p)`;
      await expect(
        prepareSpaceContextSend({ environmentId, text, selectors, ...state }),
      ).rejects.toThrow();
      expect(state.requests).toEqual([]);
    }
  });
  it("requires a live readable capture capability before requests", async () => {
    for (const access of [
      () => ({ session: null, canRead: true, supportsCapture: true }),
      () => ({ session: {}, canRead: false, supportsCapture: true }),
      () => ({ session: {}, canRead: true, supportsCapture: false }),
    ]) {
      const state = setup();
      await expect(
        prepareSpaceContextSend({
          environmentId,
          text: ref(),
          selectors: [selector()],
          ...state,
          access,
        }),
      ).rejects.toThrow();
      expect(state.requests).toEqual([]);
    }
  });
  it("bounds the aggregate serialized envelope before publishing any snapshots", async () => {
    const state = setup();
    const selectors = Array.from({ length: 8 }, (_, i) => selector(`p${i}`));
    await expect(
      prepareSpaceContextSend({
        environmentId,
        text: selectors.map((s) => ref(s.contextId)).join(" "),
        selectors,
        ...state,
        capture: async (input) => {
          const value = { ...record(input.contextId), future: "" };
          value.future = "x".repeat(65535 - new TextEncoder().encode(JSON.stringify(value)).length);
          return { status: "captured", record: value };
        },
      }),
    ).rejects.toThrow();
  });
  it("fails atomically on a deleted capture and preserves unrelated records", async () => {
    const state = setup();
    const unknown = {
      version: 1 as const,
      kind: "future",
      contextId: ComposerContextId.make("u"),
      label: "future",
      payload: { keep: true },
    };
    const context = await prepareSpaceContextSend({
      environmentId,
      text: ref(),
      selectors: [selector()],
      context: { version: 1, records: [unknown] },
      ...state,
    });
    expect(context?.records[0]).toEqual(unknown);
    await expect(
      prepareSpaceContextSend({
        environmentId,
        text: ref(),
        selectors: [selector()],
        ...state,
        capture: async () => ({ status: "deleted" }),
      }),
    ).rejects.toThrow();
  });
  it("rejects a deferred reply after disconnect or newer draft typing", async () => {
    for (const invalidate of [
      "disconnect",
      "changeDraft",
      "replaceSession",
      "disable",
      "revokeRead",
    ] as const) {
      const state = setup();
      let complete!: (value: { status: "captured"; record: PageContextRecord }) => void;
      const pending = prepareSpaceContextSend({
        environmentId,
        text: ref(),
        selectors: [selector()],
        ...state,
        capture: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      });
      state[invalidate]();
      complete({ status: "captured", record: record() });
      await expect(pending).rejects.toThrow();
    }
  });
  it("rejects invalid capture correspondence and oversized UTF-8 text", async () => {
    const state = setup();
    await expect(
      prepareSpaceContextSend({
        environmentId,
        text: ref(),
        selectors: [selector()],
        ...state,
        capture: async () => ({ status: "captured", record: record("other") }),
      }),
    ).rejects.toThrow();
    const selectors = Array.from({ length: 8 }, (_, i) => selector(`p${i}`));
    await expect(
      prepareSpaceContextSend({
        environmentId,
        text: selectors.map((s) => ref(s.contextId)).join(" "),
        selectors,
        ...state,
        capture: async (input) => ({
          status: "captured",
          record: record(input.contextId, "😀".repeat(8193)),
        }),
      }),
    ).rejects.toThrow();
  });
});

it("captures the requested block identity and accepts the service's moved and merged location", async () => {
  const state = setup();
  const blockId = "requested" as never;
  const survivor = "survivor" as never;
  const page = record("b");
  const captured = {
    ...page,
    kind: "block" as const,
    blockId,
    resolvedBlockId: survivor,
    snapshot: {
      ...page.snapshot,
      sources: [{ ...page.snapshot.sources[0]!, blockIds: [survivor] }],
    },
  };
  const requests: unknown[] = [];
  const result = await prepareSpaceContextSend({
    environmentId,
    text: ref("b"),
    selectors: [
      {
        version: 1,
        selection: "current",
        kind: "block",
        contextId: page.contextId,
        label: "Block",
        environmentId,
        blockId,
        includeChildPages: false,
      },
    ],
    ...state,
    capture: async (input) => {
      requests.push(input);
      return { status: "captured", record: captured };
    },
  });
  expect(requests).toEqual([
    {
      environmentId,
      contextId: page.contextId,
      target: { kind: "block", blockId },
      includeChildPages: false,
    },
  ]);
  expect(result?.records).toEqual([captured]);
});
