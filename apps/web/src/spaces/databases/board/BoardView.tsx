import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type KeyboardSensorOptions,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  canonicalJson,
  newRowCells,
  orderBuckets,
  regroupBuckets,
} from "@t2code/client-runtime/spaces";
import { useLayoutEffect, useRef, useState } from "react";
import {
  SpaceKnownGroupKey,
  type SpaceGroupKey,
  type SpaceKnownGroupBy,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Latest } from "../data/latest";
import { useViewQuery } from "../data/useViewQuery";
import { useDatabase, useDatabaseActions } from "../shell/context";
import type { DatabaseViewProps } from "../shell/viewTypes";
import { groupLabel } from "../table/groupLabel";
import { CARD_FACE, CardBody, type CardLine } from "./BoardCard";
import { BoardColumn, ColumnGhost, type BoardHandlers } from "./BoardColumn";
import { boardKeyboardCoordinates, columnCollision } from "./boardDom";
import { canWriteGroup } from "./boardDrag";
import { BoardSetup } from "./BoardSetup";
import { HiddenGroups } from "./HiddenGroups";
import { createCard } from "./newCard";
import { useBoardDrag } from "./useBoardDrag";

const GROUP_ROWS = 25;
const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const isKnownGroupKey = Schema.is(SpaceKnownGroupKey);
// Module constants: dnd-kit rebuilds its sensors when the options object changes.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } } as const;
const KEYBOARD_OPTIONS: KeyboardSensorOptions = {
  coordinateGetter: boardKeyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
};

const localDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

function BoardLoading() {
  return (
    <div role="status" aria-label="Loading cards" className="flex gap-3">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-48 w-68 shrink-0" />
      ))}
    </div>
  );
}

export default function BoardView({ search }: DatabaseViewProps) {
  const { view, columns } = useDatabase();
  const group = view.group;
  const column =
    group === undefined ? undefined : columns.find((entry) => entry.property.id === group.property);
  if (group === undefined || column === undefined) return <BoardSetup />;
  return <Board search={search} />;
}

function Board({ search }: DatabaseViewProps) {
  const { model, view, known: knownView, columns, layout: pageLayout, optionHint } = useDatabase();
  const actions = useDatabaseActions();
  const { permissions, limits } = model;
  const groupDef = view.group!;
  const groupColumn = columns.find((entry) => entry.property.id === groupDef.property)!;
  const known = groupColumn.known;
  const knownGroup = knownView?.group;
  const query = useViewQuery(view, columns, {
    mode: "groups",
    rowsPerGroup: Math.min(GROUP_ROWS, limits.maxGroupPreviewRows),
    search,
  });
  const [adding, setAdding] = useState<string | null>(null);
  const [busy] = useState(() => ({ adding: false }));
  const root = useRef<HTMLDivElement>(null);

  const regrouped =
    query.groups === null
      ? null
      : regroupBuckets(
          query.groups,
          query.pending,
          known,
          groupDef.by as SpaceKnownGroupBy | undefined,
          query.placements,
        );
  const { shown, hidden } =
    regrouped === null ? { shown: [], hidden: [] } : orderBuckets(regrouped, groupDef);

  const lines: ReadonlyArray<CardLine> = columns
    .filter(
      (entry) =>
        entry.visible && entry.property.id !== "title" && entry.property.id !== groupDef.property,
    )
    .map((entry) => ({ id: entry.property.id, known: entry.known }));

  const [latest] = useState(() => new Latest<(BoardHandlers & { dummy?: never }) | null>(null));
  const [handlers] = useState<BoardHandlers>(() => ({
    open: (pageId) => latest.get()?.open(pageId),
    addCard: (key) => latest.get()?.addCard(key),
    loadBucket: (key) => latest.get()?.loadBucket(key),
    setHidden: (key, value) => latest.get()?.setHidden(key, value),
  }));
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Point the stable column handlers at the latest view and query so memoized columns keep their props.
  useLayoutEffect(() => {
    latest.set({
      open: (pageId) => actions.openRow(pageId),
      loadBucket: (key) => query.loadBucket(key),
      setHidden: (key, value) => {
        if (knownGroup === undefined || !isKnownGroupKey(key)) return;
        const id = canonicalJson(key);
        const rest = (knownGroup.hidden ?? []).filter((entry) => canonicalJson(entry) !== id);
        actions.editView({ group: { ...knownGroup, hidden: value ? [...rest, key] : rest } });
      },
      addCard: (key) => {
        if (busy.adding || !permissions.rows || !isKnownGroupKey(key)) return;
        busy.adding = true;
        setAdding(canonicalJson(key));
        void createCard({
          actions,
          hold: query.hold,
          placeRow: query.placeRow,
          key,
          cells: newRowCells({
            filter: view.filter,
            properties: Object.fromEntries(
              columns.map((entry) => [entry.property.id, entry.property]),
            ),
            group: { property: groupDef.property, key },
            today: localDay(),
          }),
        }).finally(() => {
          busy.adding = false;
          setAdding(null);
        });
      },
    });
  });

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
  );
  const drag = useBoardDrag({
    root,
    view,
    group: knownGroup,
    property: groupDef.property,
    known,
    shown,
    hidden,
    canCards: permissions.cells,
    canViews: permissions.views,
    actions,
    hold: query.hold,
    setPlacement: query.setPlacement,
  });

  const hasData = query.groups !== null || query.status === "ready";
  if (query.status === "error" && !hasData)
    return (
      <div role="alert" className="flex items-center gap-2 rounded-lg border px-3 py-4 text-sm">
        <span className="min-w-0 flex-1">{query.error ?? "Couldn't load the cards."}</span>
        <Button size="xs" variant="outline" onClick={query.retry}>
          Retry
        </Button>
      </div>
    );
  if (!hasData) return <BoardLoading />;

  const labelOf = (bucket: (typeof shown)[number]) =>
    groupLabel(bucket, known, groupColumn.property.name, optionHint);
  const tint = (view.layout as { colorColumns?: boolean }).colorColumns === true;
  const overlayRow =
    drag.active?.kind === "card"
      ? regrouped
          ?.find(
            (bucket) =>
              canonicalJson(bucket.key) ===
              canonicalJson((drag.active as { group: SpaceGroupKey }).group),
          )
          ?.rows.find((row) => row.page.id === (drag.active as { pageId: string }).pageId)
      : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={columnCollision}
      onDragStart={drag.onDragStart}
      onDragMove={drag.onDragMove}
      onDragEnd={drag.onDragEnd}
      onDragCancel={drag.onDragCancel}
    >
      <div
        ref={root}
        aria-busy={query.stale}
        className="flex items-start gap-3 overflow-x-auto overscroll-x-contain pb-2"
      >
        {shown.map((bucket) => {
          const label = labelOf(bucket);
          const writable = canWriteGroup(bucket.key, known);
          const id = canonicalJson(bucket.key);
          return (
            <BoardColumn
              key={id}
              id={id}
              bucket={bucket}
              labelText={label.text}
              labelColor={label.color}
              lines={lines}
              relatedPages={query.relatedPages}
              optionHint={optionHint}
              timeZone={VIEWER_ZONE}
              canAdd={permissions.rows && writable}
              adding={adding === id}
              canDragCards={permissions.cells && writable}
              canMove={permissions.views && bucket.key.kind !== "empty"}
              canHide={permissions.views}
              tint={tint}
              loadingMore={query.bucketLoading(bucket.key)}
              page={pageLayout === "page"}
              handlers={handlers}
            />
          );
        })}
        {hidden.length > 0 ? (
          <HiddenGroups
            buckets={hidden}
            labelOf={labelOf}
            canShow={permissions.views}
            onShow={(key) => handlers.setHidden(key, false)}
          />
        ) : null}
      </div>
      {query.loadError !== null ? (
        <div
          role="alert"
          className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
        >
          <span className="min-w-0 flex-1">Couldn't load more.</span>
          <Button size="xs" variant="outline" onClick={query.retryLoad}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.groupsTruncated ? (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          Showing the first {shown.length + hidden.length} groups
        </p>
      ) : null}
      <DragOverlay dropAnimation={null}>
        {overlayRow !== undefined ? (
          <div className={`${CARD_FACE} w-64 cursor-grabbing shadow-md`}>
            <CardBody
              row={overlayRow}
              lines={lines}
              relatedPages={query.relatedPages}
              optionHint={optionHint}
              timeZone={VIEWER_ZONE}
            />
          </div>
        ) : drag.active?.kind === "column" ? (
          <ColumnGhost text={drag.active.text} color={drag.active.color} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
