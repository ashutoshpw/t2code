import type { ComposerContextDraft } from "@t2code/contracts";
import { collectComposerContextReferences } from "@t2code/shared/composerContextReferences";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { Checkbox } from "../ui/checkbox";

export function ComposerSpaceContextOptions({
  target,
  context,
  prompt,
  disabled,
}: {
  target: ComposerThreadTarget;
  context: ComposerContextDraft | undefined;
  prompt: string;
  disabled: boolean;
}) {
  const references = new Set(
    collectComposerContextReferences(prompt).map((item) => item.contextId),
  );
  const selectors =
    context?.selectors.filter(
      (selector) =>
        references.has(selector.contextId) &&
        context.selectors.filter((item) => item.contextId === selector.contextId).length === 1 &&
        !context.records.some((item) => item.contextId === selector.contextId),
    ) ?? [];
  if (!selectors.length) return null;
  return (
    <fieldset disabled={disabled} className="mb-3 flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-xs text-secondary-label">
        Spaces context · captured when sent
      </legend>
      {selectors.map((selector) => (
        <label key={selector.contextId} className="flex min-w-0 items-center gap-2 text-xs">
          <Checkbox
            checked={selector.includeChildPages}
            disabled={disabled}
            onCheckedChange={(checked) =>
              useComposerDraftStore
                .getState()
                .setSpaceContextIncludeChildPages(target, selector, checked)
            }
          />
          <span className="min-w-0 truncate">
            Include child pages: {selector.label || selector.kind}
          </span>
        </label>
      ))}
      <p className="text-xs text-secondary-label">
        Large selections are shortened to fit capture limits.
      </p>
    </fieldset>
  );
}
