import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { cn } from "~/lib/utils";

// Module constants: dnd-kit rebuilds its sensors when the options object changes.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } } as const;
const KEYBOARD_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates } as const;
const MODIFIERS = [restrictToVerticalAxis];

const MoveContext = createContext<((id: string, delta: number) => void) | null>(null);

/** A vertical sortable list; pointer drag and keyboard (Space, arrows, Space) on each handle. */
export function SortableList({
  ids,
  onReorder,
  children,
}: {
  readonly ids: ReadonlyArray<string>;
  readonly onReorder: (ids: ReadonlyArray<string>) => void;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove([...ids], from, to));
  };
  const move = (id: string, delta: number) => {
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from >= 0 && to >= 0 && to < ids.length) onReorder(arrayMove([...ids], from, to));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={MODIFIERS}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        <MoveContext.Provider value={move}>{children}</MoveContext.Provider>
      </SortableContext>
    </DndContext>
  );
}

export function SortableRow({
  id,
  label,
  disabled = false,
  className,
  children,
}: {
  readonly id: string;
  /** Names the handle: "Reorder <label>". */
  readonly label: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  const move = useContext(MoveContext);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-1.5",
        isDragging && "z-10 bg-popover opacity-80",
        className,
      )}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        disabled={disabled}
        aria-label={`Reorder ${label}`}
        className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
        {...attributes}
        {...listeners}
        // Alt+Arrow moves a row without a drag: dnd-kit's key listeners sit on the document,
        // which a modal dialog around the list can keep from seeing.
        onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            move?.(id, event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          listeners?.onKeyDown?.(event);
        }}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      {children}
    </div>
  );
}
