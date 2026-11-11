import { applyViewPatch } from "@t2code/client-runtime/spaces";
import type {
  SpaceDataSource,
  SpaceDatabaseProperty,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";

import { FakeDatabase } from "./fakeDatabase";

type Json = Record<string, unknown>;
type Registry = {
  get<A>(atom: never): A;
  set(atom: never, value: number): void;
};

/** Mirrors the server's client id rule (`clientIdPattern`), so ids it would refuse fail here too. */
const SERVER_ID_PATTERN = /^[a-z0-9]{4,12}$/;

const STATUS_DEFAULTS = [
  { id: "d-todo", name: "Not started", color: "gray", group: "todo" },
  { id: "d-doing", name: "In progress", color: "blue", group: "in_progress" },
  { id: "d-done", name: "Done", color: "green", group: "complete" },
];

/** A fake that applies view patches and schema operations, so the UI can be checked after a refresh. */
export class EditableFakeDatabase extends FakeDatabase {
  /** What the next changePropertyType reports as cleared. */
  clearedCells = 0;

  override ports() {
    const base = super.ports();
    const bump = (registry: Registry, key: string) => {
      const atom = this.counter(key) as never;
      registry.set(atom, (registry.get(atom) as number) + 1);
    };
    const failIfRequested = (method: string, input: Json) => {
      this.calls.push({ method, input });
      const failure = this.failNext.get(method);
      if (failure !== undefined) {
        this.failNext.delete(method);
        throw failure;
      }
    };
    return {
      ...base,
      run: {
        ...base.run,
        updateView: async (registry: Registry, environmentId: string, input: Json) => {
          if (!this.failNext.has("updateView"))
            this.views = this.views.map((view) =>
              view.id === input.viewId ? applyViewPatch(view, input as never) : view,
            ) as SpaceDatabaseView[];
          return base.run.updateView(registry as never, environmentId, input);
        },
        updateSchema: async (registry: Registry, _environmentId: string, input: Json) => {
          failIfRequested("updateSchema", input);
          let cleared = 0;
          const otherIndex = this.others.findIndex(
            (entry) => entry.dataSource.id === input.dataSourceId,
          );
          const main = this.dataSource;
          const rowsBefore = this.rows;
          if (otherIndex >= 0) this.dataSource = this.others[otherIndex]!.dataSource;
          try {
            for (const operation of input.operations as Json[]) cleared += this.#apply(operation);
          } finally {
            if (otherIndex >= 0) {
              const edited = this.dataSource;
              this.others[otherIndex] = { ...this.others[otherIndex]!, dataSource: edited };
              this.dataSource = main;
            }
          }
          if (otherIndex < 0)
            try {
              this.recomputeFormulas();
            } catch (refusal) {
              this.dataSource = main;
              this.rows = rowsBefore;
              throw refusal;
            }
          this.dataSource = {
            ...this.dataSource,
            schemaRevision: this.dataSource.schemaRevision + 1,
          };
          bump(registry, "database");
          return {
            dataSourceId: this.dataSource.id,
            schemaRevision: this.dataSource.schemaRevision,
            dataRevision: this.dataRevision,
            created: [],
            clearedCells: cleared,
            affectedDataSourceIds: [this.dataSource.id],
          };
        },
      },
    };
  }

  /** Edits the data source a relation points at (this one, or another database's). */
  #onTarget(targetId: string, edit: (source: SpaceDataSource) => SpaceDataSource) {
    if (targetId === this.dataSource.id) {
      this.dataSource = edit(this.dataSource);
      return;
    }
    this.others = this.others.map((entry) =>
      entry.dataSource.id === targetId ? { ...entry, dataSource: edit(entry.dataSource) } : entry,
    );
  }

  #addTwin(ownerPropertyId: string, config: Json) {
    const twoWay = config.twoWay as { propertyId: string } | undefined;
    if (twoWay === undefined) return;
    const sourceId = this.dataSource.id;
    const sourceName = this.dataSource.name;
    this.#onTarget(String(config.dataSourceId), (target) => ({
      ...target,
      properties: {
        ...target.properties,
        [twoWay.propertyId]: {
          id: twoWay.propertyId,
          name: sourceName,
          type: "relation",
          config: {
            dataSourceId: sourceId,
            limit: "many",
            twoWay: { propertyId: ownerPropertyId },
          },
          position: Object.keys(target.properties).length,
        } as never,
      },
    }));
  }

  #syncTwin(property: SpaceDatabaseProperty, next: Json) {
    const before = (property.config as { twoWay?: { propertyId: string } }).twoWay?.propertyId;
    const after = (next.twoWay as { propertyId: string } | undefined)?.propertyId;
    const targetId = String((property.config as Json).dataSourceId);
    if (before !== undefined && after === undefined)
      this.#onTarget(targetId, (target) => {
        const { [before]: _gone, ...rest } = target.properties;
        return { ...target, properties: rest };
      });
    else if (before === undefined && after !== undefined)
      this.#addTwin(property.id, { ...next, dataSourceId: targetId });
  }

  #property(id: unknown) {
    const property = this.dataSource.properties[String(id)];
    if (property === undefined) throw { _tag: "SpaceNotFoundError", entity: "property" };
    return property;
  }

  #put(property: SpaceDatabaseProperty) {
    this.dataSource = {
      ...this.dataSource,
      properties: { ...this.dataSource.properties, [property.id]: property },
    };
  }

  #options(property: SpaceDatabaseProperty): Json[] {
    return [...(((property.config as Json).options as Json[] | undefined) ?? [])];
  }

  #withOptions(property: SpaceDatabaseProperty, options: Json[], extra: Json = {}) {
    this.#put({
      ...property,
      config: { ...(property.config as Json), ...extra, options },
    } as SpaceDatabaseProperty);
  }

  #apply(operation: Json): number {
    switch (operation.op) {
      case "addProperty": {
        const draft = operation.property as Json;
        if (!SERVER_ID_PATTERN.test(String(draft.id)))
          throw { _tag: "SpaceDatabaseError", reason: "invalid_property_config" };
        const taken = Object.values(this.dataSource.properties).some(
          (property) => property.name.toLowerCase() === String(draft.name).toLowerCase(),
        );
        if (taken) throw { _tag: "SpaceDatabaseError", reason: "duplicate_name" };
        const config: Json = { ...(draft.config as Json | undefined) };
        if (draft.type === "status")
          Object.assign(config, { options: STATUS_DEFAULTS, defaultOptionId: "d-todo" });
        if (draft.type === "select" || draft.type === "multi_select") config.options = [];
        this.#put({
          id: draft.id,
          name: draft.name,
          type: draft.type,
          config,
          position: Object.keys(this.dataSource.properties).length,
        } as never);
        if (draft.type === "relation") this.#addTwin(String(draft.id), config);
        return 0;
      }
      case "updateProperty": {
        const property = this.#property(operation.propertyId);
        const taken = Object.values(this.dataSource.properties).some(
          (other) =>
            other.id !== property.id &&
            typeof operation.name === "string" &&
            other.name.toLowerCase() === operation.name.toLowerCase(),
        );
        if (taken) throw { _tag: "SpaceDatabaseError", reason: "duplicate_name" };
        const options = (property.config as Json).options;
        if (property.type === "relation" && operation.config !== undefined)
          this.#syncTwin(property, operation.config as Json);
        this.#put({
          ...property,
          ...(typeof operation.name === "string" ? { name: operation.name } : {}),
          ...(operation.config === undefined
            ? {}
            : {
                config: {
                  ...(operation.config as Json),
                  ...(options === undefined ? {} : { options }),
                },
              }),
        } as SpaceDatabaseProperty);
        return 0;
      }
      case "changePropertyType": {
        const property = this.#property(operation.propertyId);
        this.#put({
          ...property,
          type: operation.type,
          config:
            operation.type === "status"
              ? { options: STATUS_DEFAULTS, defaultOptionId: "d-todo" }
              : ((operation.config as Json | undefined) ?? {}),
        } as SpaceDatabaseProperty);
        return this.clearedCells;
      }
      case "removeProperty": {
        const property = this.#property(operation.propertyId);
        const { [property.id]: _removed, ...rest } = this.dataSource.properties;
        this.dataSource = {
          ...this.dataSource,
          properties: rest,
          deletedProperties: [
            ...this.dataSource.deletedProperties,
            { id: property.id, name: property.name, type: property.type, deletedAt: "t" },
          ],
        } as never;
        return 0;
      }
      case "restoreProperty": {
        const gone = this.dataSource.deletedProperties.find(
          (property) => property.id === operation.propertyId,
        );
        if (gone === undefined) throw { _tag: "SpaceNotFoundError", entity: "property" };
        this.dataSource = {
          ...this.dataSource,
          deletedProperties: this.dataSource.deletedProperties.filter(
            (property) => property.id !== gone.id,
          ),
          properties: {
            ...this.dataSource.properties,
            [gone.id]: {
              id: gone.id,
              name: gone.name,
              type: gone.type,
              config: {},
              position: Object.keys(this.dataSource.properties).length,
            } as never,
          },
        };
        return 0;
      }
      case "addOption": {
        const property = this.#property(operation.propertyId);
        const draft = operation.option as Json;
        if (!SERVER_ID_PATTERN.test(String(draft.id)))
          throw { _tag: "SpaceDatabaseError", reason: "invalid_property_config" };
        const options = this.#options(property);
        if (
          options.some(
            (option) => String(option.name).toLowerCase() === String(draft.name).toLowerCase(),
          )
        )
          throw { _tag: "SpaceDatabaseError", reason: "duplicate_name" };
        this.#withOptions(property, [
          ...options,
          {
            ...draft,
            color: draft.color ?? "default",
            ...(property.type === "status" ? { group: draft.group ?? "todo" } : {}),
          },
        ]);
        return 0;
      }
      case "updateOption": {
        const property = this.#property(operation.propertyId);
        const { op: _op, propertyId: _id, optionId, ...patch } = operation;
        this.#withOptions(
          property,
          this.#options(property).map((option) =>
            option.id === optionId ? { ...option, ...patch } : option,
          ),
        );
        return 0;
      }
      case "moveOption": {
        const property = this.#property(operation.propertyId);
        const options = this.#options(property);
        const moved = options.find((option) => option.id === operation.optionId)!;
        const rest = options.filter((option) => option !== moved);
        const at = rest.findIndex((option) => option.id === operation.beforeOptionId);
        rest.splice(at < 0 ? rest.length : at, 0, moved);
        this.#withOptions(property, rest);
        return 0;
      }
      case "removeOption": {
        const property = this.#property(operation.propertyId);
        const options = this.#options(property);
        if (options.length <= 1) throw { _tag: "SpaceDatabaseError", reason: "last_option" };
        this.#withOptions(
          property,
          options.filter((option) => option.id !== operation.optionId),
        );
        return 0;
      }
      default:
        return 0;
    }
  }
}
