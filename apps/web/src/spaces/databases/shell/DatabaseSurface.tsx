import { RegistryContext } from "@effect/atom-react";
import {
  effectiveView,
  knownView,
  queueViewEdit,
  ackViewEdit,
  dropViewEdit,
  resolveBlockViews,
  viewColumns,
  type ViewEdits,
  type ViewPatch,
} from "@t2code/client-runtime/spaces";
import { Suspense, useContext, useLayoutEffect, useState } from "react";
import type {
  SpaceBlockId,
  SpaceDatabaseView,
  SpaceDataSource,
  SpaceViewId,
} from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";

import type { DatabaseBlockActions } from "../blocks/actions";
import type { DatabaseLayout, DatabaseSurfaceHost } from "../blocks/DatabaseBlockHost";
import { createDatabaseActions, type ActionsState } from "../data/actions";
import { Latest } from "../data/latest";
import { databaseStores } from "../data/stores";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { RowPeekContext } from "../row/rowPeekContext";
import {
  DatabaseActionsContext,
  DatabaseContext,
  OpenControlContext,
  type DatabaseContextValue,
  type OpenControl,
} from "./context";
import { DatabaseSkeleton } from "./DatabaseSkeleton";
import { isLinkedBlock } from "../blocks/useIsLinkedBlock";
import { AddFirstView } from "./AddFirstView";
import { DatabaseTitle } from "./DatabaseTitle";
import { DatabaseHeader } from "./DatabaseHeader";
import { viewEntry } from "./viewRegistry";
import type { DatabaseViewProps } from "./viewTypes";

const placeholderView = (model: DatabaseModel, source: SpaceDataSource): SpaceDatabaseView => ({
  id: "no-view" as SpaceViewId,
  databaseId: model.database.id,
  dataSourceId: source.id,
  name: "",
  type: "table",
  position: 0,
  sorts: [],
  properties: [],
  layout: {},
});

function UnsupportedView() {
  return (
    <p
      role="status"
      className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground"
    >
      This view type isn't supported in this version.
    </p>
  );
}

function ViewBody({ search, type }: DatabaseViewProps & { type: string | null }) {
  const entry = type === null ? undefined : viewEntry(type);
  return (
    <Suspense fallback={<DatabaseSkeleton />}>
      {entry === undefined ? <UnsupportedView /> : <entry.Body search={search} />}
    </Suspense>
  );
}

export function DatabaseSurface({
  model,
  blockId,
  viewIds,
  actions: blockActions,
  layout,
  host,
  hideTitle = false,
  fullPage = false,
  initialViewId = null,
}: {
  readonly model: DatabaseModel;
  readonly blockId: SpaceBlockId;
  readonly viewIds: ReadonlyArray<SpaceViewId>;
  readonly actions: DatabaseBlockActions;
  readonly layout: DatabaseLayout;
  readonly host: DatabaseSurfaceHost;
  readonly hideTitle?: boolean;
  /** The database's own page: a large title, and tab edits go through the server. */
  readonly fullPage?: boolean;
  readonly initialViewId?: SpaceViewId | null;
}) {
  const registry = useContext(RegistryContext);
  const stores = databaseStores(registry);
  const peek = useContext(RowPeekContext);
  const [edits, setEdits] = useState<ViewEdits>([]);
  const [editIds] = useState(() => new Latest(0));
  const [activeId, setActiveId] = useState<SpaceViewId | null>(
    () => initialViewId ?? stores.activeView.get(blockId) ?? null,
  );
  const [search, setSearch] = useState("");
  const [control, setControl] = useState<OpenControl>(null);
  const [collapsed, setCollapsed] = useState(() => stores.collapsed.has(blockId));
  const fold = (next: boolean) => {
    if (next) stores.collapsed.add(blockId);
    else stores.collapsed.delete(blockId);
    setCollapsed(next);
  };
  // A control opening from elsewhere (a property menu, the title menu) needs the toolbar it lives in.
  const openControl = (next: OpenControl) => {
    if (next !== null) fold(false);
    setControl(next);
  };

  const revision = model.database.revision;
  const tabs = resolveBlockViews(viewIds, model.views).map((view) =>
    effectiveView(view, edits, revision),
  );
  const view = tabs.find((entry) => entry.id === activeId) ?? tabs[0] ?? null;
  const dataSource =
    view === null
      ? null
      : (model.dataSources.find((source) => source.id === view.dataSourceId) ?? null);
  const linked = isLinkedBlock(model.database.home, blockId);
  // Without a view the actions still need a data source to create the first one on.
  const firstSource = model.dataSources[0];

  const [latest] = useState(() => new Latest<ActionsState | null>(null));
  const [actions] = useState(() =>
    createDatabaseActions({
      registry,
      state: () => {
        const state = latest.get();
        if (state === null) throw new Error("Database actions used before the surface mounted");
        return state;
      },
      queueViewEdit: (viewId: SpaceViewId, patch: ViewPatch) => {
        const id = editIds.get() + 1;
        editIds.set(id);
        setEdits((current) =>
          queueViewEdit(
            current,
            { id, viewId, patch, ack: undefined },
            latest.get()?.model.database.revision ?? 0,
          ),
        );
        return id;
      },
      ackViewEdit: (id, databaseRevision) =>
        setEdits((current) => ackViewEdit(current, id, databaseRevision)),
      dropViewEdit: (id) => setEdits((current) => dropViewEdit(current, id)),
      activate: (viewId) => {
        stores.activeView.set(blockId, viewId);
        setActiveId(viewId);
      },
    }),
  );
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Keep the stable actions object pointing at the latest model and view without re-creating it.
  useLayoutEffect(() => {
    latest.set(
      view !== null && dataSource !== null
        ? { model, dataSource, view, viewIds, block: blockActions, host, peek }
        : firstSource === undefined
          ? null
          : {
              model,
              dataSource: firstSource,
              view: placeholderView(model, firstSource),
              viewIds,
              block: blockActions,
              host,
              peek,
            },
    );
  });
  const [optionHint] = useState(
    () => (propertyId: string, optionId: string) =>
      stores.optionHints.get(`${propertyId}:${optionId}`),
  );

  const choose = (viewId: SpaceViewId) => {
    stores.activeView.set(blockId, viewId);
    setActiveId(viewId);
  };

  const context: DatabaseContextValue | null =
    view === null || dataSource === null
      ? null
      : {
          model,
          dataSource,
          view,
          known: knownView(view),
          columns: viewColumns(view, dataSource),
          layout,
          blockId,
          optionHint,
        };

  return (
    <DatabaseActionsContext.Provider value={actions}>
      <OpenControlContext.Provider value={[control, openControl]}>
        <section
          aria-label={model.database.title || "Database"}
          className="min-w-0 space-y-1.5 text-sm"
        >
          {fullPage || (!hideTitle && (linked || layout === "inline")) ? (
            <DatabaseTitle
              model={model}
              blockActions={blockActions}
              variant={fullPage ? "page" : "inline"}
              linked={linked}
              host={host}
              canEditLayout={Boolean(context?.known)}
            />
          ) : null}
          <DatabaseContext.Provider value={context}>
            <DatabaseHeader
              model={model}
              collapsed={collapsed}
              onCollapsed={fold}
              tabs={tabs}
              activeId={view?.id ?? null}
              hasView={context !== null}
              blockActions={blockActions}
              actions={actions}
              search={search}
              onSearch={setSearch}
              onChoose={choose}
            />
          </DatabaseContext.Provider>
          {context === null ? (
            linked ? (
              <AddFirstView model={model} actions={actions} />
            ) : (
              <div className="space-y-2 rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                <p role="status">This database has no views here</p>
                {model.permissions.views && model.permissions.block ? (
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => void actions.createView("table")}
                  >
                    Add a table view
                  </Button>
                ) : null}
              </div>
            )
          ) : (
            <DatabaseContext.Provider value={context}>
              <ViewBody key={context.view.id} search={search} type={context.known?.type ?? null} />
            </DatabaseContext.Provider>
          )}
        </section>
      </OpenControlContext.Provider>
    </DatabaseActionsContext.Provider>
  );
}
