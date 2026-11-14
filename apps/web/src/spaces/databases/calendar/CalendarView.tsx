import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { isoDay, overlapFilter, propertyQueryType } from "@t2code/client-runtime/spaces";
import { useLayoutEffect, useRef, useState } from "react";
import type { SpaceCellValue, SpaceKnownDatabaseView, SpacePageId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useViewQuery } from "../data/useViewQuery";
import { Latest } from "../data/latest";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { useDatabase, useDatabaseActions } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import type { CardLine } from "../board/BoardCard";
import { CalendarHeader, periodTitle } from "./CalendarHeader";
import { ItemFace } from "./CalendarItem";
import type { CalendarHandlers } from "./CalendarItem";
import { CalendarWeek } from "./CalendarWeek";
import { DAY_ID_PREFIX, dayAtPoint, dropValue, type DragData } from "./calendarDrag";
import { calendarItems } from "./calendarLayout";
import {
  calendarRange,
  stepAnchor,
  weekColumns,
  type CalendarMode,
  type WeekStart,
} from "./calendarRange";
import { dateProperties, isDateProperty, isWritableDateProperty } from "./dateProperties";
import { NoDateButton } from "./NoDateList";

type CalendarLayout = Extract<SpaceKnownDatabaseView, { type: "calendar" }>["layout"];
type CalendarActions = CalendarHandlers & { add(day: string): void };

const MAX_ITEMS = 500;
const MAX_LINES = 3;
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } } as const;
const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const WEEKDAYS = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });

const weekdayName = (day: string) => WEEKDAYS.format(new Date(`${day}T00:00:00Z`));

function CalendarLoading() {
  return <Skeleton role="status" aria-label="Loading calendar" className="h-96 w-full" />;
}

export default function CalendarView({ search }: DatabaseViewProps) {
  const { known, dataSource } = useDatabase();
  const actions = useDatabaseActions();
  const { model } = useDatabase();
  const layout = known?.type === "calendar" ? known.layout : null;
  const property = layout === null ? undefined : dataSource.properties[layout.datePropertyId];
  if (layout === null || property === undefined || !isDateProperty(property))
    return (
      <div
        role="status"
        className="flex flex-col items-start gap-2 rounded-lg border border-dashed px-3 py-6 text-sm"
      >
        <span className="text-muted-foreground">
          Choose the date property that places items on the calendar.
        </span>
        <PropertyPicker
          properties={dateProperties(dataSource)}
          value={null}
          label="Date property"
          disabled={!model.permissions.views || known === null}
          onChange={(datePropertyId) =>
            actions.editView({ layout: { ...known?.layout, datePropertyId } })
          }
        />
      </div>
    );
  return <Calendar key={property.id} search={search} layout={layout} />;
}

function Calendar({ search, layout }: DatabaseViewProps & { readonly layout: CalendarLayout }) {
  const { model, view, columns, dataSource, optionHint } = useDatabase();
  const actions = useDatabaseActions();
  const { permissions } = model;
  const datePropertyId = layout.datePropertyId;
  const property = dataSource.properties[datePropertyId]!;
  const dateColumn = columns.find((column) => column.property.id === datePropertyId);
  const mode: CalendarMode = layout.mode ?? "month";
  const weekStart: WeekStart = layout.weekStart ?? "sunday";
  const showWeekends = layout.showWeekends ?? true;
  const writable = permissions.cells && isWritableDateProperty(property);

  const [today] = useState(() => isoDay(Date.now(), VIEWER_ZONE));
  const [anchor, setAnchor] = useState(today);
  const [editing, setEditing] = useState<SpacePageId | null>(null);
  const [active, setActive] = useState<(DragData & { grabDay: string }) | null>(null);
  const dragRelease = useRef<(() => void) | null>(null);

  const range = calendarRange(anchor, mode, weekStart);
  const query = useViewQuery(view, columns, {
    mode: "rows",
    search,
    extraFilter: overlapFilter(
      datePropertyId,
      propertyQueryType(property) ?? property.type,
      range.firstDay,
      range.lastDay,
    ),
    extraPropertyIds: [datePropertyId],
    fillRows: MAX_ITEMS,
  });
  const items = calendarItems(query.rows, datePropertyId, VIEWER_ZONE);
  const lines: ReadonlyArray<CardLine> = columns
    .filter(
      (column) =>
        column.visible && column.property.id !== "title" && column.property.id !== datePropertyId,
    )
    .slice(0, MAX_LINES)
    .map((column) => ({ id: column.property.id, known: column.known }));

  const [latest] = useState(() => new Latest<CalendarActions | null>(null));
  const [handlers] = useState<CalendarActions>(() => ({
    open: (pageId) => latest.get()?.open(pageId),
    changeDate: (pageId) => latest.get()?.changeDate(pageId),
    commitDate: (pageId, value) => latest.get()?.commitDate(pageId, value),
    add: (day) => latest.get()?.add(day),
  }));
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Point the stable item handlers at the latest query and actions so memoized weeks keep their props.
  useLayoutEffect(() => {
    latest.set({
      open: (pageId) => actions.openRow(pageId),
      changeDate: setEditing,
      commitDate: (pageId, value) => actions.editCell(pageId, datePropertyId, value),
      add: (day) => {
        const release = query.hold();
        const cells: Record<string, SpaceCellValue> = { [datePropertyId]: { start: day } };
        void actions
          .createRow({ cells })
          .then((row) => {
            if (row === null) return;
            query.placeRow(row, null);
            actions.openRow(row.page.id);
          })
          .finally(release);
      },
    });
  });

  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const onDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragData;
    dragRelease.current?.();
    dragRelease.current = query.hold();
    const origin = event.activatorEvent;
    const grabbed =
      "clientX" in origin && "clientY" in origin
        ? dayAtPoint(Number(origin.clientX), Number(origin.clientY))
        : null;
    setActive({ ...data, grabDay: grabbed ?? data.segmentStart });
  };
  const finish = () => {
    setActive(null);
    const release = dragRelease.current;
    dragRelease.current = null;
    return release;
  };
  const onDragEnd = (event: DragEndEvent) => {
    const data = event.active.data.current as DragData | undefined;
    const grabDay = active?.grabDay ?? data?.segmentStart;
    const release = finish();
    const over = event.over?.id;
    if (
      data !== undefined &&
      grabDay !== undefined &&
      typeof over === "string" &&
      over.startsWith(DAY_ID_PREFIX)
    ) {
      const row = query.rows.find((entry) => entry.page.id === data.pageId);
      const from =
        data.edge === "move" ? grabDay : data.edge === "start" ? data.itemStart : data.itemEnd;
      const next =
        row === undefined
          ? null
          : dropValue(
              row.cells[datePropertyId],
              data.edge,
              from,
              over.slice(DAY_ID_PREFIX.length),
              VIEWER_ZONE,
            );
      if (next !== null) {
        actions.editCell(data.pageId, datePropertyId, next);
        void actions.flushCells().finally(() => release?.());
        return;
      }
    }
    release?.();
  };

  const hasData = query.rows.length > 0 || query.status === "ready";
  if (query.status === "error" && !hasData)
    return (
      <div role="alert" className="flex items-center gap-2 rounded-lg border px-3 py-4 text-sm">
        <span className="min-w-0 flex-1">{query.error ?? "Couldn't load the calendar."}</span>
        <Button size="xs" variant="outline" onClick={query.retry}>
          Retry
        </Button>
      </div>
    );

  const firstWeek = range.weeks[0];
  const activeRow =
    active === null ? undefined : query.rows.find((row) => row.page.id === active.pageId);
  const dateKnown = dateColumn?.known ?? null;
  const capped = query.hasMore && query.rows.length >= MAX_ITEMS;

  return (
    <div className="space-y-2">
      <CalendarHeader
        title={periodTitle(anchor, mode, range.firstDay, range.lastDay)}
        mode={mode}
        canChangeMode={permissions.views}
        onStep={(direction) => setAnchor((current) => stepAnchor(current, mode, direction))}
        onToday={() => setAnchor(today)}
        onMode={(next) => actions.editView({ layout: { ...layout, mode: next } })}
        trailing={
          property.type === "date" ? (
            <NoDateButton
              view={view}
              columns={columns}
              search={search}
              propertyId={datePropertyId}
              dateKnown={dateKnown}
              canEdit={writable}
              onOpen={(pageId) => actions.openRow(pageId)}
              onSet={(pageId, value) => actions.editCell(pageId, datePropertyId, value)}
            />
          ) : null
        }
      />
      {!hasData ? (
        <CalendarLoading />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => finish()?.()}
        >
          <div
            role="grid"
            aria-label="Calendar"
            aria-busy={query.stale}
            className="overflow-hidden rounded-lg border"
          >
            {firstWeek === undefined ? null : (
              <div
                role="row"
                className="grid border-b bg-muted/30 text-xs text-muted-foreground"
                style={{
                  gridTemplateColumns: `repeat(${showWeekends ? 7 : 5}, minmax(0, 1fr))`,
                }}
              >
                {weekColumns(firstWeek, showWeekends).map((day) => (
                  <div key={day} role="columnheader" className="px-2 py-1">
                    {weekdayName(day)}
                  </div>
                ))}
              </div>
            )}
            {range.weeks.map((week) => (
              <CalendarWeek
                key={week}
                weekFirstDay={week}
                items={items}
                mode={mode}
                month={anchor.slice(0, 7)}
                today={today}
                showWeekends={showWeekends}
                lines={lines}
                datePropertyId={datePropertyId}
                dateKnown={dateKnown}
                relatedPages={query.relatedPages}
                optionHint={optionHint}
                timeZone={VIEWER_ZONE}
                draggable={writable}
                canAdd={permissions.rows && writable}
                editingPageId={editing}
                handlers={handlers}
                onAdd={handlers.add}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {activeRow === undefined ? null : (
              <div
                data-dnd-active
                className="w-48 cursor-grabbing rounded-md border bg-background px-1.5 py-0.5 shadow-md"
              >
                <ItemFace
                  row={activeRow}
                  time={null}
                  lines={[]}
                  relatedPages={query.relatedPages}
                  optionHint={optionHint}
                  timeZone={VIEWER_ZONE}
                />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}
      {query.loadError !== null ? (
        <div role="alert" className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">Couldn't load the whole range.</span>
          <Button size="xs" variant="outline" onClick={query.retryLoad}>
            Retry
          </Button>
        </div>
      ) : null}
      {capped ? (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          Showing the first {MAX_ITEMS} items in this range
        </p>
      ) : null}
    </div>
  );
}
