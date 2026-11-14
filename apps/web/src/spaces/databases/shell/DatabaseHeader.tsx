import { useState } from "react";
import type { SpaceDatabaseView, SpaceViewId } from "@t2code/contracts/spaces";

import type { DatabaseBlockActions } from "../blocks/actions";
import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { useOpenControl } from "./context";
import { DatabaseToolbar } from "./DatabaseToolbar";
import { useCopyViewLink } from "./useCopyViewLink";
import { ViewTabs } from "./ViewTabs";

/** One row: the view tabs, then the toolbar. Without a decodable view only the tabs show. */
export function DatabaseHeader({
  model,
  collapsed,
  onCollapsed,
  tabs,
  activeId,
  hasView,
  blockActions,
  actions,
  search,
  onSearch,
  onChoose,
}: {
  readonly model: DatabaseModel;
  readonly collapsed: boolean;
  readonly onCollapsed: (collapsed: boolean) => void;
  readonly tabs: ReadonlyArray<SpaceDatabaseView>;
  readonly activeId: SpaceViewId | null;
  readonly hasView: boolean;
  readonly blockActions: DatabaseBlockActions;
  readonly actions: DatabaseActions;
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly onChoose: (id: SpaceViewId) => void;
}) {
  const [, setControl] = useOpenControl();
  const [renaming, setRenaming] = useState<SpaceViewId | null>(null);
  const copyLink = useCopyViewLink(model);
  const manage = model.permissions.views && model.permissions.block;
  const list = {
    model,
    views: tabs,
    activeId,
    manage,
    canReorder: manage && blockActions.remote === undefined,
    actions,
    onChoose,
    onRename: (id: SpaceViewId) => {
      onCollapsed(false);
      setRenaming(id);
    },
    onEdit: (id: SpaceViewId) => {
      onChoose(id);
      setControl("settings");
    },
    onCopyLink: copyLink,
  };
  const folded = collapsed && hasView;
  return (
    <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-1 border-b">
      {folded ? null : <ViewTabs list={list} renaming={renaming} onRenaming={setRenaming} />}
      {hasView ? (
        <DatabaseToolbar
          search={search}
          onSearch={onSearch}
          viewCount={tabs.length}
          collapsed={folded}
          onCollapsed={onCollapsed}
          list={list}
        />
      ) : null}
    </div>
  );
}
