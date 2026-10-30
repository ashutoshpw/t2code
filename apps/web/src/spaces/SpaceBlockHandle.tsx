import { GripVerticalIcon, PlusIcon } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export const SPACE_BLOCK_HANDLE_WIDTH = 44;

export function SpaceBlockHandle({
  top,
  left,
  menuOpen,
  onMenuOpenChange,
  onAdd,
  onDragStart,
  onDragEnd,
  children,
}: {
  top: number;
  left: number;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onAdd: (() => void) | null;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  children: ReactNode;
}) {
  const [grip, setGrip] = useState<HTMLElement | null>(null);
  return (
    <div
      className="absolute z-10 flex items-center"
      style={{ top, left, width: SPACE_BLOCK_HANDLE_WIDTH }}
      data-space-block-handle=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-micro"
              aria-label="Add block below"
              disabled={!onAdd}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onAdd?.()}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Add block below</TooltipPopup>
      </Tooltip>
      <Button
        ref={setGrip}
        variant="ghost"
        size="icon-micro"
        aria-label="Block menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        draggable
        onClick={() => onMenuOpenChange(!menuOpen)}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <GripVerticalIcon />
      </Button>
      <Menu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <MenuPopup align="start" anchor={grip}>
          {children}
        </MenuPopup>
      </Menu>
    </div>
  );
}
