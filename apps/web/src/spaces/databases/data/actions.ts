import { knownProperty, knownView, type ViewPatch } from "@t2code/client-runtime/spaces";
import {
  SpaceOptionId,
  SpacePropertyId,
  type SpaceCellValue,
  type SpaceDataSource,
  type SpaceDatabaseRow,
  type SpaceDatabaseView,
  type SpacePageId,
  type SpacePropertyDraft,
  type SpaceSchemaOperation,
  type SpaceSchemaUpdateResult,
  type SpaceStatusGroup,
  type SpaceViewId,
} from "@t2code/contracts/spaces";
import type { AtomRegistry } from "effect/reactivity";

import { toastManager } from "../../../components/ui/toast";
import { randomUUID } from "../../../lib/utils";
import type { DatabaseBlockActions } from "../blocks/actions";
import type { DatabaseBlockHost } from "../blocks/DatabaseBlockHost";
import { nextOptionColor } from "../primitives/colors";
import { databaseErrorMessage } from "./errors";
import { databasePorts } from "./ports";
import { databaseStores } from "./stores";
import type { DatabaseModel } from "./useDatabaseModel";

export type RowOpenMode = "side_peek" | "full_page";

export interface DatabaseActions {
  editCell(pageId: SpacePageId, propertyId: SpacePropertyId, value: SpaceCellValue | null): void;
  flushCells(): Promise<void>;
  createRow(input?: {
    cells?: Record<string, SpaceCellValue>;
    beforeRowId?: SpacePageId | null;
  }): Promise<SpaceDatabaseRow | null>;
  moveRows(pageIds: ReadonlyArray<SpacePageId>, beforeRowId: SpacePageId | null): Promise<boolean>;
  trashRow(pageId: SpacePageId): Promise<boolean>;
  updateSchema(
    operations: ReadonlyArray<SpaceSchemaOperation>,
  ): Promise<SpaceSchemaUpdateResult | null>;
  addProperty(
    draft: SpacePropertyDraft,
    beforePropertyId?: SpacePropertyId | null,
  ): Promise<SpacePropertyId | null>;
  addOption(
    propertyId: SpacePropertyId,
    name: string,
    group?: SpaceStatusGroup,
  ): Promise<SpaceOptionId | null>;
  editView(patch: ViewPatch): void;
  createView(type: "table" | "board"): Promise<void>;
  duplicateView(viewId: SpaceViewId): Promise<void>;
  renameView(viewId: SpaceViewId, name: string): void;
  changeViewType(viewId: SpaceViewId, type: "table" | "board"): void;
  deleteView(viewId: SpaceViewId): Promise<void>;
  reorderViews(viewIds: ReadonlyArray<SpaceViewId>): void;
  renameDatabase(title: string): void;
  openRow(pageId: SpacePageId, mode?: RowOpenMode): void;
}

/** What the actions read at call time; the surface refreshes it after each commit. */
export interface ActionsState {
  readonly model: DatabaseModel;
  readonly dataSource: SpaceDataSource;
  /** The effective (optimistic) active view. */
  readonly view: SpaceDatabaseView;
  readonly viewIds: ReadonlyArray<SpaceViewId>;
  readonly block: DatabaseBlockActions;
  readonly host: DatabaseBlockHost | null;
  readonly peek: ((pageId: SpacePageId) => void) | null;
}

export interface ActionsDeps {
  readonly registry: AtomRegistry.AtomRegistry;
  state(): ActionsState;
  /** Applies a view edit optimistically and returns its id. */
  queueViewEdit(viewId: SpaceViewId, patch: ViewPatch): number;
  ackViewEdit(id: number, databaseRevision: number): void;
  dropViewEdit(id: number): void;
  activate(viewId: SpaceViewId): void;
}

const fail = (title: string, failure: unknown) =>
  toastManager.add({ type: "error", title, description: databaseErrorMessage(failure) });

const groupableFirst = (dataSource: SpaceDataSource): SpacePropertyId | null => {
  const known = Object.values(dataSource.properties)
    .sort((a, b) => a.position - b.position)
    .map(knownProperty);
  return (
    known.find((property) => property?.type === "status")?.id ??
    known.find((property) => property?.type === "select")?.id ??
    null
  );
};

/** One stable object per surface: every method reads the latest state through `deps.state()`. */
export function createDatabaseActions(deps: ActionsDeps): DatabaseActions {
  const { registry } = deps;
  const writer = () => databaseStores(registry).writer(deps.state().model.environmentId);
  let viewChain: Promise<unknown> = Promise.resolve();

  const sendViewEdit = (viewId: SpaceViewId, patch: ViewPatch) => {
    const { environmentId } = deps.state().model;
    const id = deps.queueViewEdit(viewId, patch);
    viewChain = viewChain.then(async () => {
      try {
        const result = await databasePorts.run.updateView(registry, environmentId, {
          viewId,
          ...patch,
        });
        deps.ackViewEdit(id, result.revision);
      } catch (failure) {
        deps.dropViewEdit(id);
        fail("Couldn't update the view", failure);
      }
    });
  };

  const track = <T extends { dataRevision: number }>(structural: boolean, run: () => Promise<T>) =>
    writer().track(deps.state().dataSource.id, { structural }, run);

  const actions: DatabaseActions = {
    editCell: (pageId, propertyId, value) => {
      writer().editCell({ dataSourceId: deps.state().dataSource.id, pageId, propertyId, value });
    },
    flushCells: () => writer().flush(),
    createRow: async (input = {}) => {
      const { model, dataSource } = deps.state();
      try {
        await writer().flush();
        const { title, ...cells } = input.cells ?? {};
        const result = await track(true, () =>
          databasePorts.run.createRows(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            rows: [
              {
                ...(typeof title === "string" ? { title } : {}),
                ...(Object.keys(cells).length > 0 ? { cells } : {}),
              },
            ],
            ...(input.beforeRowId === undefined ? {} : { beforeRowId: input.beforeRowId }),
          }),
        );
        const created = result.rows[0];
        if (created === undefined) return null;
        const now = new Date().toISOString();
        const text = typeof title === "string" ? title : "";
        return {
          page: { id: created.pageId, title: text, revision: 1, createdAt: now, updatedAt: now },
          number: created.number,
          cells: { ...input.cells, title: text },
        };
      } catch (failure) {
        fail("Couldn't add the row", failure);
        return null;
      }
    },
    moveRows: async (pageIds, beforeRowId) => {
      const { model, dataSource } = deps.state();
      try {
        await track(true, () =>
          databasePorts.run.moveRows(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            pageIds: [...pageIds],
            beforeRowId,
          }),
        );
        return true;
      } catch (failure) {
        fail("Couldn't move the row", failure);
        return false;
      }
    },
    trashRow: async (pageId) => {
      const { model, dataSource } = deps.state();
      try {
        await track(true, async () => {
          await databasePorts.trashRow(registry, model.environmentId, pageId, dataSource.id);
          return { dataRevision: -1 };
        });
        toastManager.add({ type: "success", title: "Moved to trash" });
        return true;
      } catch (failure) {
        fail("Couldn't move the row to trash", failure);
        return false;
      }
    },
    updateSchema: async (operations) => {
      const { model, dataSource } = deps.state();
      try {
        return await track(true, () =>
          databasePorts.run.updateSchema(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            operations: [...operations],
          }),
        );
      } catch (failure) {
        fail("Couldn't change the properties", failure);
        return null;
      }
    },
    addProperty: async (draft, beforePropertyId) => {
      const id = SpacePropertyId.make(randomUUID());
      const result = await actions.updateSchema([
        {
          op: "addProperty",
          property: { ...draft, id },
          ...(beforePropertyId === undefined ? {} : { beforePropertyId }),
        },
      ]);
      if (result === null) return null;
      actions.editView({ properties: { set: { [id]: { visible: true } } } });
      return id;
    },
    addOption: async (propertyId, name, group) => {
      const { dataSource } = deps.state();
      const known = knownProperty(dataSource.properties[propertyId]!);
      const used =
        known?.type === "select" || known?.type === "multi_select" || known?.type === "status"
          ? known.config.options.map((option) => option.color)
          : [];
      const color = nextOptionColor(used);
      const id = SpaceOptionId.make(randomUUID());
      databaseStores(registry).optionHints.set(`${propertyId}:${id}`, { name, color });
      const result = await actions.updateSchema([
        {
          op: "addOption",
          propertyId,
          option: { id, name, color, ...(group === undefined ? {} : { group }) },
        },
      ]);
      return result === null ? null : id;
    },
    editView: (patch) => sendViewEdit(deps.state().view.id, patch),
    createView: async (type) => {
      const { model, dataSource, viewIds, block } = deps.state();
      try {
        const group = type === "board" ? groupableFirst(dataSource) : null;
        const properties = Object.values(dataSource.properties)
          .sort((a, b) => a.position - b.position)
          .map((property) => ({ propertyId: property.id, visible: true }));
        const result = await databasePorts.run.createView(registry, model.environmentId, {
          dataSourceId: dataSource.id,
          name: type === "board" ? "Board" : "Table",
          type,
          properties,
          ...(group === null ? {} : { group: { property: group } }),
        });
        if (!block.setViews([...viewIds, result.viewId]))
          toastManager.add({ type: "error", title: "Couldn't add the view to this page" });
        deps.activate(result.viewId);
      } catch (failure) {
        fail("Couldn't add the view", failure);
      }
    },
    duplicateView: async (viewId) => {
      const { model, dataSource, viewIds, block } = deps.state();
      const source = model.views.find((view) => view.id === viewId);
      const known = source === undefined ? null : knownView(source);
      if (source === undefined || known === null) {
        toastManager.add({ type: "error", title: "This view can't be duplicated here" });
        return;
      }
      try {
        const result = await databasePorts.run.createView(registry, model.environmentId, {
          dataSourceId: dataSource.id,
          name: `${source.name} (1)`,
          type: known.type,
          ...(known.filter === undefined ? {} : { filter: known.filter }),
          sorts: known.sorts,
          ...(known.group === undefined ? {} : { group: known.group }),
          ...(known.subGroup === undefined ? {} : { subGroup: known.subGroup }),
          properties: known.properties,
          layout: known.layout,
          beforeViewId: null,
        });
        const at = viewIds.indexOf(viewId);
        const next = [...viewIds];
        next.splice(at < 0 ? next.length : at + 1, 0, result.viewId);
        block.setViews(next);
        deps.activate(result.viewId);
      } catch (failure) {
        fail("Couldn't duplicate the view", failure);
      }
    },
    renameView: (viewId, name) => {
      const trimmed = name.trim();
      if (trimmed !== "") sendViewEdit(viewId, { name: trimmed });
    },
    changeViewType: (viewId, type) => sendViewEdit(viewId, { type }),
    deleteView: async (viewId) => {
      const { model, viewIds, block } = deps.state();
      try {
        await databasePorts.run.deleteView(registry, model.environmentId, { viewId });
        const next = viewIds.filter((id) => id !== viewId);
        block.setViews(next);
        const fallback = next[Math.max(0, viewIds.indexOf(viewId) - 1)];
        if (fallback !== undefined) deps.activate(fallback);
      } catch (failure) {
        fail("Couldn't delete the view", failure);
      }
    },
    reorderViews: (viewIds) => {
      deps.state().block.setViews(viewIds);
    },
    renameDatabase: (title) => {
      const { model } = deps.state();
      void databasePorts.run
        .update(registry, model.environmentId, { databaseId: model.database.id, title })
        .catch((failure: unknown) => fail("Couldn't rename the database", failure));
    },
    openRow: (pageId, mode) => {
      const { view, host, peek, model } = deps.state();
      const layout = view.layout as { openPagesIn?: string };
      const configured = layout.openPagesIn === "full_page" ? "full_page" : "side_peek";
      const target = mode ?? configured;
      if (peek !== null && target !== "full_page") return peek(pageId);
      host?.openPage({
        environmentId: model.environmentId,
        spaceId: model.database.spaceId,
        pageId,
      });
    },
  };
  return actions;
}
