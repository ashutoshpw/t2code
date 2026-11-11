import { SPACE_DATABASE_COLORS, type SpaceDatabaseColor } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { OPTION_DOT_CLASS } from "./colors";

export function ColorSwatches({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: SpaceDatabaseColor;
  readonly onChange: (color: SpaceDatabaseColor) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1.5 p-1">
      {SPACE_DATABASE_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={color === value}
          aria-label={color}
          disabled={disabled}
          className={cn(
            "size-5 rounded-full outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            OPTION_DOT_CLASS[color],
            color === value && "ring-2 ring-foreground/70 ring-offset-1",
          )}
          onClick={() => onChange(color)}
        />
      ))}
    </div>
  );
}
