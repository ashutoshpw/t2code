import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import { databaseKit, exec, limitError, validationReason } from "./Databases.testkit.ts";
import { NAMES, bulkRows, cond, ids, options, seed } from "./DatabaseQuery.testkit.ts";
import { boot, env, fixture, recoveryIntent } from "./Spaces.testkit.ts";

const pid = C.SpacePropertyId.make;
const points = pid("points");
const asc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "ascending" });
const desc = (property: C.SpacePropertyId): C.SpaceSort => ({ property, direction: "descending" });

/** A data source of `count` rows titled "r01".. with points `i % 5`, then one per title. */
const ladder = Effect.fn("DatabaseQueryPagingTest.ladder")(function* (
  count: number,
  value: (index: number) => number | null = (index) => index % 5,
) {
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Ladder", {
    appendToPageId: page.id,
    properties: [
      { id: points, name: "Points", type: "number" },
      { id: ids.note, name: "Note", type: "text" },
    ],
  });
  const made = yield* kit.addRows(
    created.dataSourceId,
    Array.from({ length: count }, (_, index) => ({
      title: `r${String(index + 1).padStart(2, "0")}`,
      cells: value(index) === null ? {} : { [points]: value(index)! },
    })),
  );
  const query = (extra: Partial<C.SpaceDatabaseQueryInput>) =>
    service.queryDatabase({
      ...env,
      dataSourceId: created.dataSourceId,
      mode: "rows",
      timeZone: "UTC",
      ...extra,
    });
  return {
    service,
    kit,
    created,
    ids: made.rows.map((row) => row.pageId),
    query,
    spaceId: page.spaceId,
  };
});

it.layer(NodeServices.layer)("Spaces database query paging", (it) => {
  it.effect(
    "returns each row exactly once while unrelated rows and cells change between pages",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { kit, created, ids: rowIds, query } = yield* ladder(25);
          const sorts = [asc(points)];
          const seen: string[] = [];
          let cursor: C.SpaceCursor | undefined;
          let pageNumber = 0;
          do {
            const result = yield* query({ sorts, limit: 6, ...(cursor ? { cursor } : {}) });
            seen.push(...result.rows.map((row) => row.page.title));
            cursor = result.nextCursor ?? undefined;
            pageNumber++;
            if (pageNumber === 1) {
              // Another property of a returned row and of rows still to come; a new row sorting last;
              // a row still to come moves to the trash.
              yield* kit.setCells(created.dataSourceId, rowIds[0]!, {
                [ids.note]: [{ text: "a", marks: [] }],
              });
              yield* kit.setCells(created.dataSourceId, rowIds[24]!, {
                [ids.note]: [{ text: "b", marks: [] }],
              });
              yield* kit.addRows(created.dataSourceId, [
                { title: "late", cells: { [points]: 100 } },
              ]);
              yield* kit.service.trashPage(
                yield* recoveryIntent(kit.service, kit.common, rowIds[23]!, "trash", "trash-r24"),
              );
            }
          } while (cursor);
          const expected = new Set(
            rowIds
              .map((_, index) => `r${String(index + 1).padStart(2, "0")}`)
              .filter((title) => title !== "r24"),
          );
          expected.add("late");
          assert.equal(seen.length, expected.size);
          assert.deepEqual(new Set(seen), expected);
        }),
      ),
  );

  it.effect("repeats a returned row that moves forward and skips one that moves back", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { kit, created, ids: rowIds, query } = yield* ladder(10, (index) => index + 1);
        const sorts = [asc(points)];
        const first = yield* query({ sorts, limit: 3 });
        assert.deepEqual(
          first.rows.map((row) => row.page.title),
          ["r01", "r02", "r03"],
        );
        yield* kit.setCells(created.dataSourceId, rowIds[0]!, { [points]: 99 });
        yield* kit.setCells(created.dataSourceId, rowIds[9]!, { [points]: 0 });
        const seen = first.rows.map((row) => row.page.title);
        let cursor = first.nextCursor;
        while (cursor) {
          const next = yield* query({ sorts, limit: 3, cursor });
          seen.push(...next.rows.map((row) => row.page.title));
          cursor = next.nextCursor;
        }
        // r01 appears again at its new place; r10 (now 0) sorted before the cursor and is not seen.
        assert.deepEqual(seen, [
          "r01",
          "r02",
          "r03",
          "r04",
          "r05",
          "r06",
          "r07",
          "r08",
          "r09",
          "r01",
        ]);
      }),
    ),
  );

  it.effect("pages through empty sort values in both directions", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, titles } = yield* seed(dbPath);
        for (const sorts of [
          [asc(ids.points)],
          [desc(ids.points)],
          [asc(ids.prio), desc(ids.points)],
          [asc(ids.due)],
          [desc(ids.tags)],
        ]) {
          const whole = titles(yield* query({ sorts }));
          const paged: string[] = [];
          let cursor: C.SpaceCursor | undefined;
          do {
            const result = yield* query({ sorts, limit: 2, ...(cursor ? { cursor } : {}) });
            paged.push(...titles(result));
            cursor = result.nextCursor ?? undefined;
          } while (cursor);
          assert.deepEqual(paged, whole, JSON.stringify(sorts));
          assert.lengthOf(paged, NAMES.length);
        }
      }),
    ),
  );

  it.effect("tells a stale cursor from an invalid one", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, dataSourceId, kit, rows } = yield* seed(dbPath);
        const first = yield* query({ sorts: [asc(ids.points)], limit: 2 });
        const cursor = first.nextCursor!;
        // A changed definition is stale, and names the data revision to refetch from.
        const stale = yield* Effect.flip(query({ sorts: [desc(ids.points)], limit: 2, cursor }));
        assert.equal(stale._tag, "SpaceCursorStaleError");
        if (stale._tag === "SpaceCursorStaleError") assert.isAbove(stale.revision, 0);
        const filtered = yield* Effect.flip(
          query({ sorts: [asc(ids.points)], filter: cond(ids.done, "equals", true), cursor }),
        );
        assert.equal(filtered._tag, "SpaceCursorStaleError");
        assert.equal(
          yield* validationReason(query({ cursor: C.SpaceCursor.make("garbage") })),
          "invalid_cursor",
        );
        const forged = Buffer.from(
          JSON.stringify({ e: "other", o: "databases.query", f: "x", k: [], p: 1, s: 1 }),
        ).toString("base64url");
        assert.equal(
          yield* validationReason(query({ cursor: C.SpaceCursor.make(forged) })),
          "invalid_cursor",
        );
        const huge = C.SpaceCursor.make("a".repeat(9000));
        assert.equal(yield* validationReason(query({ cursor: huge })), "invalid_cursor");
        // The cursor survives unrelated edits: the same next window follows.
        const whole = (yield* query({ sorts: [asc(ids.points)] })).rows.map(
          (row) => row.page.title,
        );
        yield* kit.setCells(dataSourceId, rows[0]!, { [ids.note]: [{ text: "edit", marks: [] }] });
        const again = yield* query({ sorts: [asc(ids.points)], limit: 2, cursor });
        assert.deepEqual(
          again.rows.map((row) => row.page.title),
          whole.slice(2, 4),
        );
      }),
    ),
  );

  it.effect("enforces the row window and the response cap", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, spaceId, dataSourceId } = yield* seed(dbPath);
        assert.equal(yield* limitError(query({ limit: 101 })), "databases.maxQueryRows");
        yield* bulkRows({ dbPath, dataSourceId, spaceId, count: 100, prefix: "Fat" });
        // Make each bulk row's note about 12 KiB: 100 rows are far over the 256 KiB cap.
        const note = JSON.stringify([{ text: "x".repeat(12_000), marks: [] }]);
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, text_key, value)
              SELECT page_id, 'note01', 0, data_source_id, 'x', ${note} FROM spaces_pages WHERE page_id LIKE 'Fat-%'`;
          }),
        );
        const properties = [ids.note];
        const seen: string[] = [];
        let cursor: C.SpaceCursor | undefined;
        let windows = 0;
        do {
          const result = yield* query({
            properties,
            limit: 100,
            filter: cond(ids.note, "equals", "x"),
            ...(cursor ? { cursor } : {}),
          });
          assert.isAtMost(Buffer.byteLength(JSON.stringify(result), "utf8"), 262_144);
          assert.isAbove(result.rows.length, 0);
          seen.push(...result.rows.map((row) => row.page.id));
          cursor = result.nextCursor ?? undefined;
          windows++;
        } while (cursor);
        // Trimmed windows continue where they stopped: every row once (100 bulk rows and "x"), in several windows.
        assert.equal(seen.length, 101);
        assert.equal(new Set(seen).size, 101);
        assert.isAbove(windows, 1);
        // A row that alone exceeds the cap is refused.
        const bigNote = JSON.stringify([{ text: "y".repeat(16_000), marks: [] }]);
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (let i = 0; i < 20; i++) {
              const property = `fat${String(i).padStart(2, "0")}x`;
              yield* sql`INSERT INTO spaces_db_properties (data_source_id, property_id, name, name_key, type, position)
                VALUES (${dataSourceId}, ${property}, ${property}, ${property}, 'text', ${900_000 + i})`;
              yield* sql`INSERT INTO spaces_db_cells (page_id, property_id, ord, data_source_id, text_key, value)
                VALUES ('Fat-1', ${property}, 0, ${dataSourceId}, 'y', ${bigNote})`;
            }
          }),
        );
        const all = Array.from({ length: 20 }, (_, i) => pid(`fat${String(i).padStart(2, "0")}x`));
        assert.equal(
          yield* limitError(
            query({ properties: all, limit: 1, filter: cond(titleOf, "equals", "fat 00001") }),
          ),
          "databases.maxQueryResponseBytes",
        );
      }),
    ),
  );

  it.effect("serves a 10,000-row source in windows through indexes, never whole", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { query, spaceId, dataSourceId } = yield* seed(dbPath);
        yield* bulkRows({ dbPath, dataSourceId, spaceId, count: 10_000, prefix: "Big" });
        const filter: C.SpaceFilter = {
          and: [
            cond(ids.points, "greater_than_or_equal_to", 900),
            cond(ids.prio, "equals", options.low),
          ],
        };
        const sorts = [desc(ids.points)];
        const statements: [string, readonly unknown[]][] = [];
        const observe: Statement.Transformer = (statement) => {
          statements.push([...statement.compile()] as [string, readonly unknown[]]);
          return Effect.succeed(statement);
        };
        const expected = yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{
              readonly n: number;
            }>`SELECT COUNT(*) AS n FROM spaces_db_cells a
              JOIN spaces_db_cells b ON b.page_id = a.page_id AND b.property_id = 'prio01' AND b.ref = 'low01'
              JOIN spaces_pages p ON p.page_id = a.page_id AND p.row_template = 0
              WHERE a.property_id = 'points' AND a.num >= 900 AND a.data_source_id = ${dataSourceId}`;
            return row!.n;
          }),
        );
        const first = yield* query({ filter, sorts, limit: 50, include: { total: true } }).pipe(
          Effect.provideService(Statement.CurrentTransformer, observe),
        );
        assert.equal(first.total, expected);
        assert.isAbove(expected, 50);
        assert.lengthOf(first.rows, 50);
        assert.isNotNull(first.nextCursor);
        assert.isAtMost(Buffer.byteLength(JSON.stringify(first), "utf8"), 262_144);
        // Walk the whole filtered set: windows only, each row once, in sort order.
        const points: number[] = first.rows.map((row) => Number(row.cells.points));
        let cursor: C.SpaceCursor | null = first.nextCursor;
        let count = first.rows.length;
        while (cursor) {
          const next: C.SpaceDatabaseQueryResult = yield* query({
            filter,
            sorts,
            limit: 50,
            cursor,
          });
          assert.isAtMost(next.rows.length, 50);
          points.push(...next.rows.map((row) => Number(row.cells.points)));
          count += next.rows.length;
          cursor = next.nextCursor;
        }
        assert.equal(count, expected);
        assert.deepEqual(
          points,
          [...points].sort((a, b) => b - a),
        );
        // The statements of the first window search the cell table by its key; none scans it.
        assert.isAbove(statements.length, 0);
        const plans: string[] = [];
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const [text, params] of statements) {
              const plan = yield* sql.unsafe<{ readonly detail: string }>(
                `EXPLAIN QUERY PLAN ${text}`,
                params,
              );
              plans.push(...plan.map((row) => row.detail));
            }
          }),
        );
        const scans = plans.filter((detail) => /^SCAN (c|a|b|spaces_db_cells)\b/.test(detail));
        assert.deepEqual(scans, [], plans.join("\n"));
        // Nor may a filter probe the cells by option or target alone: that scans a third of them per row.
        assert.deepEqual(
          plans.filter((detail) => /SEARCH c\b.*\(ref=\?\)/.test(detail)),
          [],
          plans.join("\n"),
        );
        assert.isTrue(
          plans.some((detail) =>
            /SEARCH c USING (COVERING )?INDEX sqlite_autoindex_spaces_db_cells_1 \(page_id=\? AND property_id=\?\)/.test(
              detail,
            ),
          ),
          plans.join("\n"),
        );
        assert.isTrue(
          plans.some((detail) => detail.includes("spaces_pages_rows")),
          plans.join("\n"),
        );

        // Buckets and aggregates are answered in SQL: counts and a few preview rows, not 10,000 rows.
        const grouped = yield* query({
          mode: "groups",
          group: { property: ids.prio },
          rowsPerGroup: 5,
          include: { total: true, aggregates: true },
          aggregates: [{ property: ids.points, function: "sum" }],
        });
        assert.deepEqual(
          (grouped.groups ?? []).map((bucket) => [bucket.count, bucket.rows.length]),
          [
            [3335, 5],
            [3336, 5],
            [3335, 5],
            [1, 1],
          ],
        );
        assert.equal(grouped.total, 10_007);
        let sum = 75;
        for (let i = 1; i <= 10_000; i++) sum += (i * 7919) % 1000;
        assert.equal(grouped.aggregates?.[0]?.number, sum);
      }),
    ),
  );
});

const titleOf = C.SpacePropertyId.make("title");
