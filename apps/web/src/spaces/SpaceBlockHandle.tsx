import { GripVerticalIcon, MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuPopup } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export const SPACE_BLOCK_HANDLE_WIDTH = 44;
export const SPACE_BLOCK_HANDLE_COMMENT_WIDTH = 64;

export function SpaceBlockHandle({
  top,
  left,
  menuOpen,
  onMenuOpenChange,
  onMenuClosed,
  onAdd,
  onComment,
  structure,
  onDragStart,
  onDragEnd,
  children,
}: {
  top: number;
  left: number;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** After the close animation: the popup content is unmounted by then. */
  onMenuClosed?: () => void;
  onAdd: (() => void) | null;
  /** Set where the viewer may comment; the handle is then wider by one button. */
  onComment: (() => void) | null;
  /** Without structure rights the handle is only the comment button. */
  structure: boolean;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  children: ReactNode;
}) {
  const [grip, setGrip] = useState<HTMLElement | null>(null);
  const openedOnPress = useRef(false);
  return (
    <div
      className="absolute z-10 flex items-center"
      style={{
        top,
        left,
        width: onComment ? SPACE_BLOCK_HANDLE_COMMENT_WIDTH : SPACE_BLOCK_HANDLE_WIDTH,
      }}
      data-space-block-handle=""
    >
      {onComment ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-micro"
                aria-label="Comment"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onComment}
              />
            }
          >
            <MessageSquarePlusIcon />
          </TooltipTrigger>
          <TooltipPopup side="top">Comment</TooltipPopup>
        </Tooltip>
      ) : null}
      {structure ? (
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
      ) : null}
      {structure ? (
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
      ) : null}
      {structure ? (
        <Menu
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          onOpenChangeComplete={(open) => {
            if (!open) onMenuClosed?.();
          }}
        >
          <MenuPopup align="start" anchor={grip}>
            {children}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
