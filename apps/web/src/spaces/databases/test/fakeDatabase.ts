import { applyViewPatch, type ViewPatch } from "@t2code/client-runtime/spaces";
import { AsyncResult, Atom } from "effect/reactivity";
import type {
  SpaceDataSource,
  SpaceDatabase,
  SpaceDatabaseQueryInput,
  SpaceDatabaseQueryResult,
  SpaceDatabaseRow,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";

import { computeFormulas } from "./fakeComputed";
import { matchesFilter, sortRows } from "./fakeFilter";
import {
  FIXTURE_IDS,
  fixtureDataSource,
  fixtureDatabase,
  fixtureRows,
  fixtureView,
} from "./fixtures";

type AnyRegistry = {
  get<A>(atom: Atom.Atom<A>): A;
  set<A>(atom: Atom.Writable<A, A>, value: A): void;
};
type Json = Record<string, unknown>;

export interface FakeOtherDatabase {
  readonly database: SpaceDatabase;
  readonly dataSource: SpaceDataSource;
  readonly rows: SpaceDatabaseRow[];
  readonly views?: ReadonlyArray<SpaceDatabaseView>;
}

export interface FakeCall {
  readonly method: string;
  readonly input: Json;
}

export interface FakeDatabaseOptions {
  readonly rows?: number;
  /** Replaces the fixture schema; keep its id so row atoms and counters still line up. */
  readonly dataSource?: SpaceDataSource;
  /** Replaces the generated rows. */
  readonly rowData?: ReadonlyArray<SpaceDatabaseRow>;
  readonly views?: ReadonlyArray<SpaceDatabaseView>;
  /** Other databases of the same space: relation targets and linked-view sources. */
  readonly others?: ReadonlyArray<FakeOtherDatabase>;
  /** Databases per page of `listAtom`; the rest come through `listPage`. */
  readonly listLimit?: number;
  readonly live?: boolean;
  /** The next this many queries answer `computedPending: true`. */
  readonly computedPending?: number;
  /** Row writes leave the database counter alone, as the production commands do. */
  readonly quietRowWrites?: boolean;
  readonly permissions?: Partial<
    Record<"cells" | "rows" | "schema" | "views" | "create" | "rename", boolean>
  >;
}

const admission = {
  epoch: "epoch-1",
  acceptsUntil: "2099-01-01T00:00:00.000Z",
  retainUntil: "2099-02-01T00:00:00.000Z",
};

/**
 * An in-memory stand-in for `data/ports.ts`: real cursor paging, option grouping, search by
 * title, writable counters that refresh the atoms, and a call log. Browser tests mock the ports
 * module with `fakePortsModule`.
 */
export class FakeDatabase {
  readonly calls: FakeCall[] = [];
  database: SpaceDatabase;
  dataSource: SpaceDataSource = fixtureDataSource();
  views: SpaceDatabaseView[];
  rows: SpaceDatabaseRow[];
  others: FakeOtherDatabase[];
  /** Template pages of the main data source, kept out of queries as the server does. */
  readonly templateRows = new Map<string, SpaceDatabaseRow>();
  readonly #listLimit: number;
  dataRevision = 1;
  revision = 1;
  /** Queries left that still report `computedPending`. */
  computedPendingLeft: number;
  /** Fails the next call of a method once, with this value. */
  readonly failNext = new Map<string, unknown>();
  readonly permissions: Record<
    "cells" | "rows" | "schema" | "views" | "create" | "rename",
    boolean
  >;
  readonly #quietRowWrites: boolean;
  #nextId = 1;
  readonly #counters = new Map<string, Atom.Writable<number, number>>();
  readonly #permissionAtoms = new Map<string, Atom.Atom<boolean>>();
  readonly #databaseAtom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

  constructor(options: FakeDatabaseOptions = {}) {
    this.#quietRowWrites = options.quietRowWrites ?? false;
    this.computedPendingLeft = options.computedPending ?? 0;
    this.others = [...(options.others ?? [])];
    this.#listLimit = options.listLimit ?? 100;
    this.database = fixtureDatabase(options.live ?? true);
    this.views = [
      ...(options.views ?? [
        fixtureView(FIXTURE_IDS.tableView, "table", "Table", 0),
        fixtureView(FIXTURE_IDS.boardView, "board", "Board", 1),
      ]),
    ];
    if (options.dataSource !== undefined) this.dataSource = options.dataSource;
    this.rows =
      options.rowData === undefined ? fixtureRows(options.rows ?? 0) : [...options.rowData];
    this.permissions = {
      cells: true,
      rows: true,
      schema: true,
      views: true,
      create: true,
      rename: true,
      ...options.permissions,
    };
    const counter = this.counter("database");
    this.#databaseAtom = Atom.make((get) => {
      get(counter);
      return AsyncResult.success({
        database: { ...this.database, revision: this.revision },
        dataSources: [this.dataSource],
        views: [...this.views],
        mutationAdmission: admission,
      });
    });
  }

  readonly #otherAtoms = new Map<string, Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>();
  /** The model atom of a database: the main one, or another database of the space. */
  #modelAtom(databaseId: string) {
    const other = this.others.find((entry) => entry.database.id === databaseId);
    if (other === undefined) return this.#databaseAtom;
    let atom = this.#otherAtoms.get(databaseId);
    if (atom === undefined) {
      atom = Atom.make((get) => {
        get(this.counter(`database:${databaseId}`));
        return AsyncResult.success({
          database: other.database,
          dataSources: [other.dataSource],
          views: [...(other.views ?? [])],
          mutationAdmission: admission,
        });
      });
      this.#otherAtoms.set(databaseId, atom);
    }
    return atom;
  }

  #listItems() {
    return [
      {
        database: { ...this.database, revision: this.revision },
        dataSources: [{ id: this.dataSource.id, name: this.dataSource.name }],
      },
      ...this.others.map((entry) => ({
        database: entry.database,
        dataSources: [{ id: entry.dataSource.id, name: entry.dataSource.name }],
      })),
    ];
  }

  #listResult(from: number) {
    const items = this.#listItems();
    const page = items.slice(from, from + this.#listLimit);
    return {
      items: page,
      nextCursor: from + this.#listLimit < items.length ? String(from + this.#listLimit) : null,
      mutationAdmission: admission,
    };
  }

  #listAtomValue: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>> | null = null;
  #listAtom() {
    this.#listAtomValue ??= Atom.make((get) => {
      get(this.counter("database"));
      return AsyncResult.success(this.#listResult(0));
    });
    return this.#listAtomValue;
  }

  /** Rows and schema of any data source of the fake. */
  sourceOf(dataSourceId: string): { dataSource: SpaceDataSource; rows: SpaceDatabaseRow[] } {
    const other = this.others.find((entry) => entry.dataSource.id === dataSourceId);
    return other === undefined
      ? { dataSource: this.dataSource, rows: this.rows }
      : { dataSource: other.dataSource, rows: other.rows };
  }

  /** `relatedPages` of an answer: every page a relation cell of the rows points at. */
  #relatedOf(
    source: SpaceDataSource,
    rows: ReadonlyArray<SpaceDatabaseRow>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const property of Object.values(source.properties)) {
      if (property.type !== "relation") continue;
      const targetId = (property.config as { dataSourceId?: string }).dataSourceId ?? "";
      const target = this.sourceOf(targetId);
      for (const row of rows) {
        const value = row.cells[property.id];
        if (!Array.isArray(value)) continue;
        for (const id of value as string[]) {
          const page = target.rows.find((entry) => entry.page.id === id);
          if (page !== undefined)
            out[id] = {
              title: page.page.title,
              ...(page.page.icon === undefined ? {} : { icon: page.page.icon }),
              dataSourceId: targetId,
            };
        }
      }
    }
    return out;
  }

  /** Rows moved to trash, by page id, for `restoreRow`. */
  readonly trashed = new Map<string, SpaceDatabaseRow>();
  readonly #rowAtoms = new Map<string, Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>();

  /** One atom per row page, refreshed by row and data source writes as the production row query is. */
  #rowAtom(pageId: string) {
    let atom = this.#rowAtoms.get(pageId);
    if (atom === undefined) {
      atom = Atom.make((get) => {
        get(this.counter(`row:${pageId}`));
        get(this.counter(`dataSource:${FIXTURE_IDS.dataSource}`));
        const template = this.templateRows.get(pageId);
        const row = template ?? this.rows.find((entry) => entry.page.id === pageId);
        if (row === undefined) return AsyncResult.fail(new Error("The row is gone"));
        return AsyncResult.success({
          row,
          template: template !== undefined,
          dataSource: {
            id: FIXTURE_IDS.dataSource,
            databaseId: FIXTURE_IDS.database,
            schemaRevision: 1,
            dataRevision: this.dataRevision,
          },
          relatedPages: {},
          mutationAdmission: admission,
        });
      });
      this.#rowAtoms.set(pageId, atom);
    }
    return atom;
  }

  counter(key: string): Atom.Writable<number, number> {
    let atom = this.#counters.get(key);
    if (atom === undefined) {
      atom = Atom.make(0);
      this.#counters.set(key, atom);
    }
    return atom;
  }

  #bump(registry: AnyRegistry, key: string) {
    const atom = this.counter(key);
    registry.set(atom, registry.get(atom) + 1);
  }

  #log(method: string, input: Json) {
    this.calls.push({ method, input });
    const failure = this.failNext.get(method);
    if (failure !== undefined) {
      this.failNext.delete(method);
      throw failure;
    }
  }

  /** Puts a trashed row back, as restoring its page does, and refreshes what reads it. */
  restoreRow(registry: AnyRegistry, pageId: string) {
    const row = this.trashed.get(pageId);
    if (row === undefined) return;
    this.trashed.delete(pageId);
    this.rows = [row, ...this.rows];
    this.#bump(registry, `row:${pageId}`);
    this.#bump(registry, `dataSource:${FIXTURE_IDS.dataSource}`);
  }

  /** Brings formula values and `computed` info up to date; throws the refusal of a bad formula. */
  recomputeFormulas() {
    const lookup = (id: string) => this.sourceOf(id).dataSource;
    const result = computeFormulas(this.dataSource, this.rows, lookup, Date.UTC(2026, 0, 1));
    this.dataSource = result.dataSource;
    this.rows = result.rows;
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Created and edited times are not stored cells: the server adds them when they are requested. */
  #withVirtualCells(row: SpaceDatabaseRow, requested: ReadonlyArray<string> | undefined) {
    const extra: Json = {};
    for (const id of requested ?? []) {
      const type = (this.dataSource.properties[id] as { type?: string } | undefined)?.type;
      if (type === "created_time") extra[id] = row.page.createdAt;
      else if (type === "last_edited_time") extra[id] = row.page.updatedAt;
    }
    return Object.keys(extra).length === 0
      ? row
      : ({ ...row, cells: { ...row.cells, ...extra } } as SpaceDatabaseRow);
  }

  #matching(input: SpaceDatabaseQueryInput): SpaceDatabaseRow[] {
    const { dataSource, rows: all } = this.sourceOf(input.dataSourceId);
    const search = input.search?.toLowerCase();
    const parentProperty = dataSource.subItems?.parentPropertyId;
    const parent = input.scope?.parentRowId;
    const matching = all.filter((row) => {
      if (parent !== undefined && parentProperty !== undefined) {
        const value = row.cells[parentProperty];
        const parents = Array.isArray(value) ? (value as string[]) : [];
        if (parent === null ? parents.length > 0 : !parents.includes(parent)) return false;
      }
      return (
        (search === undefined ||
          String(row.cells.title ?? "")
            .toLowerCase()
            .includes(search)) &&
        matchesFilter(row, input.filter, dataSource) &&
        matchesFilter(row, input.extraFilter, dataSource)
      );
    });
    const withCounts = matching.map((row) => {
      if (parent === undefined || dataSource.subItems === undefined) return row;
      const childProperty = dataSource.subItems.childrenPropertyId;
      const children = row.cells[childProperty];
      const own = all.filter((entry) => {
        const value = entry.cells[dataSource.subItems!.parentPropertyId];
        return Array.isArray(value) && (value as string[]).includes(row.page.id);
      }).length;
      return { ...row, childCount: Array.isArray(children) ? children.length : own };
    });
    return sortRows(withCounts, input.sorts, dataSource).map((row) =>
      this.#withVirtualCells(row, input.properties),
    );
  }

  #buckets(
    rows: ReadonlyArray<SpaceDatabaseRow>,
    input: SpaceDatabaseQueryInput,
    group: { property: string },
    per: number,
    dataSource: SpaceDataSource,
  ) {
    const optionsOf = (property: string) =>
      (dataSource.properties[property]?.config as { options?: { id: string }[] })?.options ?? [];
    const keysOf = (property: string) => [
      ...optionsOf(property).map((option): { kind: string; optionId?: string } => ({
        kind: "option",
        optionId: option.id,
      })),
      { kind: "empty" } as { kind: string; optionId?: string },
    ];
    const inKey = (
      row: SpaceDatabaseRow,
      property: string,
      key: { kind: string; optionId?: string },
    ) => {
      const value = row.cells[property];
      return key.kind === "empty" ? value == null : value === key.optionId;
    };
    const aggregatesOf = (inBucket: ReadonlyArray<SpaceDatabaseRow>) =>
      input.include?.aggregates
        ? {
            aggregates: (input.aggregates ?? []).map((aggregate) => ({
              property: aggregate.property,
              function: aggregate.function,
              number: inBucket.length,
            })),
          }
        : {};
    const bucketOf = (inBucket: ReadonlyArray<SpaceDatabaseRow>, key: object) => ({
      key,
      count: inBucket.length,
      ...aggregatesOf(inBucket),
      rows: inBucket.slice(0, per),
      nextCursor: inBucket.length > per ? String(per) : null,
    });
    return keysOf(group.property).map((key) => {
      const inBucket = rows.filter((row) => inKey(row, group.property, key));
      const sub = input.subGroup?.property;
      return {
        ...bucketOf(inBucket, key),
        ...(sub === undefined
          ? {}
          : {
              subGroups: keysOf(sub).map((subKey) =>
                bucketOf(
                  inBucket.filter((row) => inKey(row, sub, subKey)),
                  subKey,
                ),
              ),
            }),
      };
    });
  }

  async query(
    _registry: AnyRegistry,
    input: SpaceDatabaseQueryInput,
  ): Promise<SpaceDatabaseQueryResult> {
    this.#log("query", input as unknown as Json);
    const limit = input.limit ?? 50;
    const rows = this.#matching(input);
    const { dataSource } = this.sourceOf(input.dataSourceId);
    const base = {
      dataSourceId: input.dataSourceId,
      schemaRevision: 1,
      dataRevision: this.dataRevision,
      relatedPages: this.#relatedOf(dataSource, rows),
      ...(this.computedPendingLeft > 0 ? { computedPending: this.computedPendingLeft-- > 0 } : {}),
      ...(input.include?.total ? { total: rows.length } : {}),
      ...(input.include?.aggregates
        ? {
            aggregates: (input.aggregates ?? []).map((aggregate) => ({
              property: aggregate.property,
              function: aggregate.function,
              number: rows.length,
            })),
          }
        : {}),
    };
    if (input.mode === "groups" && input.group) {
      const buckets = this.#buckets(rows, input, input.group, input.rowsPerGroup ?? 0, dataSource);
      return {
        ...base,
        rows: [],
        groups: buckets,
        nextCursor: null,
      } as unknown as SpaceDatabaseQueryResult;
    }
    let pool = rows;
    const scope = input.scope?.group as { optionId?: string; kind: string } | undefined;
    if (scope && input.group) {
      pool = rows.filter((row) => {
        const value = row.cells[input.group!.property];
        return scope.kind === "empty" ? value == null : value === scope.optionId;
      });
    }
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const page = pool.slice(start, start + limit);
    return {
      ...base,
      rows: page,
      nextCursor: start + limit < pool.length ? String(start + limit) : null,
    } as unknown as SpaceDatabaseQueryResult;
  }

  ports() {
    const run =
      (method: string, apply: (input: Json) => unknown, bump: "database" | "dataSource") =>
      async (registry: AnyRegistry, _environmentId: string, input: Json) => {
        this.#log(method, input);
        const result = apply(input);
        this.#bump(
          registry,
          bump === "database" ? "database" : `dataSource:${FIXTURE_IDS.dataSource}`,
        );
        if (bump === "dataSource" && !this.#quietRowWrites) this.#bump(registry, "database");
        return result;
      };
    const permission = (key: keyof FakeDatabase["permissions"]) => (_environmentId: string) => {
      let atom = this.#permissionAtoms.get(key);
      if (atom === undefined) {
        atom = Atom.make(this.permissions[key]);
        this.#permissionAtoms.set(key, atom);
      }
      return atom;
    };
    return {
      databaseAtom: (_environmentId: string, databaseId: string) => this.#modelAtom(databaseId),
      rowAtom: (_environmentId: string, pageId: string) => this.#rowAtom(pageId),
      listAtom: () => this.#listAtom(),
      listPage: async (
        _registry: AnyRegistry,
        _environmentId: string,
        _spaceId: string | undefined,
        cursor: string | undefined,
      ) => {
        this.#log("listPage", { cursor });
        return this.#listResult(Number(cursor ?? 0));
      },
      query: (registry: AnyRegistry, input: SpaceDatabaseQueryInput) => this.query(registry, input),
      run: {
        create: run(
          "create",
          () => ({
            databaseId: this.database.id,
            dataSourceId: FIXTURE_IDS.dataSource,
            viewId: this.views[0]?.id,
            propertyIds: [],
          }),
          "database",
        ),
        update: run(
          "update",
          (input) => {
            const { icon: _, ...rest } = this.database;
            const icon = input.icon === undefined ? this.database.icon : input.icon;
            this.database = {
              ...rest,
              title: String(input.title ?? this.database.title),
              ...(typeof icon === "string" ? { icon } : {}),
            };
            return { revision: ++this.revision };
          },
          "database",
        ),
        updateSchema: run(
          "updateSchema",
          (input) => {
            const before = { dataSource: this.dataSource, rows: this.rows };
            for (const operation of (input.operations as Json[]) ?? []) {
              if (operation.op === "addProperty") {
                const draft = operation.property as {
                  id: string;
                  name: string;
                  type: string;
                  config?: unknown;
                };
                this.dataSource = {
                  ...this.dataSource,
                  properties: {
                    ...this.dataSource.properties,
                    [draft.id]: { ...draft, config: draft.config ?? {}, position: 99 } as never,
                  },
                };
              } else if (operation.op === "updateProperty") {
                const id = String(operation.propertyId);
                const existing = this.dataSource.properties[id];
                if (existing !== undefined)
                  this.dataSource = {
                    ...this.dataSource,
                    properties: {
                      ...this.dataSource.properties,
                      [id]: {
                        ...existing,
                        ...(operation.name === undefined ? {} : { name: operation.name }),
                        ...(operation.config === undefined ? {} : { config: operation.config }),
                      } as never,
                    },
                  };
              }
            }
            try {
              this.recomputeFormulas();
            } catch (refusal) {
              this.dataSource = before.dataSource;
              this.rows = before.rows;
              throw refusal;
            }
            return {
              dataSourceId: FIXTURE_IDS.dataSource,
              schemaRevision: 2,
              dataRevision: this.dataRevision,
              created: [],
              clearedCells: 0,
              affectedDataSourceIds: [FIXTURE_IDS.dataSource],
            };
          },
          "database",
        ),
        createDataSource: run(
          "createDataSource",
          () => ({
            dataSourceId: `ds-new-${this.#nextId++}`,
            propertyIds: [],
            revision: ++this.revision,
          }),
          "database",
        ),
        createView: run(
          "createView",
          (input) => {
            const id = `view-new-${this.#nextId++}`;
            this.views.push({
              ...(input as object),
              id,
              databaseId: this.database.id,
              position: this.views.length,
              sorts: (input.sorts as never) ?? [],
              properties: (input.properties as never) ?? [],
              layout: (input.layout as never) ?? {},
            } as unknown as SpaceDatabaseView);
            return { viewId: id, revision: ++this.revision };
          },
          "database",
        ),
        updateView: run(
          "updateView",
          (input) => {
            const { viewId, ...patch } = input as { viewId: string } & ViewPatch;
            this.views = this.views.map((view) =>
              view.id === viewId ? applyViewPatch(view, patch) : view,
            );
            return { viewId, revision: ++this.revision };
          },
          "database",
        ),
        deleteView: run(
          "deleteView",
          (input) => {
            this.views = this.views.filter((view) => view.id !== input.viewId);
            return { viewId: input.viewId, revision: ++this.revision };
          },
          "database",
        ),
        createRows: run(
          "createRows",
          (input) => {
            const drafts =
              (input.rows as {
                title?: string;
                cells?: Json;
                asTemplate?: boolean;
                templateId?: string;
              }[]) ?? [];
            const target = this.sourceOf(String(input.dataSourceId));
            const created = drafts.map((draft) => {
              const number = target.rows.length + 1;
              const template =
                draft.templateId === undefined
                  ? undefined
                  : this.templateRows.get(draft.templateId);
              const title = draft.title ?? "";
              const id = `row-new-${this.#nextId++}`;
              const row = {
                page: {
                  id,
                  title,
                  ...(template?.page.icon === undefined ? {} : { icon: template.page.icon }),
                  revision: 1,
                  createdAt: "t",
                  updatedAt: "t",
                },
                number,
                cells: { ...template?.cells, ...draft.cells, title },
              } as unknown as SpaceDatabaseRow;
              if (draft.asTemplate === true) {
                this.templateRows.set(id, row);
                this.dataSource = {
                  ...this.dataSource,
                  templates: [...this.dataSource.templates, { pageId: id, title } as never],
                };
              } else target.rows.push(row);
              return { pageId: id, number };
            });
            return { rows: created, dataRevision: ++this.dataRevision };
          },
          "dataSource",
        ),
        updateDataSource: run(
          "updateDataSource",
          (input) => {
            const { subItems, defaultTemplateId } = input as {
              subItems?: { parentPropertyId: string } | null;
              defaultTemplateId?: string | null;
            };
            let next: Json = { ...this.dataSource };
            if (subItems === null) delete next.subItems;
            else if (subItems !== undefined) {
              const twin = Object.values(this.dataSource.properties).find(
                (property) =>
                  (property.config as { twoWay?: { propertyId: string } }).twoWay?.propertyId !==
                    undefined && property.id === subItems.parentPropertyId,
              );
              next.subItems = {
                parentPropertyId: subItems.parentPropertyId,
                childrenPropertyId:
                  (twin?.config as { twoWay?: { propertyId: string } } | undefined)?.twoWay
                    ?.propertyId ?? "children",
              };
            }
            if (defaultTemplateId === null) delete next.defaultTemplateId;
            else if (defaultTemplateId !== undefined) next.defaultTemplateId = defaultTemplateId;
            this.dataSource = next as unknown as SpaceDataSource;
            return {
              schemaRevision: 2,
              dataRevision: this.dataRevision,
              revision: ++this.revision,
            };
          },
          "database",
        ),
        updateRows: run(
          "updateRows",
          (input) => {
            for (const entry of (input.rows as { pageId: string; cells: Json }[]) ?? []) {
              this.rows = this.rows.map((row) => {
                if (row.page.id !== entry.pageId) return row;
                const cells: Json = { ...row.cells };
                for (const [key, value] of Object.entries(entry.cells)) {
                  if (value === null) delete cells[key];
                  else cells[key] = value;
                }
                return { ...row, cells } as SpaceDatabaseRow;
              });
            }
            this.recomputeFormulas();
            return { dataRevision: ++this.dataRevision };
          },
          "dataSource",
        ),
        moveRows: run("moveRows", () => ({ dataRevision: ++this.dataRevision }), "dataSource"),
      },
      permission: {
        cells: permission("cells"),
        rows: permission("rows"),
        schema: permission("schema"),
        views: permission("views"),
        create: permission("create"),
        rename: permission("rename"),
      },
      changed: {
        database: () => this.counter("database"),
        dataSource: (_environmentId: string, dataSourceId: string) =>
          this.counter(`dataSource:${dataSourceId}`),
      },
      live: () => false,
      rowPageChanged: (registry: AnyRegistry, _environmentId: string, pageId: string) => {
        this.#bump(registry, `row:${pageId}`);
        this.#bump(registry, `dataSource:${FIXTURE_IDS.dataSource}`);
      },
      trashRow: async (registry: AnyRegistry, _environmentId: string, pageId: string) => {
        this.#log("trashRow", { pageId });
        const gone = this.rows.find((row) => row.page.id === pageId);
        if (gone !== undefined) this.trashed.set(pageId, gone);
        this.rows = this.rows.filter((row) => row.page.id !== pageId);
        if (this.templateRows.delete(pageId))
          this.dataSource = {
            ...this.dataSource,
            templates: this.dataSource.templates.filter((entry) => entry.pageId !== pageId),
          };
        this.#bump(registry, `dataSource:${FIXTURE_IDS.dataSource}`);
      },
    };
  }
}

/** The `vi.mock` factory result for `data/ports`: delegates to whichever fake the test installed. */
export function fakePortsModule(current: () => FakeDatabase) {
  const ports = () => current().ports();
  return {
    databasePorts: new Proxy({} as ReturnType<FakeDatabase["ports"]>, {
      get: (_target, key) => Reflect.get(ports(), key),
    }),
  };
}
