import { useState, type ReactNode } from "react";

import { Popover, PopoverPopup } from "~/components/ui/popover";

/**
 * A popover anchored to the whole cell. The editor owns its content and keys; Escape and a press
 * outside report through `onClose`, and focus goes back to the cell that opened it.
 */
export function EditorPopover({
  onClose,
  width = "sm",
  label,
  children,
}: {
  readonly onClose: () => void;
  readonly width?: "auto" | "sm" | "md";
  readonly label: string;
  readonly children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <span ref={setAnchor} aria-hidden className="pointer-events-none absolute inset-0" />
      {anchor === null ? null : (
        <Popover
          open
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <PopoverPopup
            anchor={anchor}
            align="start"
            padding="none"
            width={width}
            aria-label={label}
          >
            {children}
          </PopoverPopup>
        </Popover>
      )}
    </>
  );
}
