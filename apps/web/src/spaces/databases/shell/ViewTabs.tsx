import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PlusIcon, TableIcon } from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { SpaceDatabaseView, SpaceViewId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import type { DatabaseBlockActions } from "../blocks/actions";
import type { DatabaseActions } from "../data/actions";
import type { DatabasePermissions } from "../data/useDatabaseModel";
import { RenameInput } from "./RenameInput";
import { DeleteViewDialog, ViewTabMenu } from "./ViewTabMenu";
import { VIEW_REGISTRY, VIEW_TYPES, viewEntry } from "./viewRegistry";

// Module constants: dnd-kit rebuilds its sensors when the options object changes.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } } as const;
const MODIFIERS = [restrictToHorizontalAxis];

function TabIcon({ type }: { readonly type: string }) {
  const Icon = viewEntry(type)?.icon ?? TableIcon;
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

function Tab({
  view,
  active,
  manage,
  renaming,
  siblings,
  onChoose,
  onRename,
  actions,
  index,
  count,
  onMove,
}: {
  readonly view: SpaceDatabaseView;
  readonly active: boolean;
  readonly manage: boolean;
  readonly renaming: boolean;
  readonly siblings: number;
  readonly onChoose: (id: SpaceViewId) => void;
  readonly onRename: (id: SpaceViewId | null) => void;
  readonly actions: DatabaseActions;
  readonly index: number;
  readonly count: number;
  readonly onMove: (from: number, to: number) => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: view.id,
    disabled: !manage || renaming,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The dialog opens once the menu has finished closing, or the menu leaves inert guards over it.
  const [deleteRequested, setDeleteRequested] = useState(false);
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (renaming) return;
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    if (event.altKey && manage) {
      const target = index + step;
      if (target >= 0 && target < count) onMove(index, target);
      return;
    }
    const tabs = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs?.[Math.max(0, Math.min(count - 1, index + step))]?.focus();
  };
  if (renaming)
    return (
      <div ref={setNodeRef} style={style} className="shrink-0 px-1">
        <RenameInput
          label="View name"
          value={view.name}
          onCommit={(name) => {
            actions.renameView(view.id, name);
            onRename(null);
          }}
          onCancel={() => onRename(null)}
        />
      </div>
    );
  const buttonProps = {
    type: "button",
    role: "tab",
    "aria-selected": active,
    tabIndex: active ? 0 : -1,
    className: cn(
      "flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    ),
    onKeyDown,
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      if (!manage) return;
      event.preventDefault();
      onChoose(view.id);
      setMenuOpen(true);
    },
  } as const;
  const content = (
    <>
      <TabIcon type={view.type} />
      <span className="truncate">{view.name}</span>
    </>
  );
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("shrink-0", isDragging && "z-10 opacity-80")}
      {...listeners}
    >
      {active && manage ? (
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onOpenChangeComplete={(open) => {
            if (!open && deleteRequested) {
              setDeleteRequested(false);
              setConfirming(true);
            }
          }}
        >
          <MenuTrigger render={<button {...buttonProps}>{content}</button>} />
          <MenuPopup align="start">
            <ViewTabMenu
              view={view}
              deletable={siblings > 1}
              actions={actions}
              onRename={() => onRename(view.id)}
              onDelete={() => setDeleteRequested(true)}
            />
          </MenuPopup>
        </Menu>
      ) : (
        <button {...buttonProps} onClick={() => onChoose(view.id)}>
          {content}
        </button>
      )}
      <DeleteViewDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void actions.deleteView(view.id)}
      />
    </div>
  );
}

export function ViewTabs({
  tabs,
  activeId,
  permissions,
  onChoose,
  actions,
  blockActions,
}: {
  readonly tabs: ReadonlyArray<SpaceDatabaseView>;
  readonly activeId: SpaceViewId | null;
  readonly permissions: DatabasePermissions;
  readonly onChoose: (id: SpaceViewId) => void;
  readonly actions: DatabaseActions;
  readonly blockActions: DatabaseBlockActions;
}) {
  const [renaming, setRenaming] = useState<SpaceViewId | null>(null);
  const manage = permissions.views && permissions.block;
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const ids = tabs.map((view) => view.id);
  const move = (from: number, to: number) => actions.reorderViews(arrayMove(ids, from, to));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(ids.indexOf(active.id as SpaceViewId), ids.indexOf(over.id as SpaceViewId));
  };
  void blockActions;
  return (
    <div className="flex items-center gap-1">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={MODIFIERS}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <div
            role="tablist"
            aria-label="Database views"
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            {tabs.map((view, index) => (
              <Tab
                key={view.id}
                view={view}
                active={view.id === activeId}
                manage={manage}
                renaming={renaming === view.id}
                siblings={tabs.length}
                onChoose={onChoose}
                onRename={setRenaming}
                actions={actions}
                index={index}
                count={tabs.length}
                onMove={move}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {manage ? (
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost-muted" size="icon-sm" aria-label="Add a view" />}
          >
            <PlusIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="start">
            {VIEW_TYPES.map((type) => {
              const { icon: Icon, label } = VIEW_REGISTRY[type];
              return (
                <MenuItem key={type} onClick={() => void actions.createView(type)}>
                  <Icon />
                  {label}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
