import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { block, boot, childPage, env, fixture, recoveryIntent } from "./Spaces.testkit.ts";
import { databaseKit, exec, pid, raw } from "./Databases.testkit.ts";

const TEXT = pid("text001");

const setup = Effect.fn("DatabaseSweepTest.setup")(function* (
  dbPath: string,
  options: { readonly rows?: number } = {},
) {
  const { service, common: first, page } = yield* boot();
  const kit = databaseKit(service, first, page.spaceId);
  const created = yield* kit.create("Doomed", {
    appendToPageId: page.id,
    properties: [{ id: TEXT, name: "Text", type: "text" }],
  });
  const rows: C.SpacePageId[] = [];
  const wanted = options.rows ?? 2;
  for (let made = 0; made < wanted; made += 100)
    rows.push(
      ...(yield* kit.addRows(
        created.dataSourceId,
        Array.from({ length: Math.min(100, wanted - made) }, (_, i) => ({
          title: `row ${made + i}`,
        })),
      )).rows.map((row) => row.pageId),
    );
  // A fresh receipt epoch after the clock moved.
  const common = Effect.map(service.listSpaces(env), (library) => ({
    ...env,
    receiptEpoch: library.mutationAdmission.epoch,
  }));
  const mutate = Effect.fn("DatabaseSweepTest.mutate")(function* (
    pageId: C.SpacePageId,
    id: string,
    mutations: readonly C.SpaceBlockMutation[],
  ) {
    const current = yield* service.getPage({ ...env, pageId });
    return yield* service.applyBlockBatch({
      ...(yield* common),
      mutationId: C.SpaceMutationId.make(id),
      pageId,
      baseRevision: current.page.revision,
      generation: 0,
      mutations,
    });
  });
  const databaseBlock = (id: string, viewIds: readonly C.SpaceViewId[] = [created.viewId]) =>
    ({
      ...block(id, 90),
      type: "database",
      content: { databaseId: created.databaseId, viewIds },
    }) as C.SpaceBlock;
  const homeBlockId = created.block?.blockId;
  const kill = (id = "kill") => mutate(page.id, id, [{ kind: "delete", blockId: homeBlockId! }]);
  const adopt = (id: string, pageId = page.id, viewIds?: readonly C.SpaceViewId[]) =>
    mutate(pageId, `adopt-${id}`, [{ kind: "insert", block: databaseBlock(id, viewIds) }]);
  const days = (n: number) => TestClock.adjust(`${n} days`);
  const sweep = () => service.sweepDatabases();
  const state = () =>
    raw(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const count = (rows: readonly { readonly n: number }[]) => rows[0]!.n;
        const [database] = yield* sql<{
          readonly orphaned_at_ms: number | null;
          readonly purge_started_at_ms: number | null;
          readonly home_block_id: string | null;
        }>`SELECT orphaned_at_ms, purge_started_at_ms, home_block_id FROM spaces_db_databases WHERE database_id = ${created.databaseId}`;
        return {
          mark: database!.orphaned_at_ms,
          purging: database!.purge_started_at_ms,
          home: database!.home_block_id,
          pages: count(
            yield* sql<{
              readonly n: number;
            }>`SELECT COUNT(*) AS n FROM spaces_pages WHERE data_source_id = ${created.dataSourceId}`,
          ),
          cells: count(
            yield* sql<{
              readonly n: number;
            }>`SELECT COUNT(*) AS n FROM spaces_db_cells WHERE data_source_id = ${created.dataSourceId}`,
          ),
          views: count(
            yield* sql<{
              readonly n: number;
            }>`SELECT COUNT(*) AS n FROM spaces_db_views WHERE database_id = ${created.databaseId}`,
          ),
          viewMark: (yield* sql<{
            readonly orphaned_at_ms: number | null;
          }>`SELECT orphaned_at_ms FROM spaces_db_views WHERE database_id = ${created.databaseId} ORDER BY view_id LIMIT 1`)[0]
            ?.orphaned_at_ms,
        };
      }),
    );
  return {
    service,
    kit,
    page,
    created,
    rows,
    common,
    mutate,
    kill,
    adopt,
    days,
    sweep,
    state,
    dbPath,
    homeBlockId,
  };
});

const databaseLive = (s: Effect.Success<ReturnType<typeof setup>>) =>
  Effect.map(s.kit.get(s.created.databaseId), (got) => got.database.live);

it.layer(NodeServices.layer)("Spaces dead database sweep", (it) => {
  it.effect("never touches a live database", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        for (let i = 0; i < 3; i++) {
          yield* s.days(40);
          assert.isFalse(yield* s.sweep());
        }
        assert.deepEqual(
          { ...(yield* s.state()), pages: undefined, cells: undefined },
          {
            mark: null,
            purging: null,
            home: s.homeBlockId,
            pages: undefined,
            cells: undefined,
            views: 1,
            viewMark: null,
          },
        );
        assert.equal((yield* s.state()).pages, 2);
      }),
    ),
  );

  it.effect("never marks a database whose host page or an ancestor is in the trash", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        const { service } = s;
        const inner = yield* childPage(service, yield* s.common, s.page.id, "inner-host");
        const nested = yield* s.kit.create("Nested", { appendToPageId: inner.page.id });
        yield* service.trashPage(
          yield* recoveryIntent(service, yield* s.common, s.page.id, "trash", "trash-ancestor"),
        );
        yield* service
          .trashPage(
            yield* recoveryIntent(service, yield* s.common, inner.page.id, "trash", "trash-host"),
          )
          .pipe(Effect.ignore);
        for (const age of [1, 31, 31]) {
          yield* s.days(age);
          yield* s.sweep();
        }
        const state = yield* s.state();
        assert.deepEqual([state.mark, state.purging, state.pages], [null, null, 2]);
        const marks = yield* raw(
          s.dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT orphaned_at_ms, purge_started_at_ms FROM spaces_db_databases WHERE database_id = ${nested.databaseId}`;
          }),
        );
        assert.deepEqual(marks, [{ orphaned_at_ms: null, purge_started_at_ms: null }]);
        yield* service.restorePage(
          yield* recoveryIntent(service, yield* s.common, s.page.id, "restore", "restore-ancestor"),
        );
        assert.isTrue(yield* databaseLive(s));
      }),
    ),
  );

  it.effect(
    "marks a dead database, keeps everything for the retention and lets a returning block clear the mark",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const s = yield* setup(dbPath);
          yield* s.kill();
          assert.isFalse(yield* databaseLive(s));
          yield* s.sweep();
          const marked = yield* s.state();
          assert.isNotNull(marked.mark);
          assert.isNotNull(marked.viewMark);
          yield* s.days(29);
          yield* s.sweep();
          const kept = yield* s.state();
          assert.deepEqual(
            [kept.mark, kept.purging, kept.pages, kept.views],
            [marked.mark, null, 2, 1],
          );
          yield* s.mutate(s.page.id, "undo-kill", [
            {
              kind: "insert",
              block: {
                ...block("undo-home", 91),
                type: "database",
                content: { databaseId: s.created.databaseId, viewIds: [s.created.viewId] },
              } as C.SpaceBlock,
            },
          ]);
          const revived = yield* s.state();
          assert.deepEqual([revived.mark, revived.viewMark], [null, null]);
          assert.isTrue(yield* databaseLive(s));
          assert.equal((yield* s.kit.row(s.rows[0]!)).row.page.id, s.rows[0]);
        }),
      ),
  );

  it.effect("keeps a database that a live linked block names and looks again later", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        const other = yield* s.kit.service.createPage({
          ...(yield* s.common),
          mutationId: "other-page",
          spaceId: s.page.spaceId,
          baseRootOrderRevision: (yield* s.kit.service.listPages({
            ...env,
            spaceId: s.page.spaceId,
          })).space.rootOrderRevision,
          title: "Other",
        });
        if (other.status !== "saved") return yield* Effect.die("Expected a page");
        yield* s.mutate(other.page.id, "link", [
          {
            kind: "insert",
            block: {
              ...block("linked", 90),
              type: "database",
              content: { databaseId: s.created.databaseId, viewIds: [] },
            } as C.SpaceBlock,
          },
        ]);
        yield* s.kill();
        yield* s.sweep();
        const first = (yield* s.state()).mark!;
        yield* s.days(31);
        yield* s.sweep();
        const after = yield* s.state();
        assert.deepEqual([after.purging, after.pages], [null, 2]);
        assert.isAbove(after.mark!, first);
      }),
    ),
  );

  it.effect(
    "purges rows in passes of twenty and the views with the last pass, keeping the shell",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const s = yield* setup(dbPath, { rows: 45 });
          yield* s.kill();
          yield* s.sweep();
          yield* s.days(31);
          assert.isTrue(yield* s.sweep());
          assert.deepEqual(
            [(yield* s.state()).purging !== null, (yield* s.state()).pages],
            [true, 45],
          );
          const counts: number[] = [];
          for (let pass = 0; pass < 3; pass++) {
            yield* s.sweep();
            counts.push((yield* s.state()).pages);
          }
          assert.deepEqual(counts, [25, 5, 0]);
          const done = yield* s.state();
          assert.deepEqual([done.cells, done.views], [0, 0]);
          assert.isFalse(yield* s.sweep());
          // The shell stays: the database record answers as not live.
          const got = yield* s.kit.get(s.created.databaseId);
          assert.isFalse(got.database.live);
          assert.lengthOf(got.dataSources, 1);
        }),
      ),
  );

  it.effect("purges a database whose host page was deleted for good", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        yield* s.service.trashPage(
          yield* recoveryIntent(s.service, yield* s.common, s.page.id, "trash", "trash-host"),
        );
        yield* s.service.permanentlyDeletePage(
          yield* recoveryIntent(
            s.service,
            yield* s.common,
            s.page.id,
            "permanentlyDelete",
            "delete-host",
          ),
        );
        yield* s.sweep();
        yield* s.days(31);
        for (let i = 0; i < 3; i++) yield* s.sweep();
        assert.equal((yield* s.state()).pages, 0);
      }),
    ),
  );

  it.effect("treats a database that never had a home like a dead one", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        yield* s.kill();
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE spaces_db_databases SET home_block_id = NULL`;
          }),
        );
        yield* s.sweep();
        const marked = yield* s.state();
        assert.isNull(marked.home);
        assert.isNotNull(marked.mark);
        yield* s.days(29);
        yield* s.sweep();
        assert.deepEqual([(yield* s.state()).purging, (yield* s.state()).pages], [null, 2]);
        yield* s.days(2);
        for (let i = 0; i < 3; i++) yield* s.sweep();
        assert.equal((yield* s.state()).pages, 0);
      }),
    ),
  );

  it.effect("starts a new retention period when a revived database dies again", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        yield* s.kill("kill-1");
        yield* s.sweep();
        yield* s.days(10);
        yield* s.adopt("again-1");
        assert.isNull((yield* s.state()).mark);
        yield* s.days(19);
        const home = (yield* s.state()).home!;
        yield* s.mutate(s.page.id, "kill-2", [
          { kind: "delete", blockId: C.SpaceBlockId.make(home) },
        ]);
        yield* s.sweep();
        const second = (yield* s.state()).mark!;
        yield* s.days(2);
        for (let i = 0; i < 3; i++) yield* s.sweep();
        assert.deepEqual([(yield* s.state()).purging, (yield* s.state()).pages], [null, 2]);
        yield* s.days(27);
        for (let i = 0; i < 3; i++) yield* s.sweep();
        assert.deepEqual([(yield* s.state()).purging, (yield* s.state()).pages], [null, 2]);
        yield* s.days(1);
        for (let i = 0; i < 4; i++) yield* s.sweep();
        const done = yield* s.state();
        assert.equal(done.pages, 0);
        assert.isAbove(done.purging!, second);
      }),
    ),
  );

  it.effect("clears the mark when another block adopts the database during retention", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        yield* s.kill();
        yield* s.sweep();
        assert.isNotNull((yield* s.state()).mark);
        yield* s.days(15);
        yield* s.adopt("adopter");
        assert.isNull((yield* s.state()).mark);
        assert.isTrue(yield* databaseLive(s));
      }),
    ),
  );

  it.effect("never adopts a database whose purge has begun, and the page still saves", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath, { rows: 25 });
        yield* s.kill();
        yield* s.sweep();
        yield* s.days(31);
        yield* s.sweep();
        assert.isNotNull((yield* s.state()).purging);
        const homeBefore = (yield* s.state()).home;
        const saved = yield* s.adopt("late");
        assert.equal(saved.status, "saved");
        const after = yield* s.state();
        assert.equal(after.home, homeBefore);
        assert.isFalse(yield* databaseLive(s));
      }),
    ),
  );

  it.effect("deletes nothing when the database is revived between the two halves", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        yield* s.kill();
        yield* s.sweep();
        yield* s.days(31);
        yield* s.service.sweepDatabases(Effect.asVoid(s.adopt("between")));
        const state = yield* s.state();
        assert.deepEqual([state.mark, state.purging, state.pages, state.views], [null, null, 2, 1]);
        assert.isTrue(yield* databaseLive(s));
      }),
    ),
  );

  it.effect(
    "removes a purged row's sub-pages, blocks and asset references like a user's delete",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const s = yield* setup(dbPath);
          const row = s.rows[0]!;
          const sub = (yield* childPage(s.service, yield* s.common, row, "row-sub")).page.id;
          yield* s.mutate(row, "row-body", [{ kind: "insert", block: block("row-body-block", 1) }]);
          yield* exec(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES ('row-body-block','row-asset')`;
            }),
          );
          yield* s.kill();
          yield* s.sweep();
          yield* s.days(31);
          for (let i = 0; i < 3; i++) yield* s.sweep();
          const left = yield* raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const count = (rows: readonly { readonly n: number }[]) => rows[0]!.n;
              return {
                pages: count(
                  yield* sql<{
                    readonly n: number;
                  }>`SELECT COUNT(*) AS n FROM spaces_pages WHERE page_id IN (${row}, ${sub})`,
                ),
                blocks: count(
                  yield* sql<{
                    readonly n: number;
                  }>`SELECT COUNT(*) AS n FROM spaces_blocks WHERE page_id IN (${row}, ${sub})`,
                ),
                owners: count(
                  yield* sql<{
                    readonly n: number;
                  }>`SELECT COUNT(*) AS n FROM spaces_page_owners WHERE child_page_id IN (${row}, ${sub})`,
                ),
                refs: count(
                  yield* sql<{
                    readonly n: number;
                  }>`SELECT COUNT(*) AS n FROM spaces_block_asset_refs WHERE block_id = 'row-body-block'`,
                ),
                revisions: count(
                  yield* sql<{
                    readonly n: number;
                  }>`SELECT COUNT(*) AS n FROM spaces_revisions WHERE page_id IN (${row}, ${sub})`,
                ),
              };
            }),
          );
          assert.deepEqual(left, { pages: 0, blocks: 0, owners: 0, refs: 0, revisions: 0 });
        }),
      ),
  );

  it.effect("recomputes a live rollup and moves its revision when a purged row was related", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        const live = yield* s.kit.create("Live", {
          appendToPageId: s.page.id,
          properties: [
            {
              id: pid("rel0001"),
              name: "Link",
              type: "relation",
              config: { dataSourceId: s.created.dataSourceId, limit: "many" },
            },
          ],
        });
        const liveRows = (yield* s.kit.addRows(live.dataSourceId, [
          { title: "L1", cells: { rel0001: [s.rows[0]!, s.rows[1]!] } },
        ])).rows;
        yield* s.kit.schema(live.dataSourceId, [
          {
            op: "addProperty",
            property: {
              id: pid("roll001"),
              name: "Count",
              type: "rollup",
              config: {
                relationPropertyId: "rel0001",
                targetPropertyId: "title",
                function: "count_all",
              },
            },
          },
        ]);
        yield* s.service.drainComputed;
        const before = (yield* s.kit.get(live.databaseId)).dataSources[0]!.dataRevision;
        yield* s.kill();
        yield* s.sweep();
        yield* s.days(31);
        for (let i = 0; i < 3; i++) yield* s.sweep();
        yield* s.service.drainComputed;
        const row = yield* s.kit.row(liveRows[0]!.pageId);
        assert.isUndefined(row.row.cells["rel0001"]);
        assert.deepEqual(row.row.cells["roll001"], { type: "number", value: 0 });
        assert.isAbove((yield* s.kit.get(live.databaseId)).dataSources[0]!.dataRevision, before);
      }),
    ),
  );

  it.effect("marks a database inside a purged row on the next pass, not the same one", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        const inner = yield* s.kit.create("Inner", { appendToPageId: s.rows[0]! });
        yield* s.kill();
        yield* s.sweep();
        yield* s.days(31);
        for (let i = 0; i < 3; i++) yield* s.sweep();
        assert.equal((yield* s.state()).pages, 0);
        const marks = () =>
          raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{
                readonly orphaned_at_ms: number | null;
                readonly purge_started_at_ms: number | null;
              }>`SELECT orphaned_at_ms, purge_started_at_ms FROM spaces_db_databases WHERE database_id = ${inner.databaseId}`;
            }),
          );
        const [after] = yield* marks();
        assert.isNotNull(after!.orphaned_at_ms);
        assert.isNull(after!.purge_started_at_ms);
      }),
    ),
  );

  it.effect("deletes an orphan view only when nothing live lists it", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath);
        const second = C.SpaceBlockId.make("second");
        yield* s.mutate(s.page.id, "second-block", [
          {
            kind: "insert",
            block: {
              ...block("second", 95),
              type: "database",
              content: { databaseId: s.created.databaseId, viewIds: [] },
            } as C.SpaceBlock,
          },
        ]);
        const common = yield* s.common;
        const made = (name: string) =>
          s.service.createView({
            ...common,
            mutationId: C.SpaceMutationId.make(`view-${name}`),
            dataSourceId: s.created.dataSourceId,
            name,
            type: "table",
            block: { pageId: s.page.id, blockId: second },
          });
        const lost = (yield* made("lost")).viewId;
        const listed = (yield* made("listed")).viewId;
        yield* s.mutate(s.page.id, "drop-second", [{ kind: "delete", blockId: second }]);
        // Another block lists one of them before the sweep ever marks it.
        yield* s.adopt("lister", s.page.id, [s.created.viewId, listed]);
        yield* s.sweep();
        const marks = () =>
          raw(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              return yield* sql<{
                readonly view_id: string;
                readonly orphaned_at_ms: number | null;
              }>`SELECT view_id, orphaned_at_ms FROM spaces_db_views WHERE view_id IN (${lost}, ${listed}) ORDER BY view_id`;
            }),
          );
        const first = yield* marks();
        assert.isTrue(first.every((entry) => entry.orphaned_at_ms !== null));
        yield* s.days(29);
        yield* s.sweep();
        assert.deepEqual(yield* marks(), first);
        yield* s.days(2);
        yield* s.sweep();
        const left = yield* marks();
        assert.deepEqual(
          left.map((entry) => entry.view_id),
          [listed],
        );
        assert.isAbove(
          left[0]!.orphaned_at_ms!,
          first.find((entry) => entry.view_id === listed)!.orphaned_at_ms!,
        );
      }),
    ),
  );

  it.effect("skips a row whose removal fails and still removes the others", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath, { rows: 5 });
        yield* s.kill();
        yield* s.sweep();
        yield* s.days(31);
        yield* s.sweep();
        // One row's cleanup fails as it would for a body past the cleanup budget.
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TRIGGER stubborn BEFORE DELETE ON spaces_pages WHEN old.title = 'row 2'
              BEGIN SELECT RAISE(ABORT, 'stubborn'); END`;
          }),
        );
        for (let i = 0; i < 3; i++) yield* s.sweep();
        const left = yield* raw(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              readonly title: string;
            }>`SELECT title FROM spaces_pages WHERE data_source_id = ${s.created.dataSourceId}`;
          }),
        );
        assert.deepEqual(
          left.map((row) => row.title),
          ["row 2"],
        );
      }),
    ),
  );

  it.effect("stops purging a row whose removal reports success and leaves the page", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const s = yield* setup(dbPath, { rows: 5 });
        yield* s.kill();
        yield* s.sweep();
        yield* s.days(31);
        yield* s.sweep();
        // The delete of one page is dropped without an error.
        yield* exec(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TRIGGER lingering BEFORE DELETE ON spaces_pages WHEN old.title = 'row 2'
              BEGIN SELECT RAISE(IGNORE); END`;
          }),
        );
        // Every pass that removed something may be followed by another; the row cannot make
        // that go on for ever.
        const passes: boolean[] = [];
        for (let i = 0; i < 3; i++) passes.push(yield* s.sweep());
        assert.deepEqual(passes.slice(1), [false, false]);
        assert.equal((yield* s.state()).pages, 1);
      }),
    ),
  );
});
