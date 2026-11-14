import type {
  ComposerContextDraft,
  ComposerContextRecord,
  OrchestrationMessageContext,
  SpaceContextSelector,
} from "@t2code/contracts";
import { collectComposerContextReferences } from "@t2code/shared/composerContextReferences";
import { referencedComposerContext } from "./composerContext";

export function referencedComposerContextDraft(text: string, draft?: ComposerContextDraft) {
  if (!draft) return undefined;
  const ids = new Set(collectComposerContextReferences(text).map((ref) => ref.contextId));
  const selectors = draft.selectors.filter((entry) => ids.has(entry.contextId));
  const records =
    referencedComposerContext(text, { version: 1, records: draft.records })?.records ?? [];
  if (!selectors.length && !records.length) return undefined;
  if (selectors.length === draft.selectors.length && records.length === draft.records.length)
    return draft;
  return selectors.length || records.length ? { selectors, records } : undefined;
}

export function composerContextEntries(
  context?: OrchestrationMessageContext,
  draft?: ComposerContextDraft,
) {
  return [...(context?.records ?? []), ...(draft?.records ?? []), ...(draft?.selectors ?? [])];
}

export function composerContextEntry(
  kind: string,
  contextId: string,
  context?: OrchestrationMessageContext,
  draft?: ComposerContextDraft,
) {
  const matches = composerContextEntries(context, draft).filter(
    (entry) => entry.contextId === contextId,
  );
  return matches.length === 1 && matches[0]?.kind === kind ? matches[0] : undefined;
}

export function spaceContextEntry(entry?: ComposerContextRecord | SpaceContextSelector) {
  return entry && !("payload" in entry) && (entry.kind === "page" || entry.kind === "block")
    ? entry
    : undefined;
}
