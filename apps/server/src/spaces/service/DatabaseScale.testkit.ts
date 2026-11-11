import * as NodeSqlite from "node:sqlite";

import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import { databaseKit, exec, oid, pid, raw } from "./Databases.testkit.ts";
import type { boot } from "./Spaces.testkit.ts";

/**
 * Rows in the large fixture. The CI size keeps every assertion; the full 25,000-row size is
 * `T2_SPACES_SCALE_ROWS=25000 vp test run src/spaces/service/DatabaseScale`.
 */
export const SCALE_ROWS = Number(process.env.T2_SPACES_SCALE_ROWS ?? 2_000);
/** The comparison copy: statement counts at SCALE_ROWS must equal the counts here. */
export const SMALL_ROWS = 1_000;
/** Set T2_SPACES_SCALE_REPORT=1 to print the measured numbers. */
export const report = (label: string, value: unknown) => {
  if (process.env.T2_SPACES_SCALE_REPORT === "1")
    process.stderr.write(`[scale] ${label}: ${JSON.stringify(value)}\n`);
};

export const p = {
  n: [1, 2, 3, 4, 5, 6].map((k) => pid(`num00${k}`)),
  t: [1, 2, 3, 4].map((k) => pid(`txt00${k}`)),
  s1: pid("sel001"),
  s2: pid("sel002"),
  s200: pid("sel200"),
  m1: pid("mul001"),
  m2: pid("mul002"),
  status: pid("sta001"),
  d: [1, 2, 3].map((k) => pid(`dat00${k}`)),
  c: [1, 2].map((k) => pid(`chk00${k}`)),
  url: pid("url001"),
  email: pid("eml001"),
  uid: pid("uid001"),
  project: pid("prj001"),
  parent: pid("par001"),
  tasksOf: pid("tsk001"),
  kids: pid("kid001"),
  rollSum: pid("rol001"),
  rollKids: pid("rol002"),
  fNum: pid("frm001"),
  fText: pid("frm002"),
  fDate: pid("frm003"),
  budget: pid("bud001"),
  region: pid("reg001"),
  tier: pid("tie001"),
};
const opts = (prefix: string, count: number, pad = 1) =>
  Array.from({ length: count }, (_, k) => ({
    id: oid(`${prefix}${String(k).padStart(pad, "0")}`),
    name: `${prefix} ${k}`,
  }));
const statusOptions = [
  { id: oid("sto0"), name: "Todo", group: "todo" as const },
  { id: oid("sto1"), name: "Doing", group: "in_progress" as const },
  { id: oid("sto2"), name: "Done", group: "complete" as const },
];

type Booted = Effect.Success<ReturnType<typeof boot>>;
interface ScaleHost {
  readonly service: Booted["service"];
  readonly common: Booted["common"];
  readonly spaceId: C.SpaceId;
  readonly appendToPageId: C.SpacePageId;
  readonly dbPath: string;
  readonly kit: ReturnType<typeof databaseKit>;
}

export interface Scale {
  readonly rows: number;
  readonly bodies: number;
  readonly projectCount: number;
  readonly prefix: string;
  readonly databaseId: C.SpaceDatabaseId;
  readonly dataSourceId: C.SpaceDataSourceId;
  readonly projects: C.SpaceDataSourceId;
  readonly viewId: C.SpaceViewId;
  readonly blockId: C.SpaceBlockId | undefined;
  readonly kit: ReturnType<typeof databaseKit>;
  readonly taskId: (i: number) => C.SpacePageId;
  readonly projectId: (i: number) => C.SpacePageId;
  readonly query: (
    extra?: Partial<C.SpaceDatabaseQueryInput>,
  ) => ReturnType<Booted["service"]["queryDatabase"]>;
}

const DAY = 86_400_000;
/** 2026-01-01T00:00:00Z */
const EPOCH_MS = 1_767_225_600_000;
const dayOf = (offset: string) =>
  `strftime('%Y-%m-%d', (${EPOCH_MS} + ${offset}) / 1000, 'unixepoch')`;

/**
 * One database of `rows` Tasks (32 properties) and rows / 12 Projects, seeded by bulk SQL in one
 * transaction, then brought up to date by the real computed drain. Rows 1..bodies hold a
 * 1,000-block body: by i % 4, an image first (0, 1), the first image at block 500 (2), or none (3).
 */
export const buildScale = Effect.fn("DatabaseScaleTestkit.build")(function* (
  host: ScaleHost,
  input: { readonly prefix: string; readonly rows: number; readonly bodies: number },
) {
  const { service, common, dbPath } = host;
  const { prefix, rows, bodies } = input;
  const projectCount = Math.max(10, Math.floor(rows / 12));
  const { kit } = host;
  const created = yield* kit.create(`Tasks ${prefix}`, {
    appendToPageId: host.appendToPageId,
    properties: [
      ...p.n.map((id, k) => ({ id, name: `Num${k + 1}`, type: "number" as const })),
      ...p.t.map((id, k) => ({ id, name: `Text${k + 1}`, type: "text" as const })),
      { id: p.s1, name: "Sel1", type: "select", options: opts("s1o", 4) },
      { id: p.s2, name: "Sel2", type: "select", options: opts("s2o", 4) },
      { id: p.s200, name: "Sel200", type: "select", options: opts("bo", 200, 3) },
      { id: p.m1, name: "Multi1", type: "multi_select", options: opts("m1o", 6) },
      { id: p.m2, name: "Multi2", type: "multi_select", options: opts("m2o", 6) },
      { id: p.status, name: "Status", type: "status", options: statusOptions },
      ...p.d.map((id, k) => ({ id, name: `Date${k + 1}`, type: "date" as const })),
      ...p.c.map((id, k) => ({ id, name: `Check${k + 1}`, type: "checkbox" as const })),
      { id: p.url, name: "Link", type: "url" },
      { id: p.email, name: "Mail", type: "email" },
      { id: p.uid, name: "Id", type: "unique_id", config: { prefix: "T" } },
    ],
  });
  const tasks = created.dataSourceId;
  const projects = (yield* service.createDataSource({
    ...common,
    mutationId: `projects-${prefix}`,
    databaseId: created.databaseId,
    name: "Projects",
  })).dataSourceId;
  yield* kit.schema(projects, [
    { op: "addProperty", property: { id: p.budget, name: "Budget", type: "number" } },
    { op: "addProperty", property: { id: p.region, name: "Region", type: "text" } },
    {
      op: "addProperty",
      property: { id: p.tier, name: "Tier", type: "select", options: opts("tier", 3) },
    },
    { op: "addProperty", property: { id: pid("act001"), name: "Active", type: "checkbox" } },
    { op: "addProperty", property: { id: pid("sta002"), name: "Kickoff", type: "date" } },
    { op: "addProperty", property: { id: pid("cod001"), name: "Code", type: "text" } },
  ]);
  yield* kit.schema(tasks, [
    {
      op: "addProperty",
      property: {
        id: p.project,
        name: "Project",
        type: "relation",
        config: { dataSourceId: projects, limit: "many", twoWay: { propertyId: p.tasksOf } },
      },
    },
    {
      op: "addProperty",
      property: {
        id: p.parent,
        name: "Parent",
        type: "relation",
        config: { dataSourceId: tasks, limit: "one", twoWay: { propertyId: p.kids } },
      },
    },
  ]);
  yield* service.updateDataSource({
    ...common,
    mutationId: `sub-${prefix}`,
    dataSourceId: tasks,
    subItems: { parentPropertyId: p.parent },
  });
  yield* seed(dbPath, {
    prefix,
    rows,
    bodies,
    projectCount,
    tasks,
    projects,
    spaceId: host.spaceId,
  });
  // The definitions queue every row; the real drain fills the values.
  yield* kit.schema(tasks, [
    {
      op: "addProperty",
      property: {
        id: p.rollSum,
        name: "BudgetSum",
        type: "rollup",
        config: { relationPropertyId: p.project, targetPropertyId: p.budget, function: "sum" },
      },
    },
    {
      op: "addProperty",
      property: {
        id: p.rollKids,
        name: "KidCount",
        type: "rollup",
        config: { relationPropertyId: p.kids, targetPropertyId: "title", function: "count_all" },
      },
    },
    {
      op: "addProperty",
      property: {
        id: p.fNum,
        name: "Twice",
        type: "formula",
        config: { expression: 'prop("Num1") * 2 + prop("Num2")' },
      },
    },
    {
      op: "addProperty",
      property: {
        id: p.fText,
        name: "Where",
        type: "formula",
        config: { expression: 'prop("Project").first().prop("Region")' },
      },
    },
    {
      op: "addProperty",
      property: {
        id: p.fDate,
        name: "Later",
        type: "formula",
        config: { expression: 'dateAdd(prop("Date1"), 1, "days")' },
      },
    },
  ]);
  yield* service.drainComputed;
  const query = (extra: Partial<C.SpaceDatabaseQueryInput> = {}) =>
    service.queryDatabase({
      environmentId: common.environmentId,
      dataSourceId: tasks,
      mode: "rows",
      timeZone: "UTC",
      ...extra,
    });
  return {
    rows,
    bodies,
    projectCount,
    prefix,
    databaseId: created.databaseId,
    dataSourceId: tasks,
    projects,
    viewId: created.viewId,
    blockId: created.block?.blockId,
    kit,
    taskId: (i: number) => C.SpacePageId.make(`${prefix}-${i}`),
    projectId: (i: number) => C.SpacePageId.make(`${prefix}p-${i}`),
    query,
  } satisfies Scale;
});

const seed = (
  dbPath: string,
  o: {
    readonly prefix: string;
    readonly rows: number;
    readonly bodies: number;
    readonly projectCount: number;
    readonly tasks: C.SpaceDataSourceId;
    readonly projects: C.SpaceDataSourceId;
    readonly spaceId: C.SpaceId;
  },
) =>
  exec(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { prefix, rows: n, projectCount: pc, tasks, projects, bodies } = o;
      const run = (text: string) => sql.unsafe(text);
      const at = "'2026-11-10T12:00:00.000Z'";
      const nums = (count: number) =>
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
      const cells = (
        source: string,
        count: number,
        who: string,
        property: string,
        columns: Readonly<Record<string, string>>,
        where = "",
        ord = "0",
      ) =>
        run(`${nums(count)} INSERT INTO spaces_db_cells
          (page_id, property_id, ord, data_source_id, ${Object.keys(columns).join(", ")})
          SELECT '${who}-' || i, '${property}', ${ord}, '${source}', ${Object.values(columns).join(", ")}
          FROM n ${where}`);
      const task = (
        property: string,
        columns: Readonly<Record<string, string>>,
        where = "",
        ord = "0",
      ) => cells(tasks, n, prefix, property, columns, where, ord);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const [who, source, count, label] of [
            [prefix, tasks, n, "Task"],
            [`${prefix}p`, projects, pc, "Project"],
          ] as const) {
            yield* run(
              `${nums(count)} INSERT INTO spaces_ids (id, kind) SELECT '${who}-' || i, 'page' FROM n`,
            );
            yield* run(`${nums(count)} INSERT INTO spaces_pages
              (page_id, space_id, title, created_at, updated_at, data_source_id, row_seq, row_position, row_template)
              SELECT '${who}-' || i, '${o.spaceId}', '${label} ' || printf('%05d', i), ${at}, ${at}, '${source}', i, i * 1024, 0 FROM n`);
            yield* cells(source, count, who, "title", {
              text_key: `lower('${label}') || ' ' || printf('%05d', i)`,
            });
            yield* run(`UPDATE spaces_db_data_sources SET row_count = ${count}, next_row_seq = ${count + 1}
              WHERE data_source_id = '${source}'`);
          }
          const numberExprs = [
            "(i * 7919) % 1000",
            "(i * 31) % 97",
            "i % 13",
            "(i * 17) % 10007",
            "i",
            "(i % 5) * 1.5",
          ];
          for (const [k, expr] of numberExprs.entries()) yield* task(p.n[k]!, { num: expr });
          const textValue = (k: number) => `'alpha ' || (i % ${[500, 97, 13, 2000][k]})`;
          for (const k of [0, 1, 2, 3])
            yield* task(
              p.t[k]!,
              {
                text_key: textValue(k),
                value: `'[{"text":"' || ${textValue(k)} || '","marks":[]}]'`,
              },
              k === 3 ? "WHERE i % 4 != 0" : "",
            );
          yield* task(p.s1, { ref: `'s1o' || (i % 4)` });
          yield* task(p.s2, { ref: `'s2o' || ((i / 4) % 4)` });
          yield* task(p.s200, { ref: `'bo' || printf('%03d', i % 200)` });
          yield* task(p.m1, { ref: `'m1o' || (i % 6)` });
          yield* task(p.m1, { ref: `'m1o' || ((i + 2) % 6)` }, "WHERE i % 3 = 0", "1");
          yield* task(p.m2, { ref: `'m2o' || (i % 6)` }, "WHERE i % 2 = 0");
          yield* task(p.status, { ref: `'sto' || (i % 3)` });
          yield* task(p.d[0]!, {
            time_start: `${EPOCH_MS} + (i % 365) * ${DAY}`,
            value: `'{"start":"' || ${dayOf(`(i % 365) * ${DAY}`)} || '"}'`,
          });
          yield* task(p.d[1]!, {
            time_start: `${EPOCH_MS} + (i % 365) * ${DAY}`,
            time_end: `${EPOCH_MS} + ((i % 365) + 1 + i % 9) * ${DAY}`,
            value: `'{"end":"' || ${dayOf(`((i % 365) + 1 + i % 9) * ${DAY}`)} || '","start":"' || ${dayOf(`(i % 365) * ${DAY}`)} || '"}'`,
          });
          yield* task(
            p.d[2]!,
            {
              time_start: `${EPOCH_MS} + (i % 200) * ${DAY} + 36000000`,
              flags: "1",
              value: `'{"start":"' || strftime('%Y-%m-%dT%H:%M:%fZ', (${EPOCH_MS} + (i % 200) * ${DAY} + 36000000) / 1000.0, 'unixepoch') || '"}'`,
            },
            "WHERE i % 5 != 0",
          );
          yield* task(p.c[0]!, { num: "1" }, "WHERE i % 2 = 0");
          yield* task(p.c[1]!, { num: "1" }, "WHERE i % 7 = 0");
          yield* task(p.url, {
            text_key: `'https://x.example/' || i`,
            value: `'"https://x.example/' || i || '"'`,
          });
          yield* task(p.email, {
            text_key: `'user' || i || '@example.com'`,
            value: `'"user' || i || '@example.com"'`,
          });
          // Relations, both sides. A task points at one project; every tenth task is a parent.
          yield* task(p.project, { ref: `'${prefix}p-' || (((i - 1) % ${pc}) + 1)` });
          const reverse = (
            source: string,
            count: number,
            property: string,
            ref: string,
            ord: string,
            where: string,
            width: number,
          ) =>
            run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}),
              k(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM k WHERE j < ${width})
              INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, ref)
              SELECT '${source === projects ? `${prefix}p` : prefix}-' || i, '${property}', k.j, '${source}', ${ref}
              FROM n, k WHERE ${where}`);
          yield* reverse(
            projects,
            pc,
            p.tasksOf,
            `'${prefix}-' || (i + k.j * ${pc})`,
            "k.j",
            `i + k.j * ${pc} <= ${n}`,
            Math.ceil(n / pc),
          );
          yield* task(
            p.parent,
            { ref: `'${prefix}-' || (i - ((i - 1) % 10))` },
            "WHERE (i - 1) % 10 != 0",
          );
          yield* reverse(
            tasks,
            n,
            p.kids,
            `'${prefix}-' || (i + 1 + k.j)`,
            "k.j",
            `(i - 1) % 10 = 0 AND i + 1 + k.j <= ${n}`,
            8,
          );
          const project = (
            property: string,
            columns: Readonly<Record<string, string>>,
            where = "",
          ) => cells(projects, pc, `${prefix}p`, property, columns, where);
          yield* project(p.budget, { num: "(i * 13) % 1000" });
          yield* project(p.region, {
            text_key: `'region ' || (i % 20)`,
            value: `'[{"text":"region ' || (i % 20) || '","marks":[]}]'`,
          });
          yield* project(p.tier, { ref: `'tier' || (i % 3)` });
          yield* project(pid("act001"), { num: "1" }, "WHERE i % 2 = 0");
          if (bodies > 0) {
            const blocks = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${bodies}),
              k(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM k WHERE j < 999)`;
            const image = `(i % 4 IN (0, 1) AND j = 0) OR (i % 4 = 2 AND j = 500)`;
            yield* run(
              `${blocks} INSERT INTO spaces_ids (id, kind) SELECT 'b-${prefix}-' || i || '-' || j, 'block' FROM n, k`,
            );
            yield* run(`${blocks} INSERT INTO spaces_blocks (block_id, page_id, parent_id, rank, payload, logical_bytes)
              SELECT 'b-${prefix}-' || i || '-' || j, '${prefix}-' || i, NULL, printf('%06d', j),
                CASE WHEN ${image} THEN '{"type":"image","content":{"assetId":"asset-' || i || '"}}'
                  ELSE '{"type":"paragraph","content":{"text":"line ' || j || '"}}' END, 60
              FROM n, k`);
            yield* run(`${blocks} INSERT INTO spaces_block_asset_refs (block_id, asset_id)
              SELECT 'b-${prefix}-' || i || '-' || j, 'asset-' || i FROM n, k WHERE ${image}`);
          }
        }),
      );
    }),
  );

/** The statements one effect runs, with their plans from a second read-only connection. */
interface Observed<A> {
  readonly result: A;
  readonly statements: readonly (readonly [string, readonly unknown[]])[];
}

export const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const statements: [string, readonly unknown[]][] = [];
    const transformer: Statement.Transformer = (statement) => {
      const [text, params] = statement.compile();
      statements.push([text, params]);
      return Effect.succeed(statement);
    };
    const result = yield* effect.pipe(
      Effect.provideService(Statement.CurrentTransformer, transformer),
    );
    return { result, statements } satisfies Observed<A>;
  });

const PREAMBLE = [
  "SELECT * FROM spaces_core",
  "SELECT * FROM spaces_db_data_sources WHERE data_source_id",
  "SELECT b.page_id FROM spaces_db_databases",
  "SELECT p.trash_batch_id, p.root_order",
  "SELECT * FROM spaces_db_properties",
  "SELECT * FROM spaces_db_options WHERE data_source_id",
  "SELECT 1 FROM spaces_db_computed_dirty WHERE data_source_id",
];
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const RELATED = "SELECT page_id, title, icon, data_source_id FROM spaces_pages WHERE page_id IN";
/** Chunks of related-page titles: bounded by maxRelatedPages, not by the data source. */
export const relatedChunks = (statements: Observed<unknown>["statements"]) =>
  statements.filter(([text]) => squash(text).startsWith(RELATED)).length;
/**
 * The statements of the engine itself: what is left after the fixed read preamble (clock, source,
 * liveness, schema) and the related-page title chunks.
 */
export const engine = (statements: Observed<unknown>["statements"]) =>
  statements.filter(
    ([text]) =>
      !squash(text).startsWith(RELATED) && !PREAMBLE.some((head) => squash(text).startsWith(head)),
  );

const reads = (statements: Observed<unknown>["statements"]) =>
  statements.filter(([text]) => /^\s*(SELECT|WITH)\b/i.test(text));

const GUARDED = ["spaces_db_cells", "spaces_blocks", "spaces_db_options", "spaces_pages"] as const;
const KEYWORDS = new Set([
  "where",
  "join",
  "on",
  "left",
  "inner",
  "cross",
  "group",
  "order",
  "limit",
  "using",
  "and",
  "as",
  "select",
  "set",
]);

/** Full scans of the big tables in the statements' plans (empty is the target). */
export const scans = (dbPath: string, statements: Observed<unknown>["statements"]) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const found: string[] = [];
      for (const [text, params] of reads(statements)) {
        const names = new Map<string, string>();
        for (const match of text.matchAll(
          new RegExp(`\\b(${GUARDED.join("|")})\\b(?:\\s+(?:AS\\s+)?([a-z][a-z0-9_]*))?`, "gi"),
        )) {
          names.set(match[1]!, match[1]!);
          const alias = match[2];
          if (alias !== undefined && !KEYWORDS.has(alias.toLowerCase()))
            names.set(alias, match[1]!);
        }
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params as never,
        );
        for (const row of plan) {
          const scan = /^SCAN (\S+)/.exec(row.detail);
          if (scan !== null && names.has(scan[1]!))
            found.push(`${names.get(scan[1]!)}: ${row.detail}`);
        }
      }
      return found;
    }),
  );

/** The plan lines of every statement, for assertions about a particular access path. */
export const plansOf = (dbPath: string, statements: Observed<unknown>["statements"]) =>
  raw(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const lines: string[] = [];
      for (const [text, params] of reads(statements)) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params as never,
        );
        for (const row of plan) lines.push(row.detail);
      }
      return lines;
    }),
  );

export const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The window statement of a query: the one that orders and limits the data source's rows. */
export const windowStatement = (statements: Observed<unknown>["statements"]) =>
  statements.find(
    ([text]) => /AS row_position/.test(text) && /ORDER BY/.test(text) && /LIMIT/.test(text),
  );

/**
 * How many rows of `spaces_pages` the statement visits: the same statement on a second read-only
 * connection with a counting predicate in front of its row test. A count, never a duration.
 */
export const pagesVisited = (dbPath: string, statement: readonly [string, readonly unknown[]]) => {
  const [text, params] = statement;
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    let visited = 0;
    database.function("t2_visit", (_page: unknown) => {
      visited++;
      return 1;
    });
    const counted = text.replace(
      "FROM spaces_pages p WHERE ",
      "FROM spaces_pages p WHERE t2_visit(p.page_id) AND ",
    );
    database.prepare(counted).all(...(params as NodeSqlite.SQLInputValue[]));
    return visited;
  } finally {
    database.close();
  }
};
