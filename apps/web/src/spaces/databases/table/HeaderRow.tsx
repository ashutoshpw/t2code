import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon } from "lucide-react";
import { useRef, type PointerEvent } from "react";
import type { SpacePropertyId } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { AddPropertyButton } from "../controls/AddPropertyButton";
import { PropertyMenu } from "../controls/PropertyMenu";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { columnVar, draggedWidth, widthValue } from "./columnResize";
import { reorderedPropertyIds } from "./columnOrder";
import { HEADER_HEIGHT } from "./gridWindow";
import type { TableColumn } from "./tableTypes";

// Module constants: dnd-kit rebuilds its sensors when the options object changes.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } } as const;
const MODIFIERS = [restrictToHorizontalAxis];
export const ADD_COLUMN_WIDTH = 44;

interface Drag {
  readonly startX: number;
  readonly startWidth: number;
  readonly root: HTMLElement | null;
}

function HeaderCell({
  column,
  colIndex,
  movable,
  resizable,
  onResize,
}: {
  readonly column: TableColumn;
  readonly colIndex: number;
  readonly movable: boolean;
  readonly resizable: boolean;
  readonly onResize: (id: SpacePropertyId, width: number | null) => void;
}) {
  const isTitle = column.id === "title";
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !movable,
  });
  const drag = useRef<Drag | null>(null);
  const finish = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    drag.current = null;
    if (state === null) return;
    const width = draggedWidth(state.startWidth, event.clientX - state.startX);
    if (width === state.startWidth)
      state.root?.style.setProperty(columnVar(column.id), `${width}px`);
    else onResize(column.id, width);
  };
  return (
    <div
      ref={setNodeRef}
      role="columnheader"
      aria-colindex={colIndex}
      style={{
        width: widthValue(column.id),
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "relative flex h-full shrink-0 items-center border-e border-border/60 bg-background",
        isTitle && "sticky start-0 z-[3]",
        isDragging && "z-[4] opacity-80",
      )}
      {...(movable ? listeners : {})}
      onPointerDown={(event) => {
        // Portaled menus and dialogs are React children of this wrapper; only the header itself starts a drag.
        if (!event.currentTarget.contains(event.target as Node)) return;
        listeners?.onPointerDown?.(event);
      }}
    >
      <PropertyMenu
        propertyId={column.id}
        render={
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-start text-xs font-medium text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <PropertyTypeIcon type={column.type} />
            <span className="truncate">{column.name}</span>
          </button>
        }
      />
      {resizable ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${column.name}`}
          className="absolute inset-y-0 end-0 z-[1] w-1.5 cursor-col-resize touch-none hover:bg-ring/40"
          onPointerDown={(event) => {
            // Keeps the drag-to-reorder sensor and the menu trigger out of the resize.
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              startX: event.clientX,
              startWidth: column.width,
              root: event.currentTarget.closest<HTMLElement>("[data-grid-root]"),
            };
          }}
          onPointerMove={(event) => {
            const state = drag.current;
            state?.root?.style.setProperty(
              columnVar(column.id),
              `${draggedWidth(state.startWidth, event.clientX - state.startX)}px`,
            );
          }}
          onPointerUp={finish}
          onPointerCancel={() => {
            const state = drag.current;
            drag.current = null;
            state?.root?.style.setProperty(columnVar(column.id), `${state.startWidth}px`);
          }}
          onDoubleClick={() => onResize(column.id, null)}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
    </div>
  );
}

export function HeaderRow({
  columns,
  canSchema,
  canViews,
  totalWidth,
}: {
  /** Visible columns, title first. */
  readonly columns: ReadonlyArray<TableColumn>;
  readonly canSchema: boolean;
  readonly canViews: boolean;
  readonly totalWidth: number;
}) {
  const { columns: all } = useDatabase();
  const actions = useDatabaseActions();
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const sortable = columns.slice(1).map((column) => column.id);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over === null || active.id === over.id) return;
    actions.editView({
      properties: {
        order: reorderedPropertyIds(
          all.map((column) => ({ id: column.property.id, visible: column.visible })),
          String(active.id),
          String(over.id),
        ) as SpacePropertyId[],
      },
    });
  };
  const onResize = (id: SpacePropertyId, width: number | null) =>
    actions.editView({ properties: { set: { [id]: { width } } } });

  return (
    <div
      role="row"
      aria-rowindex={1}
      className="sticky top-0 z-[2] flex border-b bg-background"
      style={{ height: HEADER_HEIGHT, width: totalWidth }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={MODIFIERS}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={sortable} strategy={horizontalListSortingStrategy}>
          {columns.map((column, index) => (
            <HeaderCell
              key={column.id}
              column={column}
              colIndex={index + 1}
              movable={canViews && index > 0}
              resizable={canViews}
              onResize={onResize}
            />
          ))}
        </SortableContext>
      </DndContext>
      {canSchema ? (
        <div
          role="columnheader"
          aria-colindex={columns.length + 1}
          className="flex h-full items-center"
          style={{ width: ADD_COLUMN_WIDTH }}
        >
          <AddPropertyButton
            render={
              <button
                type="button"
                aria-label="Add a property"
                className="flex size-7 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <PlusIcon className="size-4" />
              </button>
            }
          />
        </div>
      ) : null}
    </div>
  );
}
