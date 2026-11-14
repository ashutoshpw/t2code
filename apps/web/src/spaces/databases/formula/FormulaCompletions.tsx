import type { FormulaCompletion } from "@t2code/shared/formula";

import { cn } from "~/lib/utils";

/** The suggestion list under the input; the input keeps focus, so options are mouse-only targets. */
export function FormulaCompletions({
  id,
  items,
  active,
  onPick,
}: {
  readonly id: string;
  readonly items: ReadonlyArray<FormulaCompletion>;
  readonly active: number;
  readonly onPick: (item: FormulaCompletion) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Suggestions"
      className="max-h-48 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
    >
      {items.map((item, index) => (
        <li
          key={`${item.kind}:${item.label}`}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === active}
          ref={(element) => {
            if (index === active) element?.scrollIntoView?.({ block: "nearest" });
          }}
          className={cn(
            "flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1",
            index === active && "bg-accent text-accent-foreground",
          )}
          // The textarea keeps focus: a blur would close the list before the click lands.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item)}
        >
          <span className="truncate font-mono text-xs">{item.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{item.detail ?? item.kind}</span>
        </li>
      ))}
    </ul>
  );
}
