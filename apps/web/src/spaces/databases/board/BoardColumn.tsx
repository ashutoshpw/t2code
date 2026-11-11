import { useDraggable, useDroppable } from "@dnd-kit/core";
import { EyeOffIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { memo } from "react";
import type { SpaceGroupBucket, SpaceGroupKey, SpacePageId } from "@t2code/contracts/spaces";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { OPTION_COLOR_CLASS, isDatabaseColor } from "../primitives/colors";
import { OptionChip } from "../primitives/OptionChip";
import { BoardCard, sameLines, type CardLine } from "./BoardCard";
import type { CellTextContext } from "../primitives/format";
import type { SpaceRelatedPage } from "@t2code/contracts/spaces";

export interface BoardHandlers {
  open(pageId: SpacePageId): void;
  addCard(key: SpaceGroupKey): void;
  loadBucket(key: SpaceGroupKey): void;
  setHidden(key: SpaceGroupKey, hidden: boolean): void;
}

export interface BoardColumnProps {
  readonly id: string;
  readonly bucket: SpaceGroupBucket;
  readonly labelText: string;
  readonly labelColor: string | undefined;
  readonly lines: ReadonlyArray<CardLine>;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: CellTextContext["optionHint"];
  readonly timeZone: string;
  readonly canAdd: boolean;
  readonly adding: boolean;
  readonly canDragCards: boolean;
  readonly canMove: boolean;
  readonly canHide: boolean;
  readonly tint: boolean;
  readonly loadingMore: boolean;
  readonly page: boolean;
  readonly handlers: BoardHandlers;
}

const BUTTON =
  "inline-flex items-center justify-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50";

function ColumnLabel({
  text,
  color,
}: {
  readonly text: string;
  readonly color: string | undefined;
}) {
  return color === undefined ? (
    <span className="truncate text-sm font-medium">{text}</span>
  ) : (
    <OptionChip name={text} color={color} />
  );
}

/** The drag overlay of a column being reordered. */
export function ColumnGhost({
  text,
  color,
}: {
  readonly text: string;
  readonly color: string | undefined;
}) {
  return (
    <div className="rounded-md border bg-background px-3 py-2 shadow-md">
      <ColumnLabel text={text} color={color} />
    </div>
  );
}

const same = (a: BoardColumnProps, b: BoardColumnProps) =>
  (Object.keys(a) as Array<keyof BoardColumnProps>).every((key) =>
    key === "lines" ? sameLines(a.lines, b.lines) : Object.is(a[key], b[key]),
  );

export const BoardColumn = memo(function BoardColumn(props: BoardColumnProps) {
  const { id, bucket, labelText, labelColor, handlers } = props;
  const { setNodeRef, isOver } = useDroppable({
    id: `drop:${id}`,
    data: { type: "column", key: bucket.key },
  });
  const {
    setNodeRef: setHandleRef,
    attributes,
    listeners,
  } = useDraggable({
    id: `column:${id}`,
    data: { type: "column", key: bucket.key, labelText, labelColor },
    disabled: !props.canMove,
  });
  const tinted =
    props.tint && labelColor !== undefined && isDatabaseColor(labelColor)
      ? OPTION_COLOR_CLASS[labelColor]
      : "bg-muted/40";
  return (
    <section
      ref={setNodeRef}
      data-column-id={id}
      aria-label={labelText}
      className={cn(
        "flex w-68 shrink-0 flex-col rounded-lg",
        tinted,
        props.page ? "h-[calc(100dvh-15rem)] min-h-80" : "max-h-[min(36rem,70vh)]",
        isOver && "ring-2 ring-inset ring-ring/60",
      )}
    >
      <header className="flex items-center gap-1 px-2 pt-2 pb-1.5">
        <div
          ref={setHandleRef}
          {...(props.canMove ? attributes : {})}
          {...(props.canMove ? listeners : {})}
          {...(props.canMove ? { "aria-label": `Move ${labelText} column` } : {})}
          className={cn(
            "flex min-w-0 items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            props.canMove && "cursor-grab",
          )}
        >
          <ColumnLabel text={labelText} color={labelColor} />
        </div>
        <span className="text-xs text-muted-foreground">{bucket.count}</span>
        <span className="ms-auto flex items-center gap-0.5">
          {props.canAdd ? (
            <button
              type="button"
              aria-label={`Add a card to ${labelText}`}
              disabled={props.adding}
              className={cn(BUTTON, "size-6")}
              onClick={() => handlers.addCard(bucket.key)}
            >
              <PlusIcon className="size-3.5" />
            </button>
          ) : null}
          {props.canHide ? (
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`${labelText} options`}
                    className={cn(BUTTON, "size-6")}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => handlers.setHidden(bucket.key, true)}>
                  <EyeOffIcon />
                  Hide group
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </span>
      </header>
      <div
        role="list"
        aria-label={`${labelText} cards`}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain px-2 pb-2"
      >
        {bucket.rows.map((row) => (
          <BoardCard
            key={row.page.id}
            row={row}
            group={bucket.key}
            lines={props.lines}
            relatedPages={props.relatedPages}
            optionHint={props.optionHint}
            timeZone={props.timeZone}
            draggable={props.canDragCards}
            onOpen={handlers.open}
          />
        ))}
        {bucket.rows.length < bucket.count ? (
          <button
            type="button"
            disabled={props.loadingMore}
            className={cn(BUTTON, "h-7 w-full")}
            onClick={() => handlers.loadBucket(bucket.key)}
          >
            {props.loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
        {props.canAdd ? (
          <button
            type="button"
            disabled={props.adding}
            className={cn(BUTTON, "h-7 w-full justify-start px-1.5")}
            onClick={() => handlers.addCard(bucket.key)}
          >
            <PlusIcon className="size-3.5" />
            New
          </button>
        ) : null}
      </div>
    </section>
  );
}, same);
