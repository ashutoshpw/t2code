import type { Ref } from "react";

import { cn } from "~/lib/utils";
import type { Segment } from "./formulaText";

const TEXT =
  "col-start-1 row-start-1 min-h-24 whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-sm leading-5";

/** Each segment keyed by where it starts in the text. */
function keyedSegments(segments: ReadonlyArray<Segment>) {
  let offset = 0;
  return segments.map((segment) => {
    const key = offset;
    offset += segment.text.length;
    return { key, segment };
  });
}

/**
 * A textarea over a mirrored backdrop that draws the error underlines. Both share one grid cell
 * and one font, so the backdrop text lines up with what is typed. The wrapper scrolls, not the
 * textarea, so the two never drift apart.
 */
export function FormulaInput({
  value,
  segments,
  textareaRef,
  disabled,
  invalid,
  describedBy,
  listboxId,
  activeId,
  onChange,
  onCaret,
  onKeyDown,
  onCompositionEnd,
}: {
  readonly value: string;
  readonly segments: ReadonlyArray<Segment>;
  readonly textareaRef: Ref<HTMLTextAreaElement>;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly describedBy: string;
  readonly listboxId: string | undefined;
  readonly activeId: string | undefined;
  readonly onChange: (value: string, caret: number) => void;
  readonly onCaret: (caret: number) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onCompositionEnd: () => void;
}) {
  return (
    <div
      className={cn(
        "relative grid max-h-64 overflow-auto rounded-lg border bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/24",
        invalid && "border-destructive/50",
      )}
    >
      <div aria-hidden className={cn(TEXT, "pointer-events-none text-transparent")}>
        {keyedSegments(segments).map(({ key, segment }) =>
          segment.message === undefined ? (
            <span key={key}>{segment.text}</span>
          ) : (
            <span
              key={key}
              className="underline decoration-destructive decoration-wavy underline-offset-4"
            >
              {segment.text}
            </span>
          ),
        )}
        {/* A trailing newline would collapse; this keeps the last line's height. */}
        {"\n"}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        aria-label="Formula"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        role="combobox"
        aria-expanded={listboxId !== undefined}
        className={cn(
          TEXT,
          "field-sizing-content w-full resize-none overflow-hidden bg-transparent outline-none caret-foreground disabled:opacity-64",
        )}
        onChange={(event) => onChange(event.target.value, event.target.selectionStart)}
        onSelect={(event) => onCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onCompositionEnd={onCompositionEnd}
      />
    </div>
  );
}
