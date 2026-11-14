import { useDroppable } from "@dnd-kit/core";
import { addDays, rowTitle } from "@t2code/client-runtime/spaces";
import { PlusIcon } from "lucide-react";
import { memo } from "react";
import type { SpaceKnownDatabaseProperty, SpacePageId } from "@t2code/contracts/spaces";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import type { CardLine } from "../board/BoardCard";
import type { CellTextContext } from "../primitives/format";
import { DAY_ID_PREFIX } from "./calendarDrag";
import {
  gridSpan,
  itemTime,
  itemsOnDay,
  layoutWeek,
  visibleOffsets,
  type CalendarItem as Item,
} from "./calendarLayout";
import type { CalendarMode } from "./calendarRange";

import {
  CalendarItem,
  ItemFace,
  LANE_BASE_HEIGHT,
  LINE_HEIGHT,
  type CalendarHandlers,
} from "./CalendarItem";
import type { SpaceRelatedPage } from "@t2code/contracts/spaces";

const DAY_NUMBER_HEIGHT = 26;
const MORE_HEIGHT = 18;

interface DayCellProps {
  readonly day: string;
  readonly column: number;
  readonly muted: boolean;
  readonly today: boolean;
  readonly canAdd: boolean;
  readonly label: string;
  readonly onAdd: (day: string) => void;
}

function DayCell({ day, column, muted, today, canAdd, label, onAdd }: DayCellProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `${DAY_ID_PREFIX}${day}` });
  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      data-day={day}
      aria-label={label}
      style={{ gridColumn: column, gridRow: "1 / -1" }}
      className={cn(
        "group/day relative border-s first:border-s-0",
        muted && "bg-muted/30",
        isOver && "bg-ring/10 ring-1 ring-inset ring-ring",
      )}
    >
      <span
        className={cn(
          "absolute start-1 top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs",
          today ? "bg-primary text-primary-foreground" : "text-muted-foreground",
        )}
      >
        {Number(day.slice(8, 10))}
      </span>
      {canAdd ? (
        <button
          type="button"
          aria-label={`Add on ${day}`}
          className="absolute end-1 top-1 inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 outline-none hover:bg-accent group-hover/day:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => onAdd(day)}
        >
          <PlusIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export interface CalendarWeekProps {
  readonly weekFirstDay: string;
  readonly items: ReadonlyArray<Item>;
  readonly mode: CalendarMode;
  /** `YYYY-MM` of the month shown; days outside it are muted. */
  readonly month: string;
  readonly today: string;
  readonly showWeekends: boolean;
  readonly lines: ReadonlyArray<CardLine>;
  readonly datePropertyId: string;
  readonly dateKnown: SpaceKnownDatabaseProperty | null;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: CellTextContext["optionHint"];
  readonly timeZone: string;
  readonly draggable: boolean;
  readonly canAdd: boolean;
  readonly editingPageId: SpacePageId | null;
  readonly handlers: CalendarHandlers;
  readonly onAdd: (day: string) => void;
}

/** One week row: day cells as drop targets underneath, items placed on a grid of lanes above. */
export const CalendarWeek = memo(function CalendarWeek(props: CalendarWeekProps) {
  const { weekFirstDay, items, lines, showWeekends } = props;
  const offsets = visibleOffsets(weekFirstDay, showWeekends);
  const layout = layoutWeek(items, weekFirstDay);
  const laneHeight = LANE_BASE_HEIGHT + LINE_HEIGHT * lines.length;
  const anyOverflow = layout.overflow.some((count) => count > 0);
  const moreRow = layout.lanes + 2;
  const rows = [
    `${DAY_NUMBER_HEIGHT}px`,
    ...Array.from({ length: layout.lanes }, () => `${laneHeight}px`),
    ...(anyOverflow ? [`${MORE_HEIGHT}px`] : []),
    "minmax(8px, 1fr)",
  ].join(" ");
  return (
    <div
      role="row"
      data-week={weekFirstDay}
      className="grid border-t first:border-t-0"
      style={{
        gridTemplateColumns: `repeat(${offsets.length}, minmax(0, 1fr))`,
        gridTemplateRows: rows,
        minHeight: props.mode === "week" ? 320 : 96,
      }}
    >
      {offsets.map((offset, index) => {
        const day = addDays(weekFirstDay, offset);
        return (
          <DayCell
            key={day}
            day={day}
            column={index + 1}
            muted={props.mode === "month" && day.slice(0, 7) !== props.month}
            today={day === props.today}
            canAdd={props.canAdd}
            label={day}
            onAdd={props.onAdd}
          />
        );
      })}
      {layout.segments.map((segment) => {
        const span = gridSpan(segment.first, segment.last, offsets);
        if (span === null) return null;
        const { row } = segment.item;
        return (
          <CalendarItem
            key={`${row.page.id}:${segment.first}`}
            segment={segment}
            gridColumn={`${span.start} / ${span.end}`}
            gridRow={segment.lane + 2}
            time={itemTime(segment.item, props.datePropertyId, props.timeZone)}
            lines={lines}
            relatedPages={props.relatedPages}
            optionHint={props.optionHint}
            timeZone={props.timeZone}
            dateKnown={props.dateKnown}
            draggable={props.draggable}
            editing={props.editingPageId === row.page.id}
            handlers={props.handlers}
          />
        );
      })}
      {layout.overflow.map((count, offset) => {
        const column = offsets.indexOf(offset);
        if (count === 0 || column < 0) return null;
        const day = addDays(weekFirstDay, offset);
        return (
          <Popover key={day}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  style={{ gridColumn: column + 1, gridRow: moreRow }}
                  className="z-[1] mx-1 truncate rounded-sm px-1 text-start text-2xs text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            >
              +{count} more
            </PopoverTrigger>
            <PopoverPopup align="start" aria-label={`Items on ${day}`}>
              <ul className="flex w-64 flex-col gap-1">
                {itemsOnDay(items, day).map((item) => (
                  <li key={item.row.page.id}>
                    <button
                      type="button"
                      className="flex w-full flex-col rounded-md border px-2 py-1 text-start outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      aria-label={rowTitle(item.row) || "Untitled"}
                      onClick={() => props.handlers.open(item.row.page.id)}
                    >
                      <ItemFace
                        row={item.row}
                        time={itemTime(item, props.datePropertyId, props.timeZone)}
                        lines={lines}
                        relatedPages={props.relatedPages}
                        optionHint={props.optionHint}
                        timeZone={props.timeZone}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </PopoverPopup>
          </Popover>
        );
      })}
    </div>
  );
});
