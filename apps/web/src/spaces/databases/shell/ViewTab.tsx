import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TableIcon } from "lucide-react";
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import type { SpaceDatabaseView, SpaceViewId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import type { DatabaseActions } from "../data/actions";
import { RenameInput } from "./RenameInput";
import { ViewMenu } from "./ViewTabMenu";
import { viewEntry } from "./viewRegistry";

export const TAB_CLASS =
  "relative flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export function TabIcon({ type }: { readonly type: string }) {
  const Icon = viewEntry(type)?.icon ?? TableIcon;
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

export function ViewTab({
  view,
  active,
  manage,
  canReorder,
  renaming,
  deletable,
  index,
  count,
  actions,
  onChoose,
  onRename,
  onEdit,
  onCopyLink,
  onMove,
}: {
  readonly view: SpaceDatabaseView;
  readonly active: boolean;
  readonly manage: boolean;
  readonly canReorder: boolean;
  readonly renaming: boolean;
  readonly deletable: boolean;
  /** Position among all views, not only the visible ones. */
  readonly index: number;
  readonly count: number;
  readonly actions: DatabaseActions;
  readonly onChoose: (id: SpaceViewId) => void;
  readonly onRename: (id: SpaceViewId | null) => void;
  readonly onEdit: (id: SpaceViewId) => void;
  readonly onCopyLink: (id: SpaceViewId) => void;
  readonly onMove: (from: number, to: number) => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: view.id,
    disabled: !canReorder || renaming,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const style = { transform: CSS.Translate.toString(transform), transition };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (renaming) return;
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    if (event.altKey && canReorder) {
      const target = index + step;
      if (target >= 0 && target < count) onMove(index, target);
      return;
    }
    const tabs = [
      ...(event.currentTarget
        .closest('[role="tablist"]')
        ?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ];
    const at = tabs.indexOf(event.currentTarget);
    tabs[Math.max(0, Math.min(tabs.length - 1, at + step))]?.focus();
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
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("group/tab flex shrink-0 items-center", isDragging && "z-10 opacity-80")}
      {...listeners}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        className={cn(
          TAB_CLASS,
          active
            ? "font-medium text-foreground after:absolute after:inset-x-2 after:-bottom-[5px] after:h-0.5 after:rounded-full after:bg-foreground"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        )}
        onKeyDown={onKeyDown}
        onContextMenu={(event: MouseEvent<HTMLElement>) => {
          if (!manage) return;
          event.preventDefault();
          onChoose(view.id);
          setMenuOpen(true);
        }}
        onClick={() => (active && manage ? setMenuOpen(true) : onChoose(view.id))}
      >
        <TabIcon type={view.type} />
        <span className="truncate">{view.name}</span>
      </button>
      {manage ? (
        <span
          className={cn(
            "-ms-1 inline-flex",
            !active &&
              "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          <ViewMenu
            view={view}
            deletable={deletable}
            actions={actions}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            trigger={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`${view.name} view options`}
                tabIndex={-1}
              />
            }
            onRename={() => onRename(view.id)}
            onEdit={() => onEdit(view.id)}
            onCopyLink={() => onCopyLink(view.id)}
          />
        </span>
      ) : null}
    </div>
  );
}
