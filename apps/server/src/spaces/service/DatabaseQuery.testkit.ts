import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as SqlClient from "effect/sql/SqlClient";

import { databaseKit, exec, oid, pid } from "./Databases.testkit.ts";
import { boot, env } from "./Spaces.testkit.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const DAY = 86_400_000;

export const ids = {
  note: pid("note01"),
  points: pid("points"),
  done: pid("done01"),
  link: pid("link01"),
  prio: pid("prio01"),
  tags: pid("tags01"),
  state: pid("state1"),
  due: pid("due001"),
  files: pid("files1"),
  project: pid("proj01"),
  created: pid("made01"),
  edited: pid("edit01"),
  number: pid("seq001"),
  calc: pid("calc01"),
};
export const options = {
  low: oid("low01"),
  med: oid("med01"),
  high: oid("high1"),
  a: oid("taga1"),
  b: oid("tagb1"),
  c: oid("tagc1"),
  todo: oid("todo1"),
  prog: oid("prog1"),
  done: oid("done1"),
};
const run = (text: string) => [{ text, marks: [] }];

/** Seven rows, created a day apart from 2026-11-05, with "now" at 2026-11-11 12:00 UTC. */
export const seed = Effect.fn("DatabaseQueryTestkit.seed")(function* (dbPath: string) {
  yield* TestClock.setTime(NOW);
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Tasks", {
    appendToPageId: page.id,
    properties: [
      { id: ids.note, name: "Note", type: "text" },
      { id: ids.points, name: "Points", type: "number" },
      { id: ids.done, name: "Done", type: "checkbox" },
      { id: ids.link, name: "Link", type: "url" },
      {
        id: ids.prio,
        name: "Priority",
        type: "select",
        options: [
          { id: options.low, name: "Low" },
          { id: options.med, name: "Medium" },
          { id: options.high, name: "High" },
        ],
      },
      {
        id: ids.tags,
        name: "Tags",
        type: "multi_select",
        options: [
          { id: options.a, name: "A" },
          { id: options.b, name: "B" },
          { id: options.c, name: "C" },
        ],
      },
      {
        id: ids.state,
        name: "State",
        type: "status",
        options: [
          { id: options.todo, name: "Todo", group: "todo" },
          { id: options.prog, name: "Doing", group: "in_progress" },
          { id: options.done, name: "Done", group: "complete" },
        ],
      },
      { id: ids.due, name: "Due", type: "date" },
      { id: ids.files, name: "Files", type: "files" },
      { id: ids.created, name: "Made", type: "created_time" },
      { id: ids.edited, name: "Edited", type: "last_edited_time" },
      { id: ids.number, name: "No", type: "unique_id", config: { prefix: "T" } },
      { id: ids.calc, name: "Calc", type: "formula", config: { expression: "now()" } },
    ],
  });
  const projects = (yield* service.createDataSource({
    ...common,
    mutationId: "projects-source",
    databaseId: created.databaseId,
    name: "Projects",
  })).dataSourceId;
  const project = (yield* kit.addRows(projects, [{ title: "P1" }, { title: "P2" }])).rows.map(
    (row) => row.pageId,
  );
  yield* kit.schema(created.dataSourceId, [
    {
      op: "addProperty",
      property: {
        id: ids.project,
        name: "Project",
        type: "relation",
        config: { dataSourceId: projects, limit: "many" },
      },
    },
  ]);
  const drafts: readonly C.SpaceRowDraft[] = [
    {
      title: "Alpha",
      cells: {
        [ids.note]: run("Hello World"),
        [ids.points]: 10,
        [ids.done]: true,
        [ids.link]: "https://a.example",
        [ids.prio]: options.low,
        [ids.tags]: [options.a, options.b],
        [ids.state]: options.todo,
        [ids.due]: { start: "2026-11-10" },
        [ids.files]: [{ name: "b.png", url: "https://x.example/b.png" }],
        [ids.project]: [project[0]!],
      },
    },
    {
      title: "bravo",
      cells: {
        [ids.note]: run("hello"),
        [ids.points]: 20,
        [ids.done]: false,
        [ids.link]: "https://b.example",
        [ids.prio]: options.med,
        [ids.tags]: [options.b],
        [ids.state]: options.prog,
        [ids.due]: { start: "2026-11-11" },
        [ids.project]: [project[0]!, project[1]!],
      },
    },
    {
      title: "Charlie",
      cells: {
        [ids.points]: 30,
        [ids.done]: true,
        [ids.prio]: options.high,
        [ids.tags]: [],
        [ids.state]: options.done,
        [ids.due]: { start: "2026-11-12T09:00:00Z" },
        [ids.files]: [{ name: "a.png", url: "https://x.example/a.png" }],
      },
    },
    {
      title: "Delta",
      cells: {
        [ids.note]: run("Héllo wörld"),
        [ids.done]: false,
        [ids.tags]: [options.a, options.b, options.c],
        [ids.state]: options.todo,
        [ids.due]: { start: "2026-11-09", end: "2026-11-13" },
      },
    },
    {
      title: "echo",
      cells: {
        [ids.note]: run("world"),
        [ids.points]: 20,
        [ids.done]: false,
        [ids.link]: "https://e.example/path",
        [ids.prio]: options.low,
        [ids.tags]: [options.c],
        [ids.state]: options.prog,
        [ids.due]: { start: "2026-11-11T23:30:00Z" },
        [ids.project]: [project[1]!],
      },
    },
    {
      title: "Foxtrot",
      cells: {
        [ids.note]: run("HELLO"),
        [ids.points]: -5,
        [ids.done]: true,
        [ids.link]: "https://f.example",
        [ids.prio]: options.med,
        [ids.state]: options.done,
      },
    },
    {
      title: "",
      cells: {
        [ids.note]: run("x"),
        [ids.points]: 0,
        [ids.done]: false,
        [ids.prio]: options.high,
        [ids.tags]: [options.c],
        [ids.due]: { start: "2026-12-25" },
      },
    },
  ];
  const rows: C.SpacePageId[] = [];
  for (const draft of drafts)
    rows.push((yield* kit.addRows(created.dataSourceId, [draft])).rows[0]!.pageId);
  yield* kit.setCells(created.dataSourceId, rows[6]!, { [ids.state]: null });
  // Rows were created together; spread their timestamps a day apart and edit one an hour ago.
  yield* exec(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [index, pageId] of rows.entries()) {
        const at = DateTime.formatIso(
          DateTime.makeUnsafe(Date.parse("2026-11-05T10:00:00.000Z") + index * DAY),
        );
        yield* sql`UPDATE spaces_pages SET created_at = ${at}, updated_at = ${at} WHERE page_id = ${pageId}`;
      }
      yield* sql`UPDATE spaces_pages SET updated_at = '2026-11-11T11:00:00.000Z' WHERE page_id = ${rows[1]!}`;
    }),
  );
  const dataSourceId = created.dataSourceId;
  const query = (extra: Partial<C.SpaceDatabaseQueryInput> = {}) =>
    service.queryDatabase({
      ...env,
      dataSourceId,
      mode: "rows",
      timeZone: "UTC",
      ...extra,
    });
  const titles = (result: C.SpaceDatabaseQueryResult) => result.rows.map((row) => row.page.title);
  return {
    service,
    common,
    kit,
    created,
    dataSourceId,
    spaceId: page.spaceId,
    projects,
    project,
    rows,
    query,
    titles,
  };
});

export const NAMES = ["Alpha", "bravo", "Charlie", "Delta", "echo", "Foxtrot", ""] as const;
export const cond = (
  property: C.SpacePropertyId,
  operator: string,
  value?: C.SpaceCellValue,
  part?: "start" | "end",
): C.SpaceFilter => ({
  property,
  operator,
  ...(value === undefined ? {} : { value }),
  ...(part === undefined ? {} : { part }),
});

/**
 * Adds `count` rows straight to the Spaces database file: titled `<prefix> 00001`, with `points`
 * (i * 7919 mod 1000) and `prio` cells. The service must be idle.
 */
export const bulkRows = (input: {
  readonly dbPath: string;
  readonly dataSourceId: C.SpaceDataSourceId;
  readonly spaceId: C.SpaceId;
  readonly count: number;
  readonly prefix: string;
}) =>
  exec(
    input.dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { dataSourceId: ds, count, prefix } = input;
      const at = DateTime.formatIso(DateTime.makeUnsafe(NOW - DAY));
      const [source] = yield* sql<{
        readonly next: number;
      }>`SELECT next_row_seq AS next FROM spaces_db_data_sources WHERE data_source_id = ${ds}`;
      const base = source!.next - 1;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO spaces_ids (id, kind) SELECT ${prefix} || '-' || i, 'page' FROM n`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO spaces_pages (page_id, space_id, title, created_at, updated_at, data_source_id, row_seq, row_position, row_template)
        SELECT ${prefix} || '-' || i, ${input.spaceId}, ${prefix} || ' ' || printf('%05d', i), ${at}, ${at}, ${ds},
          ${base} + i, (${base} + i) * 1024, 0 FROM n`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, text_key)
        SELECT ${prefix} || '-' || i, 'title', 0, ${ds}, lower(${prefix}) || ' ' || printf('%05d', i) FROM n`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, num)
        SELECT ${prefix} || '-' || i, 'points', 0, ${ds}, (i * 7919) % 1000 FROM n`;
      yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
        INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, ref)
        SELECT ${prefix} || '-' || i, 'prio01', 0, ${ds},
          CASE i % 3 WHEN 0 THEN 'low01' WHEN 1 THEN 'med01' ELSE 'high1' END FROM n`;
      yield* sql`UPDATE spaces_db_data_sources SET row_count = row_count + ${count},
        next_row_seq = next_row_seq + ${count} WHERE data_source_id = ${ds}`;
    }),
  );
