import { useDraggable } from "@dnd-kit/core";
import { type CellTextContext, rowTitle } from "@t2code/client-runtime/spaces";
import { MoreHorizontalIcon } from "lucide-react";
import { lazy, memo, Suspense, type CSSProperties } from "react";
import type {
  SpaceCellValue,
  SpaceDatabaseRow,
  SpaceKnownDatabaseProperty,
  SpacePageId,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { sameLines, type CardLine } from "../board/BoardCard";
import { CellValue } from "../primitives/CellValue";
import type { DragData } from "./calendarDrag";
import type { WeekSegment } from "./calendarLayout";

const DateEditor = lazy(() =>
  import("../cells/DateEditor").then((m) => ({ default: m.DateEditor })),
);

export const LANE_BASE_HEIGHT = 22;
export const LINE_HEIGHT = 14;

export interface CalendarHandlers {
  open(pageId: SpacePageId): void;
  changeDate(pageId: SpacePageId | null): void;
  commitDate(pageId: SpacePageId, value: SpaceCellValue | null): void;
}

export interface CalendarItemProps {
  readonly segment: WeekSegment;
  readonly gridColumn: string;
  readonly gridRow: number;
  readonly time: string | null;
  readonly lines: ReadonlyArray<CardLine>;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: CellTextContext["optionHint"];
  readonly timeZone: string;
  readonly dateKnown: SpaceKnownDatabaseProperty | null;
  /** Drag to another day and drag the edges: the date property is a writable stored date. */
  readonly draggable: boolean;
  readonly editing: boolean;
  readonly handlers: CalendarHandlers;
}

/** The face of an item, shared with the drag overlay and the "more" list. */
export function ItemFace({
  row,
  time,
  lines,
  relatedPages,
  optionHint,
  timeZone,
}: Pick<CalendarItemProps, "lines" | "relatedPages" | "optionHint" | "timeZone" | "time"> & {
  readonly row: SpaceDatabaseRow;
}) {
  const title = rowTitle(row);
  return (
    <>
      <span className="flex min-w-0 items-baseline gap-1 text-xs font-medium">
        {time === null ? null : <span className="shrink-0 text-muted-foreground">{time}</span>}
        <span className={cn("truncate", title === "" && "text-muted-foreground")}>
          {title === "" ? "Untitled" : title}
        </span>
      </span>
      {lines.map((line) => (
        <span
          key={line.id}
          className="block h-3.5 min-w-0 truncate text-2xs leading-3.5 text-muted-foreground"
        >
          {row.cells[line.id] === undefined ? null : (
            <CellValue
              known={line.known}
              value={row.cells[line.id]}
              relatedPages={relatedPages}
              variant="card"
              optionHint={optionHint}
              timeZone={timeZone}
            />
          )}
        </span>
      ))}
    </>
  );
}

const EDGE =
  "absolute inset-y-0 z-10 w-1.5 cursor-ew-resize touch-none opacity-0 hover:opacity-100 focus-visible:opacity-100 bg-ring/40";

function EdgeHandle({ edge, data }: { readonly edge: "start" | "end"; readonly data: DragData }) {
  const { setNodeRef, listeners } = useDraggable({
    id: `edge:${edge}:${data.pageId}:${data.segmentStart}`,
    data: { ...data, edge },
  });
  return (
    <span
      ref={setNodeRef}
      aria-hidden
      data-edge={edge}
      {...listeners}
      className={cn(EDGE, edge === "start" ? "start-0 rounded-s-md" : "end-0 rounded-e-md")}
    />
  );
}

/** One item cut to one week: a button that opens the row, a drag source, and a row menu. */
export const CalendarItem = memo(
  function CalendarItem({
    segment,
    gridColumn,
    gridRow,
    time,
    lines,
    relatedPages,
    optionHint,
    timeZone,
    dateKnown,
    draggable,
    editing,
    handlers,
  }: CalendarItemProps) {
    const { row, startDay, endDay } = segment.item;
    const pageId = row.page.id;
    const data: DragData = {
      pageId,
      edge: "move",
      segmentStart: startDay,
      itemStart: startDay,
      itemEnd: endDay,
    };
    const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useDraggable({
      id: `item:${pageId}:${segment.first}`,
      data,
      disabled: !draggable,
    });
    const style: CSSProperties = { gridColumn, gridRow };
    return (
      <div
        ref={setNodeRef}
        role="listitem"
        data-item-id={pageId}
        style={style}
        className={cn(
          "group/item relative z-[1] mx-0.5 flex min-w-0 items-start overflow-hidden rounded-md border bg-background text-start shadow-xs/5",
          segment.continuesBefore && "ms-0 rounded-s-none border-s-0",
          segment.continuesAfter && "me-0 rounded-e-none border-e-0",
          isDragging && "opacity-40",
        )}
      >
        {draggable && !segment.continuesBefore ? <EdgeHandle edge="start" data={data} /> : null}
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...(draggable ? attributes : {})}
          {...(draggable ? listeners : {})}
          onClick={() => handlers.open(pageId)}
          className="min-w-0 flex-1 cursor-pointer px-1.5 py-0.5 text-start outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ItemFace
            row={row}
            time={time}
            lines={lines}
            relatedPages={relatedPages}
            optionHint={optionHint}
            timeZone={timeZone}
          />
        </button>
        {draggable ? (
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Actions for ${rowTitle(row) || "Untitled"}`}
                  className="mt-0.5 me-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none group-hover/item:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:opacity-100"
                />
              }
            >
              <MoreHorizontalIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => handlers.open(pageId)}>Open</MenuItem>
              <MenuItem onClick={() => handlers.changeDate(pageId)}>Change date…</MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        {draggable && !segment.continuesAfter ? <EdgeHandle edge="end" data={data} /> : null}
        {editing && dateKnown !== null ? (
          <Suspense fallback={null}>
            <DateEditor
              known={dateKnown}
              value={row.cells[dateKnown.id]}
              pageId={pageId}
              variant="field"
              relatedPages={relatedPages}
              onChange={(value) => handlers.commitDate(pageId, value)}
              onCommit={(value) => {
                handlers.commitDate(pageId, value);
                handlers.changeDate(null);
              }}
              onClose={() => handlers.changeDate(null)}
            />
          </Suspense>
        ) : null}
      </div>
    );
  },
  (prev, next) =>
    prev.segment.item.row === next.segment.item.row &&
    prev.segment.first === next.segment.first &&
    prev.segment.last === next.segment.last &&
    prev.segment.lane === next.segment.lane &&
    prev.segment.continuesBefore === next.segment.continuesBefore &&
    prev.segment.continuesAfter === next.segment.continuesAfter &&
    prev.gridColumn === next.gridColumn &&
    prev.gridRow === next.gridRow &&
    prev.time === next.time &&
    prev.relatedPages === next.relatedPages &&
    prev.timeZone === next.timeZone &&
    prev.draggable === next.draggable &&
    prev.editing === next.editing &&
    prev.handlers === next.handlers &&
    prev.dateKnown?.id === next.dateKnown?.id &&
    sameLines(prev.lines, next.lines),
);
