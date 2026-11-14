import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { SpaceViewId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { observeResize } from "~/lib/observeResize";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { NewViewPicker } from "./NewViewPicker";
import { TAB_CLASS, TabIcon, ViewTab } from "./ViewTab";
import { ViewsPopover, type ViewListProps } from "./ViewsOverflow";
import { fitTabs } from "./viewTabs.logic";

// Module constants: dnd-kit rebuilds its sensors when the options object changes.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } } as const;
const MODIFIERS = [restrictToHorizontalAxis];
const GAP = 2;
const PLUS_WIDTH = 28;

function AddViewButton({
  model,
  actions,
}: {
  readonly model: DatabaseModel;
  readonly actions: DatabaseActions;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button variant="ghost-muted" size="icon-xs" aria-label="Add a view" />}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Add a view</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" padding="none" width="sm">
        <NewViewPicker
          mode="create"
          model={model}
          actions={actions}
          onDone={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** The views as tabs that fit their row; the rest sit behind "N more…". */
export function ViewTabs({
  list,
  renaming,
  onRenaming,
}: {
  readonly list: ViewListProps;
  readonly renaming: SpaceViewId | null;
  readonly onRenaming: (id: SpaceViewId | null) => void;
}) {
  const { model, views: tabs, activeId, manage, canReorder, actions } = list;
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const ids = tabs.map((view) => view.id);
  const move = (from: number, to: number) => actions.reorderViews(arrayMove(ids, from, to));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(ids.indexOf(active.id as SpaceViewId), ids.indexOf(over.id as SpaceViewId));
  };

  const signature = tabs.map((view) => `${view.id}:${view.type}:${view.name}`).join("|");
  const measuring = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ signature: string; widths: number[] } | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Measure tab widths from the DOM when names change; the strip fits tabs to its width.
  useLayoutEffect(() => {
    const widths = [...(measuring.current?.children ?? [])].map((child) =>
      child instanceof HTMLElement ? child.offsetWidth : 0,
    );
    setMeasured({ signature, widths });
  }, [signature]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Follow the strip's width to refit tabs.
  useLayoutEffect(() => {
    if (strip === null) return;
    return observeResize(strip, ([entry]) => {
      const next = Math.floor(entry?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
  }, [strip]);

  const fresh = measured?.signature === signature ? measured.widths : null;
  const fit =
    fresh === null || width === null || fresh.length !== tabs.length + 1
      ? null
      : fitTabs({
          widths: fresh.slice(0, -1),
          available: width - (manage ? PLUS_WIDTH : 0),
          gap: GAP,
          moreWidth: fresh[fresh.length - 1] ?? 0,
          activeIndex: tabs.findIndex((view) => view.id === activeId),
        });
  const visible = fit === null ? tabs : fit.visible.flatMap((index) => tabs[index] ?? []);
  const hidden = fit?.hidden.length ?? 0;
  return (
    <div ref={setStrip} className="relative flex min-w-48 flex-1 items-center gap-0.5">
      <div
        aria-hidden
        inert
        className="pointer-events-none invisible absolute inset-0 overflow-hidden"
      >
        <div ref={measuring} className="absolute start-0 top-0 flex gap-0.5 whitespace-nowrap">
          {tabs.map((view) => (
            <span key={view.id} className="inline-flex shrink-0 items-center">
              <span className={TAB_CLASS}>
                <TabIcon type={view.type} />
                <span className="truncate">{view.name}</span>
              </span>
              {manage ? <span className="-ms-1 size-6 shrink-0" /> : null}
            </span>
          ))}
          <span className="inline-flex h-7 items-center px-2 text-xs">99 more…</span>
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={MODIFIERS}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={visible.map((view) => view.id)}
          strategy={horizontalListSortingStrategy}
        >
          <div
            role="tablist"
            aria-label="Database views"
            className="flex min-w-0 items-center gap-0.5 overflow-hidden"
          >
            {visible.map((view) => (
              <ViewTab
                key={view.id}
                view={view}
                active={view.id === activeId}
                manage={manage}
                canReorder={canReorder}
                renaming={renaming === view.id}
                deletable={tabs.length > 1}
                index={ids.indexOf(view.id)}
                count={tabs.length}
                actions={actions}
                onChoose={list.onChoose}
                onRename={onRenaming}
                onEdit={list.onEdit}
                onCopyLink={list.onCopyLink}
                onMove={move}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {hidden > 0 ? (
        <ViewsPopover
          {...list}
          trigger={<Button variant="ghost-muted" size="xs" aria-label={`${hidden} more views`} />}
        >
          {hidden} more…
        </ViewsPopover>
      ) : null}
      {manage ? <AddViewButton model={model} actions={actions} /> : null}
    </div>
  );
}
