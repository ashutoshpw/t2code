import {
  BlockContextRecord,
  OrchestrationMessageContext,
  PageContextRecord,
  SpaceContextSelector,
  SPACE_CONTEXT_LIMITS,
  type EnvironmentId,
  type SpaceContextCaptureInput,
  type SpaceContextCaptureResult,
} from "@t2code/contracts";
import { collectComposerContextReferences } from "@t2code/shared/composerContextReferences";
import * as Schema from "effect/Schema";

const validateContext = Schema.decodeSync(OrchestrationMessageContext);
const isPage = Schema.is(PageContextRecord);
const isBlock = Schema.is(BlockContextRecord);
const isSelector = Schema.is(SpaceContextSelector);

export async function prepareSpaceContextSend(input: {
  environmentId: EnvironmentId;
  text: string;
  context?: OrchestrationMessageContext | undefined;
  selectors?: readonly SpaceContextSelector[] | undefined;
  access: () => { session: object | null; canRead: boolean; supportsCapture: boolean };
  isCurrentDraft: () => boolean;
  capture?: ((input: SpaceContextCaptureInput) => Promise<SpaceContextCaptureResult>) | undefined;
}): Promise<OrchestrationMessageContext | undefined> {
  const records = input.context?.records ?? [];
  const candidates = [...records, ...(input.selectors ?? [])];
  const byId = new Map(candidates.map((record) => [record.contextId, record]));
  const ambiguous = new Set<string>();
  const seen = new Set<string>();
  for (const record of candidates) {
    if (seen.has(record.contextId)) ambiguous.add(record.contextId);
    seen.add(record.contextId);
  }
  const selected = new Map<string, SpaceContextSelector>();
  for (const reference of collectComposerContextReferences(input.text)) {
    const candidate = byId.get(reference.contextId);
    const isSpace = candidate?.kind === "page" || candidate?.kind === "block";
    if (ambiguous.has(reference.contextId)) {
      if (
        isSpace ||
        candidates.some(
          (record) =>
            record.contextId === reference.contextId &&
            (record.kind === "page" || record.kind === "block"),
        )
      )
        throw new Error("Ambiguous Spaces context. Remove and select it again.");
      continue;
    }
    if (!isSpace) {
      if (candidate === undefined && (reference.kind === "page" || reference.kind === "block"))
        throw new Error("Spaces context is unavailable. Remove and select it again.");
      continue;
    }
    if (isSelector(candidate)) selected.set(candidate.contextId, candidate);
    else if (isPage(candidate) || isBlock(candidate)) {
      selected.set(candidate.contextId, {
        version: 1,
        selection: "current",
        contextId: candidate.contextId,
        label: candidate.label,
        environmentId: candidate.environmentId,
        includeChildPages: candidate.snapshot.includeChildPages,
        ...(candidate.kind === "page"
          ? { kind: "page", pageId: candidate.pageId }
          : { kind: "block", blockId: candidate.blockId }),
      });
    } else throw new Error("Invalid Spaces context. Remove and select it again.");
  }
  if (selected.size > SPACE_CONTEXT_LIMITS.maxRecords)
    throw new Error("A message can reference at most 8 Spaces contexts.");
  for (const selector of selected.values()) {
    if (selector.environmentId !== input.environmentId)
      throw new Error("Spaces context belongs to another environment.");
  }
  if (selected.size === 0) {
    if (!records.some((record) => record.kind === "page" || record.kind === "block"))
      return input.context;
    return {
      ...input.context,
      version: 1,
      records: records.filter((record) => record.kind !== "page" && record.kind !== "block"),
    };
  }
  const initial = input.access();
  const assertCurrent = () => {
    const access = input.access();
    if (
      initial.session === null ||
      access.session !== initial.session ||
      !access.canRead ||
      !access.supportsCapture
    )
      throw new Error(
        "Spaces capture is unavailable or the connection changed. Retry when connected with read access.",
      );
    if (!input.isCurrentDraft())
      throw new Error(
        "The draft changed while capturing Spaces context. Send again to include your latest draft.",
      );
  };
  assertCurrent();
  const capture = input.capture;
  if (!capture) throw new Error("Spaces capture is unavailable.");
  const captures: (PageContextRecord | BlockContextRecord)[] = [];
  for (const selector of selected.values()) {
    assertCurrent();
    const result = await capture({
      environmentId: input.environmentId,
      contextId: selector.contextId,
      target:
        selector.kind === "page"
          ? { kind: "page", pageId: selector.pageId }
          : { kind: "block", blockId: selector.blockId },
      includeChildPages: selector.includeChildPages,
    });
    assertCurrent();
    if (result.status !== "captured")
      throw new Error("Spaces source is unavailable or deleted. Retry or remove its context.");
    const record = result.record;
    if (
      !(isPage(record) || isBlock(record)) ||
      record.contextId !== selector.contextId ||
      record.kind !== selector.kind ||
      record.environmentId !== input.environmentId ||
      record.snapshot.includeChildPages !== selector.includeChildPages ||
      (selector.kind === "page"
        ? record.pageId !== selector.pageId
        : !isBlock(record) || record.blockId !== selector.blockId)
    )
      throw new Error("Spaces capture returned an invalid snapshot.");
    captures.push(record);
  }
  const context = {
    ...input.context,
    version: 1 as const,
    records: [
      ...records.filter((record) => record.kind !== "page" && record.kind !== "block"),
      ...captures,
    ],
  };
  validateContext(context);
  assertCurrent();
  return context;
}
