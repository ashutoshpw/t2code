import type { KeyboardEvent } from "react";
import { useState } from "react";
import type { SpaceCellValue, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import type { CellEditorProps } from "./CellEditor";
import { numberToText, parseCell } from "./parseCell";
import { useSettleOnce } from "./settle";

const textOf = (value: SpaceCellValue | undefined, known: SpaceKnownDatabaseProperty): string => {
  if (value === undefined || value === null) return "";
  if (known.type === "number")
    return typeof value === "number" ? numberToText(value, known.config.format) : "";
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

/** Single-line editor of title, text, number, url, email and phone cells. */
export function TextEditor(props: CellEditorProps) {
  const { known, value, seed, variant } = props;
  const original = textOf(value, known);
  const [draft, setDraft] = useState(seed ?? original);
  const { commit, cancel } = useSettleOnce(props);

  const finish = (move?: "right" | "left", reason?: "blur") => {
    const parsed = parseCell(draft, known);
    // An unparsable number or unchanged text keeps the stored value, marks included.
    commit(!parsed.ok || draft === original ? (value ?? null) : parsed.value, move, reason);
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
