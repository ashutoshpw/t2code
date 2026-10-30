import { GripVerticalIcon, PlusIcon } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

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
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  children: ReactNode;
}) {
  const [grip, setGrip] = useState<HTMLElement | null>(null);
  const openedOnPress = useRef(false);
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
      <div draggable onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <Button
          ref={setGrip}
          variant="ghost"
          size="icon-micro"
          aria-label="Block menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onPointerDown={() => {
            openedOnPress.current = menuOpen;
          }}
          onClick={() => {
            if (!openedOnPress.current) onMenuOpenChange(true);
            openedOnPress.current = false;
          }}
        >
          <GripVerticalIcon />
        </Button>
      </div>
      <Menu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <MenuPopup align="start" anchor={grip}>
          {children}
        </MenuPopup>
      </Menu>
    </div>
  );
}
