import { applyViewPatch, type ViewPatch } from "@t2code/client-runtime/spaces";
import { AsyncResult, Atom } from "effect/reactivity";
import type {
  SpaceDataSource,
  SpaceDatabase,
  SpaceDatabaseQueryInput,
  SpaceDatabaseQueryResult,
  SpaceDatabaseRow,
  SpaceDatabaseView,
  SpaceGroupBucket,
} from "@t2code/contracts/spaces";

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

export interface FakeCall {
  readonly method: string;
  readonly input: Json;
}

export interface FakeDatabaseOptions {
  readonly rows?: number;
  readonly views?: ReadonlyArray<SpaceDatabaseView>;
  readonly live?: boolean;
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
  dataRevision = 1;
  revision = 1;
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
    this.database = fixtureDatabase(options.live ?? true);
    this.views = [
      ...(options.views ?? [
        fixtureView(FIXTURE_IDS.tableView, "table", "Table", 0),
        fixtureView(FIXTURE_IDS.boardView, "board", "Board", 1),
      ]),
    ];
    this.rows = fixtureRows(options.rows ?? 0);
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
        const row = this.rows.find((entry) => entry.page.id === pageId);
        if (row === undefined) return AsyncResult.fail(new Error("The row is gone"));
        return AsyncResult.success({
          row,
          template: false,
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

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  #matching(input: SpaceDatabaseQueryInput): SpaceDatabaseRow[] {
    const search = input.search?.toLowerCase();
    return this.rows.filter(
      (row) =>
        search === undefined ||
        String(row.cells.title ?? "")
          .toLowerCase()
          .includes(search),
    );
  }

  async query(
    _registry: AnyRegistry,
    input: SpaceDatabaseQueryInput,
  ): Promise<SpaceDatabaseQueryResult> {
    this.#log("query", input as unknown as Json);
    const limit = input.limit ?? 50;
    const rows = this.#matching(input);
    const base = {
      dataSourceId: input.dataSourceId,
      schemaRevision: 1,
      dataRevision: this.dataRevision,
      relatedPages: {},
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
      const property = input.group.property;
      const options =
        (this.dataSource.properties[property]?.config as { options?: { id: string }[] })?.options ??
        [];
      const per = input.rowsPerGroup ?? 0;
      const buckets: SpaceGroupBucket[] = [
        ...options.map((option) => ({ kind: "option", optionId: option.id })),
        { kind: "empty" },
      ].map((key) => {
        const inBucket = rows.filter((row) => {
          const value = row.cells[property];
          return key.kind === "empty"
            ? value == null
            : value === (key as { optionId: string }).optionId;
        });
        return {
          key: key as never,
          count: inBucket.length,
          rows: inBucket.slice(0, per),
          nextCursor: inBucket.length > per ? (String(per) as never) : null,
        };
      });
      return { ...base, rows: [], groups: buckets, nextCursor: null } as SpaceDatabaseQueryResult;
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
      databaseAtom: () => this.#databaseAtom,
      rowAtom: (_environmentId: string, pageId: string) => this.#rowAtom(pageId),
      listAtom: () => Atom.make(AsyncResult.initial<never, never>()),
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
            this.database = { ...this.database, title: String(input.title ?? this.database.title) };
            return { revision: ++this.revision };
          },
          "database",
        ),
        updateSchema: run(
          "updateSchema",
          (input) => {
            for (const operation of (input.operations as Json[]) ?? []) {
              if (operation.op === "addProperty") {
                const draft = operation.property as { id: string; name: string; type: string };
                this.dataSource = {
                  ...this.dataSource,
                  properties: {
                    ...this.dataSource.properties,
                    [draft.id]: { ...draft, config: {}, position: 99 } as never,
                  },
                };
              }
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
            const drafts = (input.rows as { title?: string; cells?: Json }[]) ?? [];
            const created = drafts.map((draft) => {
              const number = this.rows.length + 1;
              const title = draft.title ?? "";
              this.rows.push({
                page: {
                  id: `row-new-${this.#nextId++}`,
                  title,
                  revision: 1,
                  createdAt: "t",
                  updatedAt: "t",
                },
                number,
                cells: { ...draft.cells, title },
              } as unknown as SpaceDatabaseRow);
              return { pageId: this.rows.at(-1)!.page.id, number };
            });
            return { rows: created, dataRevision: ++this.dataRevision };
          },
          "dataSource",
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
      rowPageChanged: (registry: AnyRegistry, _environmentId: string, pageId: string) => {
        this.#bump(registry, `row:${pageId}`);
        this.#bump(registry, `dataSource:${FIXTURE_IDS.dataSource}`);
      },
      trashRow: async (registry: AnyRegistry, _environmentId: string, pageId: string) => {
        this.#log("trashRow", { pageId });
        const gone = this.rows.find((row) => row.page.id === pageId);
        if (gone !== undefined) this.trashed.set(pageId, gone);
        this.rows = this.rows.filter((row) => row.page.id !== pageId);
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
