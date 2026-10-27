import { expect, it } from "vite-plus/test";
import { ComposerContextId, EnvironmentId, type SpaceContextSelector } from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t2code/shared/composerContextClipboard";
import { importPastedComposerText, readPastedComposerContext } from "./composerInlineTokenPaste";

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
