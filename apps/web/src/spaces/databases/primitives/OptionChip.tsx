import { XIcon } from "lucide-react";
import type { SpaceDatabaseColor } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { OPTION_COLOR_CLASS, isDatabaseColor } from "./colors";

/** A feature-owned chip, not a restyled Badge: the grid and the cards need one dense look. */
export function OptionChip({
  name,
  color,
  onRemove,
}: {
  readonly name: string;
  readonly color: SpaceDatabaseColor | string;
  readonly onRemove?: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-sm px-1.5 py-px text-xs/5",
        OPTION_COLOR_CLASS[isDatabaseColor(color) ? color : "default"],
      )}
    >
      <span className="truncate">{name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          className="-me-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm hover:bg-foreground/10"
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </span>
  );
}
