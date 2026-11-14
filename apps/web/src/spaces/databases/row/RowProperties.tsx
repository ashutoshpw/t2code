import { RegistryContext } from "@effect/atom-react";
import { knownProperty, knownView, viewColumns } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SPACE_TITLE_PROPERTY_ID,
  SpaceBlockId,
  SpaceViewId,
  type SpaceCellValue,
  type SpaceDataSource,
  type SpaceDatabaseRowGetResult,
  type SpaceDatabaseView,
  type SpacePageId,
  type SpacePropertyId,
  type SpaceRelatedPage,
} from "@t2code/contracts/spaces";
import { PlusIcon } from "lucide-react";
import { useContext, useLayoutEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { useEnvironment } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { AddPropertyButton } from "../controls/AddPropertyButton";
import { createDatabaseActions, type ActionsState } from "../data/actions";
import { Latest } from "../data/latest";
import { databasePorts } from "../data/ports";
import { databaseStores } from "../data/stores";
import { useDatabaseModel, type DatabaseModel } from "../data/useDatabaseModel";
import {
  DatabaseActionsContext,
  DatabaseContext,
  OpenControlContext,
  type DatabaseContextValue,
} from "../shell/context";
import { RowPropertyField } from "./RowPropertyField";
import { useRowCells } from "./useRowCells";

const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const NO_OPEN_CONTROL = [null, () => {}] as const;
const NO_BLOCK = { setViews: () => false, remove: () => false, setTitleHidden: () => false };
const ROW_VIEW_ID = SpaceViewId.make("row-page");
const ROW_BLOCK_ID = SpaceBlockId.make("row-page");

function Note({ children }: { readonly children: ReactNode }) {
  return (
    <p role="status" className="mt-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** The properties of a row page, above its body. Missing capability or a failed read leave the body alone. */
export default function RowProperties(props: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}): ReactNode {
  const capability = useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities
    .spaces;
  if (capability?.version !== 2 || capability.features?.databases !== true) return null;
  return <RowPropertiesLoader {...props} />;
}

function RowPropertiesLoader({
  environmentId,
  pageId,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}) {
  const row = useEnvironmentQuery(databasePorts.rowAtom(environmentId, pageId));
  const [kept, setKept] = useState(row.data);
  // A refetch in flight or a failed one answers with no data; the last answer stays on screen.
  if (row.data && row.data !== kept) setKept(row.data);
  const data = row.data ?? kept;
  if (data === null) {
    return row.error === null ? null : <Note>Properties are unavailable right now.</Note>;
  }
  return <RowDatabase environmentId={environmentId} pageId={pageId} data={data} />;
}

function RowDatabase({
  environmentId,
  pageId,
  data,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly data: SpaceDatabaseRowGetResult;
}) {
  const { model, error } = useDatabaseModel(environmentId, data.dataSource.databaseId);
  const dataSource = model?.dataSources.find((source) => source.id === data.dataSource.id);
  if (model === null || dataSource === undefined)
    return error === null ? null : <Note>Properties are unavailable right now.</Note>;
  return (
    <RowFields
      environmentId={environmentId}
      pageId={pageId}
      data={data}
      model={model}
      dataSource={dataSource}
    />
  );
}

const syntheticView = (model: DatabaseModel, dataSource: SpaceDataSource): SpaceDatabaseView => ({
  id: ROW_VIEW_ID,
  databaseId: model.database.id,
  dataSourceId: dataSource.id,
  name: "",
  type: "table",
  position: 0,
  sorts: [],
  properties: [],
  layout: {},
});

function RowFields({
  environmentId,
  pageId,
  data,
  model,
  dataSource,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly data: SpaceDatabaseRowGetResult;
  readonly model: DatabaseModel;
  readonly dataSource: SpaceDataSource;
}) {
  const registry = useContext(RegistryContext);
  const stores = databaseStores(registry);
  const cells = useRowCells(environmentId, pageId, data);
  const [editing, setEditing] = useState<SpacePropertyId | null>(null);
  const [picked, setPicked] = useState<Readonly<Record<string, SpaceRelatedPage>>>({});
  const [wanted, setWanted] = useState<SpacePropertyId | null>(null);
  const [optionHint] = useState(
    () => (propertyId: string, optionId: string) =>
      stores.optionHints.get(`${propertyId}:${optionId}`),
  );

  // Properties added from here are shown in the first view of the data source, as in the grid.
  const openedFrom = stores.openedFrom.get(pageId);
  const view =
    model.views.find((entry) => entry.id === openedFrom && entry.dataSourceId === dataSource.id) ??
    model.views.find((entry) => entry.dataSourceId === dataSource.id) ??
    syntheticView(model, dataSource);
  const [latest] = useState(() => new Latest<ActionsState | null>(null));
  const [actions] = useState(() =>
    createDatabaseActions({
      registry,
      state: () => {
        const state = latest.get();
        if (state === null) throw new Error("Row actions used before the row page mounted");
        return state;
      },
      queueViewEdit: () => 0,
      ackViewEdit: () => {},
      dropViewEdit: () => {},
      activate: () => {},
    }),
  );
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Keep the stable actions object pointing at the latest model and view without re-creating it.
  useLayoutEffect(() => {
    latest.set({ model, dataSource, view, viewIds: [], block: NO_BLOCK, host: null, peek: null });
  });

  // The properties are edited here, never the view: its menu entries stay disabled.
  const context: DatabaseContextValue = {
    model: { ...model, permissions: { ...model.permissions, views: false, block: false } },
    dataSource,
    view,
    known: knownView(view),
    columns: viewColumns(view, dataSource),
    layout: "page",
    blockId: ROW_BLOCK_ID,
    optionHint,
  };

  const properties = Object.values(dataSource.properties)
    .filter((property) => property.id !== SPACE_TITLE_PROPERTY_ID && property.type !== "title")
    .sort((a, b) => a.position - b.position);
  const canEdit = model.permissions.cells;

  const stop = (id: SpacePropertyId, focus: boolean) => {
    if (focus) setWanted(id);
    setEditing(null);
  };
  const write = (id: SpacePropertyId, value: SpaceCellValue | null) => {
    const previous = cells[id] ?? null;
    if (JSON.stringify(previous) !== JSON.stringify(value)) actions.editCell(pageId, id, value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.rowField === undefined) return;
    const fields = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-row-field]"),
    );
    const next = fields[fields.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <DatabaseActionsContext.Provider value={actions}>
      <OpenControlContext.Provider value={NO_OPEN_CONTROL}>
        <DatabaseContext.Provider value={context}>
          <section aria-label="Row properties" className="mt-4 space-y-0.5 border-b pb-3 text-sm">
            {data.template ? (
              <p
                role="status"
                className="mb-2 rounded-md bg-accent/50 px-2 py-1 text-xs text-muted-foreground"
              >
                You're editing a template for {model.database.title.trim() || "this database"}
              </p>
            ) : null}
            <div role="list" className="space-y-0.5" onKeyDown={onKeyDown}>
              {properties.map((property) => {
                const known = knownProperty(property);
                return (
                  <RowPropertyField
                    key={property.id}
                    pageId={pageId}
                    property={property}
                    known={known}
                    value={cells[property.id]}
                    relatedPages={{ ...data.relatedPages, ...picked }}
                    onPicked={(pages) => setPicked((current) => ({ ...current, ...pages }))}
                    environmentId={environmentId}
                    optionHint={optionHint}
                    timeZone={VIEWER_ZONE}
                    editable={canEdit}
                    canEditSchema={model.permissions.schema}
                    editing={editing === property.id}
                    wantFocus={wanted === property.id}
                    onFocused={() => setWanted(null)}
                    onEdit={() => setEditing(property.id)}
                    onToggle={() => write(property.id, cells[property.id] === true ? null : true)}
                    onCommit={(value, reason) => {
                      write(property.id, value);
                      stop(property.id, reason !== "blur");
                    }}
                    onChange={(value) => write(property.id, value)}
                    onClose={() => stop(property.id, true)}
                  />
                );
              })}
            </div>
            {model.permissions.schema ? (
              <AddPropertyButton
                render={
                  <Button variant="ghost" size="xs">
                    <PlusIcon />
                    Add a property
                  </Button>
                }
              />
            ) : null}
          </section>
        </DatabaseContext.Provider>
      </OpenControlContext.Provider>
    </DatabaseActionsContext.Provider>
  );
}
