import { useDraggable, useDroppable } from "@dnd-kit/core";
import { EyeOffIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { type CellTextContext, canonicalJson } from "@t2code/client-runtime/spaces";
import { memo } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceGroupBucket, SpaceGroupKey, SpacePageId } from "@t2code/contracts/spaces";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import {
  OPTION_COLUMN_CLASS,
  OPTION_COLUMN_TEXT_CLASS,
  isDatabaseColor,
} from "../primitives/colors";
import { OptionChip } from "../primitives/OptionChip";
import { BoardCard, sameLines, type CardLine } from "./BoardCard";
import type { SpaceRelatedPage } from "@t2code/contracts/spaces";

export interface BoardHandlers {
  open(pageId: SpacePageId): void;
  addCard(key: SpaceGroupKey, lane?: SpaceGroupKey): void;
  loadBucket(key: SpaceGroupKey, lane?: SpaceGroupKey): void;
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
  /** Pixels; follows the view's card size. */
  readonly width: number;
  /** Compact results of the view's column calculation for this column. */
  readonly headerAggregates: string;
  readonly wrap: boolean;
  readonly coverPropertyId: string | null;
  readonly coverContent: boolean;
  readonly coverHeight: number;
  readonly coverFit: boolean;
  readonly intrinsicHeight: number;
  readonly environmentId: EnvironmentId;
  /** A cell of a sub-group lane: no header of its own, drops and adds also set the lane. */
  readonly lane?: SpaceGroupKey | undefined;
}

const BUTTON =
  "inline-flex items-center justify-center gap-1 rounded-sm text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50";

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
    key === "lines"
      ? sameLines(a.lines, b.lines)
      : key === "lane"
        ? a.lane === b.lane ||
          (a.lane !== undefined &&
            b.lane !== undefined &&
            canonicalJson(a.lane) === canonicalJson(b.lane))
        : Object.is(a[key], b[key]),
  );

export const BoardColumn = memo(function BoardColumn(props: BoardColumnProps) {
  const { id, bucket, labelText, labelColor, handlers } = props;
  const { setNodeRef, isOver } = useDroppable({
    id: `drop:${id}`,
    data: { type: "column", key: bucket.key, lane: props.lane },
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
  const tintColor =
    props.tint && labelColor !== undefined && isDatabaseColor(labelColor) ? labelColor : undefined;
  const tinted = tintColor === undefined ? "bg-muted/40" : OPTION_COLUMN_CLASS[tintColor];
  const muted = cn(
    tintColor === undefined ? "text-muted-foreground" : OPTION_COLUMN_TEXT_CLASS[tintColor],
    tintColor === undefined ? "hover:bg-accent" : "hover:bg-foreground/5",
  );
  return (
    <section
      ref={setNodeRef}
      data-column-id={id}
      aria-label={labelText}
      style={{ width: props.width }}
      className={cn(
        "flex shrink-0 flex-col rounded-lg",
        tinted,
        props.lane !== undefined
          ? "max-h-96"
          : props.page
            ? "h-[calc(100dvh-15rem)] min-h-80"
            : "max-h-[min(36rem,70vh)]",
        isOver && "ring-2 ring-inset ring-ring/60",
      )}
    >
      {props.lane !== undefined ? null : (
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
          <span className={cn("text-xs", muted)}>{bucket.count}</span>
          {props.headerAggregates === "" ? null : (
            <span className={cn("truncate text-xs", muted)}>{props.headerAggregates}</span>
          )}
          <span className="ms-auto flex items-center gap-0.5">
            {props.canAdd ? (
              <button
                type="button"
                aria-label={`Add a card to ${labelText}`}
                disabled={props.adding}
                className={cn(BUTTON, muted, "size-6")}
                onClick={() => handlers.addCard(bucket.key, props.lane)}
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
                      className={cn(BUTTON, muted, "size-6")}
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
      )}
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
            lane={props.lane}
            wrap={props.wrap}
            coverPropertyId={props.coverPropertyId}
            coverContent={props.coverContent}
            coverHeight={props.coverHeight}
            coverFit={props.coverFit}
            intrinsicHeight={props.intrinsicHeight}
            environmentId={props.environmentId}
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
            className={cn(BUTTON, muted, "h-7 w-full")}
            onClick={() => handlers.loadBucket(bucket.key, props.lane)}
          >
            {props.loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
        {props.canAdd ? (
          <button
            type="button"
            disabled={props.adding}
            className={cn(BUTTON, muted, "h-7 w-full justify-start px-1.5")}
            onClick={() => handlers.addCard(bucket.key, props.lane)}
          >
            <PlusIcon className="size-3.5" />
            New page
          </button>
        ) : null}
      </div>
    </section>
  );
}, same);
