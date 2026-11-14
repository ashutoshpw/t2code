import type { SpaceDatabase } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";

/** The database's icon glyph: a button that opens the icon picker for writers, plain text otherwise. */
export function DatabaseIconButton({
  icon,
  large,
  onClick,
}: {
  readonly icon: NonNullable<SpaceDatabase["icon"]>;
  readonly large: boolean;
  /** Absent for a read-only viewer. */
  readonly onClick?: () => void;
}) {
  const size = large ? "size-16 text-5xl" : "size-8 text-xl";
  if (onClick === undefined)
    return (
      <span
        aria-hidden
        className={cn("inline-flex items-center justify-center leading-none", size)}
      >
        {icon}
      </span>
    );
  return (
    <button
      type="button"
      aria-label="Change database icon"
      className={cn(
        "inline-flex items-center justify-center rounded-md leading-none outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        size,
      )}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
