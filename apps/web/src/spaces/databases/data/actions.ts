import {
  datePropertyCandidates,
  defaultViewDraft,
  planSubItems,
  knownProperty,
  knownView,
  layoutForTypeChange,
  needsDateProperty,
  templateForNewRow,
  type ViewPatch,
} from "@t2code/client-runtime/spaces";
import {
  SpaceOptionId,
  SpacePropertyId,
  type SpaceCellValue,
  type SpaceDataSource,
  type SpaceDatabaseRow,
  type SpaceDatabaseView,
  type SpaceDataSourceId,
  type SpacePageId,
  type SpacePropertyDraft,
  type SpaceSchemaOperation,
  type SpaceSchemaUpdateResult,
  type SpaceStatusGroup,
  type SpaceViewId,
  type SpaceViewType,
} from "@t2code/contracts/spaces";
import type { AtomRegistry } from "effect/reactivity";

import { toastManager } from "../../../components/ui/toast";
import { randomUUID } from "../../../lib/utils";
import type { DatabaseBlockActions } from "../blocks/actions";
import type { DatabaseBlockHost } from "../blocks/DatabaseBlockHost";
import { nextOptionColor } from "../primitives/colors";
import { databaseErrorMessage } from "@t2code/client-runtime/spaces";
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
    /** Absent: the data source's default template; null: a blank page. */
    templateId?: SpacePageId | null;
  }): Promise<SpaceDatabaseRow | null>;
  /** A row in another data source (the relation picker's "Create ..."), as a plain titled page. */
  createRelatedRow(
    dataSourceId: SpaceDataSourceId,
    title: string,
  ): Promise<{ readonly pageId: SpacePageId; readonly title: string } | null>;
  createTemplate(): Promise<SpacePageId | null>;
  setDefaultTemplate(pageId: SpacePageId | null): Promise<void>;
  deleteTemplate(pageId: SpacePageId): Promise<void>;
  setSubItems(on: boolean): Promise<void>;
  /** A relation property; two-way allocates both ids and names the twin on the target. */
  addRelation(input: {
    readonly name: string;
    readonly target: SpaceDataSourceId;
    readonly limit: "one" | "many";
    readonly twin: { readonly name: string } | null;
    readonly beforePropertyId?: SpacePropertyId | null;
  }): Promise<SpacePropertyId | null>;
  moveRows(pageIds: ReadonlyArray<SpacePageId>, beforeRowId: SpacePageId | null): Promise<boolean>;
  trashRow(pageId: SpacePageId): Promise<boolean>;
  updateSchema(
    operations: ReadonlyArray<SpaceSchemaOperation>,
    dataSourceId?: SpaceDataSourceId,
    /** Takes over a failure: no toast is shown, the caller reports it. */
    options?: { readonly onFailure?: (failure: unknown) => void },
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
  createView(type: SpaceViewType, dataSourceId?: SpaceDataSourceId): Promise<void>;
  duplicateView(viewId: SpaceViewId): Promise<void>;
  renameView(viewId: SpaceViewId, name: string): void;
  changeViewType(viewId: SpaceViewId, type: SpaceViewType): Promise<void>;
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

const DATE_PROPERTY_NAME = "Date";
const newPropertyId = () => randomUUID().replaceAll("-", "").slice(0, 6);

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

  const refreshModel = () => {
    const { model } = deps.state();
    const counter = databasePorts.changed.database(model.environmentId, model.database.id);
    registry.set(counter, registry.get(counter) + 1);
  };

  const track = <T extends { dataRevision: number }>(structural: boolean, run: () => Promise<T>) =>
    writer().track(deps.state().dataSource.id, { structural }, run);

  /** The date property a calendar or timeline needs; adds a `Date` property when there is none. */
  const dateProperty = async (dataSource: SpaceDataSource): Promise<SpacePropertyId | null> => {
    const existing = datePropertyCandidates(dataSource)[0]?.id;
    if (existing !== undefined) return existing;
    const id = SpacePropertyId.make(newPropertyId());
    const added = await actions.updateSchema(
      [{ op: "addProperty", property: { id, name: DATE_PROPERTY_NAME, type: "date" } }],
      dataSource.id,
    );
    return added === null ? null : id;
  };

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
        const templateId = templateForNewRow(dataSource, input.templateId);
        const result = await track(true, () =>
          databasePorts.run.createRows(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            rows: [
              {
                ...(typeof title === "string" ? { title } : {}),
                ...(Object.keys(cells).length > 0 ? { cells } : {}),
                ...(templateId === undefined ? {} : { templateId }),
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
    createRelatedRow: async (dataSourceId, title) => {
      const { model } = deps.state();
      try {
        const result = await writer().track(dataSourceId, { structural: true }, () =>
          databasePorts.run.createRows(registry, model.environmentId, {
            dataSourceId,
            rows: [{ title }],
          }),
        );
        const created = result.rows[0];
        return created === undefined ? null : { pageId: created.pageId, title };
      } catch (failure) {
        fail("Couldn't add the page", failure);
        return null;
      }
    },
    createTemplate: async () => {
      const { model, dataSource } = deps.state();
      try {
        const result = await track(true, () =>
          databasePorts.run.createRows(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            rows: [{ asTemplate: true }],
          }),
        );
        refreshModel();
        return result.rows[0]?.pageId ?? null;
      } catch (failure) {
        fail("Couldn't add the template", failure);
        return null;
      }
    },
    setDefaultTemplate: async (pageId) => {
      const { model, dataSource } = deps.state();
      try {
        await databasePorts.run.updateDataSource(registry, model.environmentId, {
          dataSourceId: dataSource.id,
          defaultTemplateId: pageId,
        });
        refreshModel();
      } catch (failure) {
        fail("Couldn't change the default template", failure);
      }
    },
    deleteTemplate: async (pageId) => {
      const { model, dataSource } = deps.state();
      try {
        if (dataSource.defaultTemplateId === pageId)
          await databasePorts.run.updateDataSource(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            defaultTemplateId: null,
          });
        await databasePorts.trashRow(registry, model.environmentId, pageId, dataSource.id);
        refreshModel();
      } catch (failure) {
        fail("Couldn't delete the template", failure);
      }
    },
    setSubItems: async (on) => {
      const { model, dataSource } = deps.state();
      try {
        if (!on) {
          await databasePorts.run.updateDataSource(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            subItems: null,
          });
        } else {
          const existing = dataSource.subItems;
          const plan =
            existing === undefined ? planSubItems(dataSource.id, dataSource.properties) : null;
          let parentPropertyId = existing?.parentPropertyId;
          if (plan?.kind === "reuse") parentPropertyId = plan.parentPropertyId;
          else if (plan?.kind === "create") {
            const parentId = SpacePropertyId.make(newPropertyId());
            const childId = SpacePropertyId.make(newPropertyId());
            const added = await actions.updateSchema([
              {
                op: "addProperty",
                property: {
                  id: parentId,
                  name: plan.parentName,
                  type: "relation",
                  config: {
                    dataSourceId: dataSource.id,
                    limit: "one",
                    twoWay: { propertyId: childId },
                  },
                },
              },
              { op: "updateProperty", propertyId: childId, name: plan.childName },
            ]);
            if (added === null) return;
            parentPropertyId = parentId;
          }
          if (parentPropertyId === undefined) return;
          await databasePorts.run.updateDataSource(registry, model.environmentId, {
            dataSourceId: dataSource.id,
            subItems: { parentPropertyId },
          });
        }
        refreshModel();
      } catch (failure) {
        fail("Couldn't change sub-items", failure);
      }
    },
    addRelation: async ({ name, target, limit, twin, beforePropertyId }) => {
      const { dataSource } = deps.state();
      const id = SpacePropertyId.make(newPropertyId());
      const twinId = twin === null ? null : SpacePropertyId.make(newPropertyId());
      const result = await actions.updateSchema([
        {
          op: "addProperty",
          property: {
            id,
            name,
            type: "relation",
            config: {
              dataSourceId: target,
              limit,
              ...(twinId === null ? {} : { twoWay: { propertyId: twinId } }),
            },
          },
          ...(beforePropertyId === undefined ? {} : { beforePropertyId }),
        },
      ]);
      if (result === null) return null;
      actions.editView({ properties: { set: { [id]: { visible: true } } } });
      if (twinId !== null && twin !== null && twin.name.trim() !== "") {
        const sourceName = dataSource.name;
        if (twin.name.trim() !== sourceName)
          await databasePorts.run
            .updateSchema(registry, deps.state().model.environmentId, {
              dataSourceId: target,
              operations: [{ op: "updateProperty", propertyId: twinId, name: twin.name.trim() }],
            })
            .catch((failure: unknown) => fail("Couldn't name the related property", failure));
      }
      refreshModel();
      return id;
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
    updateSchema: async (operations, dataSourceId, options) => {
      const { model, dataSource } = deps.state();
      const targetId = dataSourceId ?? dataSource.id;
      try {
        return await writer().track(targetId, { structural: true }, () =>
          databasePorts.run.updateSchema(registry, model.environmentId, {
            dataSourceId: targetId,
            operations: [...operations],
          }),
        );
      } catch (failure) {
        if (options?.onFailure === undefined) fail("Couldn't change the properties", failure);
        else options.onFailure(failure);
        return null;
      }
    },
    addProperty: async (draft, beforePropertyId) => {
      const id = SpacePropertyId.make(newPropertyId());
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
      const id = SpaceOptionId.make(newPropertyId());
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
    createView: async (type, dataSourceId) => {
      const state = deps.state();
      const { model, viewIds, block } = state;
      const dataSource =
        model.dataSources.find((source) => source.id === dataSourceId) ?? state.dataSource;
      try {
        const dateId = needsDateProperty(type) ? await dateProperty(dataSource) : undefined;
        if (dateId === null) return;
        const draft = defaultViewDraft(type, dataSource, dateId);
        const properties = Object.values(dataSource.properties)
          .sort((a, b) => a.position - b.position)
          .map((property) => ({ propertyId: property.id, visible: true }));
        const result = await databasePorts.run.createView(registry, model.environmentId, {
          dataSourceId: dataSource.id,
          name: draft.name,
          type,
          properties:
            dateId === undefined || properties.some((entry) => entry.propertyId === dateId)
              ? properties
              : [...properties, { propertyId: dateId, visible: true }],
          layout: draft.layout,
          ...(draft.group === undefined ? {} : { group: draft.group }),
        });
        if (!block.setViews([...viewIds, result.viewId]))
          toastManager.add({ type: "error", title: "Couldn't add the view to this page" });
        deps.activate(result.viewId);
      } catch (failure) {
        fail("Couldn't add the view", failure);
      }
    },
    duplicateView: async (viewId) => {
      const { model, viewIds, block } = deps.state();
      const source = model.views.find((view) => view.id === viewId);
      const known = source === undefined ? null : knownView(source);
      if (source === undefined || known === null) {
        toastManager.add({ type: "error", title: "This view can't be duplicated here" });
        return;
      }
      try {
        const result = await databasePorts.run.createView(registry, model.environmentId, {
          dataSourceId: source.dataSourceId,
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
    changeViewType: async (viewId, type) => {
      const { model } = deps.state();
      const current = model.views.find((view) => view.id === viewId);
      if (current === undefined || current.type === type) return;
      const dataSource =
        model.dataSources.find((source) => source.id === current.dataSourceId) ??
        deps.state().dataSource;
      const dateId = needsDateProperty(type) ? await dateProperty(dataSource) : undefined;
      if (dateId === null) return;
      sendViewEdit(viewId, {
        type,
        layout: layoutForTypeChange(type, dataSource, current.layout, dateId),
      });
    },
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
      databaseStores(registry).openedFrom.set(pageId, view.id);
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
