import { addDays, canonicalJson, isoDay } from "@t2code/client-runtime/spaces";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import type {
  SpaceCellValue,
  SpaceDatabaseRow,
  SpaceGroupKey,
  SpaceKnownDatabaseView,
  SpacePageId,
} from "@t2code/contracts/spaces";

type TimelineLayout = Extract<SpaceKnownDatabaseView, { type: "timeline" }>["layout"];

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { dateProperties, isDateProperty, isWritableDateProperty } from "../calendar/dateProperties";
import { Latest } from "../data/latest";
import { useViewQuery } from "../data/useViewQuery";
import { OptionSelect } from "../controls/OptionSelect";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { useDatabase, useDatabaseActions } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import type { TimelineHandlers } from "./TimelineBar";
import { buildGridItems, visibleBuckets } from "../table/gridItems";
import { groupLabel } from "../table/groupLabel";
import { TimelineCanvas } from "./TimelineCanvas";
import { timelineLines, type TimelineGroupHandlers } from "./timelineLines";
import { barWrites, type BarMode } from "./timelineDrag";
import { DEFAULT_ZOOM, SPAN_DAYS, ZOOMS, makeScale, type Zoom } from "./timelineScale";

const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DEFAULT_TABLE_WIDTH = 240;
const GROUP_ROWS = 25;
const ZOOM_LABELS: Record<Zoom, string> = {
  hours: "Hours",
  day: "Day",
  week: "Week",
  biweek: "Bi-week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};

export default function TimelineView({ search }: DatabaseViewProps) {
  const { known, dataSource, model } = useDatabase();
  const actions = useDatabaseActions();
  const layout = known?.type === "timeline" ? known.layout : null;
  const start = layout === null ? undefined : dataSource.properties[layout.startPropertyId];
  if (layout === null || start === undefined || !isDateProperty(start))
    return (
      <div
        role="status"
        className="flex flex-col items-start gap-2 rounded-lg border border-dashed px-3 py-6 text-sm"
      >
        <span className="text-muted-foreground">
          Choose the date property that places items on the timeline.
        </span>
        <PropertyPicker
          properties={dateProperties(dataSource)}
          value={null}
          label="Start date property"
          disabled={!model.permissions.views || known === null}
          onChange={(startPropertyId) =>
            actions.editView({ layout: { ...known?.layout, startPropertyId } })
          }
        />
      </div>
    );
  return <Timeline search={search} layout={layout} />;
}

type TimelineActions = TimelineHandlers;

function Timeline({ search, layout }: DatabaseViewProps & { readonly layout: TimelineLayout }) {
  const { model, view, columns, dataSource, optionHint } = useDatabase();
  const actions = useDatabaseActions();
  const { permissions, limits } = model;
  const groupDef = view.group;
  const groupColumn =
    groupDef === undefined
      ? undefined
      : columns.find((column) => column.property.id === groupDef.property);
  const startId = layout.startPropertyId;
  const endId =
    layout.endPropertyId !== undefined &&
    layout.endPropertyId !== startId &&
    dataSource.properties[layout.endPropertyId] !== undefined
      ? layout.endPropertyId
      : null;
  const zoom = layout.zoom ?? DEFAULT_ZOOM;
  const startProperty = dataSource.properties[startId]!;
  const endProperty = endId === null ? null : dataSource.properties[endId]!;
  const draggable =
    permissions.cells &&
    isWritableDateProperty(startProperty) &&
    (endProperty === null || isWritableDateProperty(endProperty));

  const [today] = useState(() => isoDay(Date.now(), VIEWER_ZONE));
  const [anchor, setAnchor] = useState({ day: today, nonce: 0 });
  const query = useViewQuery(view, columns, {
    mode: groupColumn === undefined ? "rows" : "groups",
    rowsPerGroup: Math.min(GROUP_ROWS, limits.maxGroupPreviewRows),
    search,
    extraPropertyIds: endId === null ? [startId] : [startId, endId],
  });
  const [latest] = useState(
    () => new Latest<(TimelineActions & TimelineGroupHandlers) | null>(null),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set((view.group?.collapsed ?? []).map((key) => canonicalJson(key))),
  );
  const buckets = query.groups === null ? null : visibleBuckets(query.groups, groupDef);
  const lines = timelineLines(
    buildGridItems({
      rows: query.rows as ReadonlyArray<SpaceDatabaseRow>,
      groups: buckets,
      collapsed,
      hasMore: false,
      loadingMore: false,
      canAdd: false,
      bucketLoading: query.bucketLoading,
    }).items,
  );
  const [groupHandlers] = useState<TimelineGroupHandlers>(() => ({
    toggle: (id) => latest.get()?.toggle(id),
    loadBucket: (key) => latest.get()?.loadBucket(key),
  }));

  const [handlers] = useState<TimelineActions>(() => ({
    open: (pageId) => latest.get()?.open(pageId),
    move: (pageId, mode, minutes, flush) =>
      latest.get()?.move(pageId, mode, minutes, flush) ?? Promise.resolve(),
    hold: () => latest.get()?.hold() ?? (() => {}),
    setDates: (pageId, day) => latest.get()?.setDates(pageId, day),
  }));
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Point the stable bar handlers at the latest query and actions so memoized bars keep their props.
  useLayoutEffect(() => {
    latest.set({
      open: (pageId: SpacePageId) => actions.openRow(pageId),
      hold: () => query.hold(),
      toggle: (id: string) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      loadBucket: (key: SpaceGroupKey) => query.loadBucket(key),
      move: (pageId: SpacePageId, mode: BarMode, minutes: number, flush: boolean) => {
        const row = lines.find((line) => line.kind === "row" && line.row.page.id === pageId);
        if (row === undefined || row.kind !== "row") return Promise.resolve();
        const writes = barWrites({
          mode,
          deltaMinutes: minutes,
          startValue: row.row.cells[startId],
          endValue: endId === null ? undefined : row.row.cells[endId],
          separateEnd: endId !== null,
          zone: VIEWER_ZONE,
        });
        for (const write of writes)
          actions.editCell(pageId, write.side === "start" ? startId : endId!, write.value);
        return flush ? actions.flushCells() : Promise.resolve();
      },
      setDates: (pageId: SpacePageId, day: string) => {
        const value: SpaceCellValue = { start: day };
        actions.editCell(pageId, startId, value);
        if (endId !== null && endProperty !== null && isWritableDateProperty(endProperty))
          actions.editCell(pageId, endId, value);
      },
    });
  });

  if (query.status === "error" && lines.length === 0)
    return (
      <div role="alert" className="flex items-center gap-2 rounded-lg border px-3 py-4 text-sm">
        <span className="min-w-0 flex-1">{query.error ?? "Couldn't load the timeline."}</span>
        <Button size="xs" variant="outline" onClick={query.retry}>
          Retry
        </Button>
      </div>
    );
  const scale = makeScale(zoom, anchor.day);
  const half = Math.floor(SPAN_DAYS[zoom] / 2);
  const ready = query.status === "ready" || lines.length > 0;
  const labelOf = (bucket: Parameters<typeof groupLabel>[0]) =>
    groupLabel(
      bucket,
      groupColumn?.known ?? null,
      groupColumn?.property.name ?? "value",
      optionHint,
    );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Earlier"
          onClick={() => setAnchor((a) => ({ day: addDays(a.day, -half), nonce: a.nonce + 1 }))}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setAnchor((a) => ({ day: today, nonce: a.nonce + 1 }))}
        >
          Today
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Later"
          onClick={() => setAnchor((a) => ({ day: addDays(a.day, half), nonce: a.nonce + 1 }))}
        >
          <ChevronRightIcon />
        </Button>
        <div className="ms-auto">
          <OptionSelect<Zoom>
            label="Zoom"
            value={zoom}
            disabled={!permissions.views}
            choices={ZOOMS.map((value) => ({ value, label: ZOOM_LABELS[value] }))}
            onChange={(next) => actions.editView({ layout: { ...layout, zoom: next } })}
          />
        </div>
      </div>
      {!ready ? (
        <Skeleton role="status" aria-label="Loading timeline" className="h-72 w-full" />
      ) : lines.length === 0 ? (
        <p
          role="status"
          className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground"
        >
          No items
        </p>
      ) : (
        <TimelineCanvas
          key={`${zoom}:${anchor.day}:${anchor.nonce}`}
          scale={scale}
          anchorDay={anchor.day}
          today={today}
          lines={lines}
          labelOf={labelOf}
          groups={groupHandlers}
          startPropertyId={startId}
          endPropertyId={endId}
          zone={VIEWER_ZONE}
          showTable={layout.showTable ?? true}
          tableWidth={layout.tableWidth ?? DEFAULT_TABLE_WIDTH}
          canResizeTable={permissions.views}
          draggable={draggable}
          handlers={handlers}
          hasMore={buckets === null && query.hasMore && query.loadError === null}
          loadMore={query.loadMore}
          busy={query.stale}
          onTableWidth={(tableWidth) => actions.editView({ layout: { ...layout, tableWidth } })}
        />
      )}
      {query.loadError !== null ? (
        <div role="alert" className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">Couldn't load more.</span>
          <Button size="xs" variant="outline" onClick={query.retryLoad}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
