import { ChevronLeftIcon, DatabaseIcon, PlusIcon } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import type { SpaceDatabaseView, SpaceViewId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Separator } from "~/components/ui/separator";
import { cn } from "~/lib/utils";
import { SortableList, SortableRow } from "../controls/Sortable";
import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { canAddDataSource, NewViewPicker } from "./NewViewPicker";
import { TabIcon } from "./ViewTab";
import { ViewMenu } from "./ViewTabMenu";
import { matchViews } from "./viewTabs.logic";

export const ROW_CLASS =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

export interface ViewListProps {
  readonly model: DatabaseModel;
  readonly views: ReadonlyArray<SpaceDatabaseView>;
  readonly activeId: SpaceViewId | null;
  readonly manage: boolean;
  readonly canReorder: boolean;
  readonly actions: DatabaseActions;
  readonly onChoose: (id: SpaceViewId) => void;
  readonly onRename: (id: SpaceViewId) => void;
  readonly onEdit: (id: SpaceViewId) => void;
  readonly onCopyLink: (id: SpaceViewId) => void;
}

/** A popover over every view: search, drag handles, a "..." each, "New view" and "New data source". */
export function ViewsPopover({
  trigger,
  children,
  ...list
}: ViewListProps & { readonly trigger: ReactElement; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger}>{children}</PopoverTrigger>
      <PopoverPopup align="start" padding="none" width="sm">
        <OverflowBody {...list} onClose={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}

function OverflowBody({
  model,
  views,
  activeId,
  manage,
  canReorder,
  actions,
  onChoose,
  onRename,
  onEdit,
  onCopyLink,
  onClose,
}: ViewListProps & { readonly onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const matches = matchViews(views, query);
  const searching = query.trim() !== "";
  if (picking)
    return (
      <>
        <div className="flex h-9 items-center gap-1 px-2">
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Back"
            onClick={() => setPicking(false)}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="text-sm font-medium">New view</span>
        </div>
        <NewViewPicker mode="create" model={model} actions={actions} onDone={onClose} />
      </>
    );
  return (
    <>
      <div className="p-2">
        <Input
          size="compact"
          type="search"
          aria-label="Search views"
          placeholder="Search views…"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="max-h-72 overflow-y-auto px-1 pb-1">
        <SortableList
          ids={matches.map((view) => view.id)}
          onReorder={(ids) =>
            actions.reorderViews(
              ids.flatMap((id) => views.filter((view) => view.id === id).map((view) => view.id)),
            )
          }
        >
          {matches.map((view) => (
            <SortableRow
              key={view.id}
              id={view.id}
              label={view.name}
              reveal
              disabled={searching || !canReorder}
            >
              <button
                type="button"
                className={cn(ROW_CLASS, "min-w-0 flex-1", view.id === activeId && "bg-accent")}
                onClick={() => {
                  onChoose(view.id);
                  onClose();
                }}
              >
                <TabIcon type={view.type} />
                <span className="truncate">{view.name}</span>
              </button>
              {manage ? (
                <span className="opacity-0 group-hover/sortable:opacity-100 group-focus-within/sortable:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
                  <ViewMenu
                    view={view}
                    deletable={views.length > 1}
                    actions={actions}
                    trigger={
                      <Button
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={`${view.name} view options`}
                      />
                    }
                    onRename={() => {
                      onChoose(view.id);
                      onRename(view.id);
                      onClose();
                    }}
                    onEdit={() => {
                      onEdit(view.id);
                      onClose();
                    }}
                    onCopyLink={() => onCopyLink(view.id)}
                  />
                </span>
              ) : null}
            </SortableRow>
          ))}
        </SortableList>
      </div>
      {manage ? (
        <>
          <Separator />
          <div className="p-1">
            <button type="button" className={ROW_CLASS} onClick={() => setPicking(true)}>
              <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
              New view
            </button>
            {canAddDataSource(model) ? (
              <button
                type="button"
                className={ROW_CLASS}
                onClick={() => {
                  void actions.createDataSource();
                  onClose();
                }}
              >
                <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
                New data source
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
