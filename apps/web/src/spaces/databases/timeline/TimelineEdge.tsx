import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

/** A static marker at the edge of a row whose bar is outside the scrolled view. */
export function TimelineEdge({
  side,
  title,
  stickyLeft,
  onActivate,
}: {
  readonly side: "left" | "right";
  readonly title: string;
  readonly stickyLeft: number;
  readonly onActivate: () => void;
}) {
  const Icon = side === "left" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      data-offscreen={side}
      aria-label={`Scroll to ${title || "Untitled"}`}
      className="sticky z-[2] mt-1 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring max-sm:size-6 data-[offscreen=right]:ms-auto"
      style={side === "left" ? { left: stickyLeft } : { right: 0 }}
      onClick={onActivate}
    >
      <Icon className="size-3" />
    </button>
  );
}
