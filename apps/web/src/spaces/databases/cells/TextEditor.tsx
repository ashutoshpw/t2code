import type { KeyboardEvent } from "react";
import { useState } from "react";
import {
  SpaceRichText,
  type SpaceCellValue,
  type SpaceKnownDatabaseProperty,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

import { cn } from "~/lib/utils";
import type { CellEditorProps } from "./CellEditor";
import { localeDecimal, numberToText, parseCell, retainMarks } from "@t2code/client-runtime/spaces";
import { useSettleOnce } from "./settle";

const textOf = (value: SpaceCellValue | undefined, known: SpaceKnownDatabaseProperty): string => {
  if (value === undefined || value === null) return "";
  if (known.type === "number")
    return typeof value === "number"
      ? numberToText(value, known.config.format, localeDecimal(navigator.language))
      : "";
  if (known.type === "text")
    return Array.isArray(value)
      ? value
          .map((run) =>
            typeof run === "object" && run !== null && "text" in run ? String(run.text) : "",
          )
          .join("")
      : "";
  return typeof value === "string" ? value : "";
};

const isRichText = Schema.is(SpaceRichText);
/** The runs of a text cell when any of them carries a mark. */
function markedRuns(value: SpaceCellValue | undefined) {
  return isRichText(value) && value.some((run) => run.marks.length > 0) ? value : null;
}

/** Single-line editor of title, text, number, url, email and phone cells. */
export function TextEditor(props: CellEditorProps) {
  const { known, value, seed, variant } = props;
  const original = textOf(value, known);
  const [draft, setDraft] = useState(seed ?? original);
  const { commit, cancel } = useSettleOnce(props);

  const finish = (move?: "right" | "left", reason?: "blur") => {
    const parsed = parseCell(draft, known, { decimal: localeDecimal(navigator.language) });
    // An unparsable number or unchanged text keeps the stored value, marks included.
    if (!parsed.ok || draft === original) return commit(value ?? null, move, reason);
    // Text with marks or links keeps them where the text around the edit did not change.
    const marked = known.type === "text" ? markedRuns(value) : null;
    if (marked !== null) {
      const text = draft.trim();
      return commit(text === "" ? null : retainMarks(marked, text), move, reason);
    }
    commit(parsed.value, move, reason);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish();
    } else if (event.key === "Tab") {
      event.preventDefault();
      finish(event.shiftKey ? "left" : "right");
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <input
      autoFocus
      aria-label={known.name}
      inputMode={known.type === "number" ? "decimal" : undefined}
      value={draft}
      className={cn(
        "min-w-0 bg-background px-2 text-sm outline-none",
        variant === "cell"
          ? "absolute inset-0 w-full ring-2 ring-inset ring-ring"
          : "h-8 w-full rounded-md border border-ring",
      )}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        const end = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(end, end);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => finish(undefined, "blur")}
    />
  );
}
