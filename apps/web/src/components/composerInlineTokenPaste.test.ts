import { threadChipCopyTarget } from "@t2code/client-runtime/thread-reference";
import {
  type ComposerContextClipboardFragment,
  ComposerContextId,
  EnvironmentId,
  type SpaceContextSelector,
  ThreadId,
} from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t2code/shared/composerContextClipboard";
import { threadContextRecord } from "@t2code/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { importPastedComposerText, readPastedComposerContext } from "./composerInlineTokenPaste";

const thread = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const clipboard = (data: Record<string, string>) => ({
  getData: (type: string) => data[type] ?? "",
});
const chip = (title: string) =>
  `[${title}](t2-context://v1/thread/${threadContextRecord(thread, title).contextId})`;

/** Imports every record it is offered, as the composer does for a thread its agent can read. */
const importAll =
  (imported: Array<ComposerContextClipboardFragment>) =>
  (fragment: ComposerContextClipboardFragment) => {
    imported.push(fragment);
    return new Map(fragment.records.map((record) => [record.contextId, record.contextId]));
  };

describe("importPastedComposerText", () => {
  it("pastes a copied thread link back as the chip it was copied from", () => {
    const target = threadChipCopyTarget(thread, "Fix the login flow");
    const imported: Array<ComposerContextClipboardFragment> = [];
    const text = importPastedComposerText(
      clipboard({
        "text/plain": `See ${target.value}`,
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: encodeComposerContextFragment(target.fragment!)!,
      }),
      importAll(imported),
    );
    expect(text).toBe(`See ${chip("Fix the login flow")}`);
    expect(imported.map((fragment) => fragment.records)).toEqual([target.fragment!.records]);
  });

  it("makes a chip of a v2 link pasted without T2's clipboard format", () => {
    const text = importPastedComposerText(
      clipboard({ "text/plain": "[Login](t2-thread://v2/env-1/thread-1)" }),
      importAll([]),
    );
    expect(text).toBe(chip("Login"));
  });

  it("keeps the link when the composer cannot take the thread", () => {
    const pasted = "https://app.t2.codes/threads/env-1/thread-1";
    expect(importPastedComposerText(clipboard({ "text/plain": pasted }), () => new Map())).toBe(
      pasted,
    );
  });

  it("imports CRLF and CR clipboard text with LF line breaks", () => {
    expect(
      importPastedComposerText(clipboard({ "text/plain": "x\r\n\r\ny\rz" }), () => new Map()),
    ).toBe("x\n\ny\nz");
  });
});

it("imports selector-only clipboard context and rewrites collisions without importing removed references", () => {
  const environmentId = EnvironmentId.make("env");
  const selector = (id: string): SpaceContextSelector => ({
    version: 1,
    selection: "current",
    kind: "page",
    environmentId,
    contextId: ComposerContextId.make(id),
    pageId: SpacePageId.make("page"),
    label: "Page",
    includeChildPages: false,
  });
  const fragment = encodeComposerContextFragment({
    version: 1,
    source: { environmentId },
    records: [],
    selectors: [selector("p"), selector("removed")],
  })!;
  const data = {
    getData: (type: string) =>
      type === "text/plain"
        ? "[Page](t2-context://v1/page/p)"
        : type === COMPOSER_CONTEXT_CLIPBOARD_MIME
          ? fragment
          : "",
  };
  expect(readPastedComposerContext(data)?.selectors?.map((record) => record.contextId)).toEqual([
    "p",
  ]);
  const pasted = importPastedComposerText(
    data,
    (parsed) => new Map((parsed.selectors ?? []).map((record) => [record.contextId, "new-p"])),
  );
  expect(pasted).toBe("[Page](t2-context://v1/page/new-p)");
});
