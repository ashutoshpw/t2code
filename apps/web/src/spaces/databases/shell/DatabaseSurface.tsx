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
import type { DatabaseBlockHost, DatabaseLayout } from "../blocks/DatabaseBlockHost";
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
import { LinkedHeader } from "./LinkedHeader";
import { DatabaseToolbar } from "./DatabaseToolbar";
import { ViewTabs } from "./ViewTabs";
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
}: {
  readonly model: DatabaseModel;
  readonly blockId: SpaceBlockId;
  readonly viewIds: ReadonlyArray<SpaceViewId>;
  readonly actions: DatabaseBlockActions;
  readonly layout: DatabaseLayout;
  readonly host: DatabaseBlockHost;
}) {
  const registry = useContext(RegistryContext);
  const stores = databaseStores(registry);
  const peek = useContext(RowPeekContext);
  const [edits, setEdits] = useState<ViewEdits>([]);
  const [editIds] = useState(() => new Latest(0));
  const [activeId, setActiveId] = useState<SpaceViewId | null>(
    () => stores.activeView.get(blockId) ?? null,
  );
  const [search, setSearch] = useState("");
  const [control, setControl] = useState<OpenControl>(null);

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
      <OpenControlContext.Provider value={[control, setControl]}>
        <section
          aria-label={model.database.title || "Database"}
          className="min-w-0 space-y-1.5 text-sm"
        >
          {linked ? (
            <LinkedHeader model={model} host={host} />
          ) : layout === "inline" ? (
            <DatabaseTitle model={model} />
          ) : null}
          <ViewTabs
            tabs={tabs}
            activeId={view?.id ?? null}
            permissions={model.permissions}
            onChoose={choose}
            actions={actions}
            blockActions={blockActions}
          />
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
              <DatabaseToolbar search={search} onSearch={setSearch} />
              <ViewBody key={context.view.id} search={search} type={context.known?.type ?? null} />
            </DatabaseContext.Provider>
          )}
        </section>
      </OpenControlContext.Provider>
    </DatabaseActionsContext.Provider>
  );
}
