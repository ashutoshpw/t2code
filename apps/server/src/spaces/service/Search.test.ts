import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../../serverSettings.ts";
import * as SpacesService from "../SpacesService.ts";
import {
  environmentId,
  env,
  identity,
  block,
  encodeBlockJson,
  bytes,
  fixture,
  boot,
  childPage,
  rootPage,
  moveIntent,
  blockMoveIntent,
  recoveryIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect("admits search backfill bodies using only index and record-header metadata", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, request } = yield* boot();
        const values = Array.from({ length: 101 }, (_, i) => ({
          ...block(`overflow-${String(i).padStart(3, "0")}`, i + 1),
          type: "code",
          content: { text: "overflowneedle " + "x".repeat(32000), language: "" },
        }));
        for (let offset = 0; offset < values.length; offset += 7)
          yield* service.applyBlockBatch(
            request(
              `overflow-seed-${offset}`,
              offset / 7,
              values
                .slice(offset, offset + 7)
                .map((value) => ({ kind: "insert" as const, block: value })),
            ),
          );
        const pages = yield* Effect.flip(service.search({ ...env, query: "overflowneedle" }));
        assert.equal(pages._tag, "SpaceSearchUnavailableError");
        const statements: ReturnType<Statement.Statement<unknown>["compile"]>[] = [];
        const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
          const parent = Option.getOrUndefined(span.parent);
          if (parent?._tag === "Span" && parent.name === "SpacesSearch.advance")
            statements.push(statement.compile());
          return Effect.succeed(statement);
        };
        const pending = yield* Effect.flip(
          service
            .search({ ...env, query: "overflowneedle" })
            .pipe(
              Effect.provideService(Statement.CurrentTransformer, observe),
              Effect.withTracer(Tracer.nativeTracer),
            ),
        );
        assert.equal(pending._tag, "SpaceSearchUnavailableError");
        if (pending._tag === "SpaceSearchUnavailableError")
          assert.equal(pending.reason, "building");
        assert.isNotEmpty(statements);
        const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
        try {
          const payloadColumn = Number(
            db
              .prepare("PRAGMA table_info(spaces_blocks)")
              .all()
              .find((row) => row.name === "payload")!.cid,
          );
          const roots = db
            .prepare(
              "SELECT rootpage,type FROM sqlite_schema WHERE tbl_name='spaces_blocks' AND type IN ('table','index')",
            )
            .all();
          const sourceRoots = new Set(roots.map((row) => Number(row.rootpage)));
          const tableRoot = Number(roots.find((row) => row.type === "table")!.rootpage);
          const sourceQueries = statements.flatMap(([query, params]) => {
            const args = params.map((value) => {
              if (typeof value !== "string" && typeof value !== "number")
                throw new Error("Unexpected backfill parameter");
              return value;
            });
            const ops = db.prepare(`EXPLAIN ${query}`).all(...args);
            if (!ops.some((op) => op.opcode === "OpenRead" && sourceRoots.has(Number(op.p2))))
              return [];
            const cursors = new Set(
              ops
                .filter((op) => op.opcode === "OpenRead" && Number(op.p2) === tableRoot)
                .map((op) => Number(op.p1)),
            );
            const columns = ops.filter(
              (op) => op.opcode === "Column" && cursors.has(Number(op.p1)),
            );
            return [{ query, args, columns }];
          });
          assert.isAbove(sourceQueries.length, 1);
          const header = sourceQueries[0]!;
          const unadmittedLoads = header.columns.filter(
            (op) =>
              Number(op.p2) > payloadColumn ||
              (Number(op.p2) === payloadColumn && (Number(op.p5) & 0xc0) !== 0xc0),
          );
          assert.deepEqual(
            unadmittedLoads.map((op) => ({ column: op.p2, flags: op.p5 })),
            [],
          );
          const headers = db.prepare(header.query).all(...header.args);
          assert.equal(headers.length, 101);
          const bodies = sourceQueries
            .slice(1)
            .filter((source) =>
              source.columns.some(
                (op) => Number(op.p2) === payloadColumn && (Number(op.p5) & 0xc0) !== 0xc0,
              ),
            );
          assert.isAbove(bodies.length, 0);
          assert.isBelow(bodies.length, 101);
          let bodyBytes = 0;
          for (const body of bodies) {
            const rows = db.prepare(body.query).all(...body.args);
            assert.lengthOf(rows, 1);
            const payload = Object.values(rows[0]!).find(
              (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") > 32000,
            );
            assert.isString(payload);
            bodyBytes += Buffer.byteLength(String(payload), "utf8");
          }
          assert.isAtMost(bytes(headers) + bodyBytes, 262144);
          assert.equal(
            db.prepare("SELECT after_id FROM spaces_search_build").get()!.after_id,
            values[bodies.length - 1]!.id,
          );
        } finally {
          db.close();
        }
      }),
    ),
  );

  it.effect(
    "keeps ordinary Spaces writes usable with an unsupported search projection and never scans as fallback",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER spaces_search_insert`;
            yield* sql`DROP TRIGGER spaces_search_update`;
            yield* sql`DROP TRIGGER spaces_search_delete`;
            yield* sql`DROP TABLE spaces_search_fts`;
            yield* sql`UPDATE spaces_search_build SET phase='unsupported'`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          assert.equal(
            (yield* service.applyBlockBatch(
              request("no-fts-write", 0, [{ kind: "insert", block: block("unsupportedneedle") }]),
            )).status,
            "saved",
          );
          assert.equal(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks[0]?.id,
            "unsupportedneedle",
          );
          const error = yield* Effect.flip(service.search({ ...env, query: "unsupportedneedle" }));
          assert.equal(error._tag, "SpaceSearchUnavailableError");
          if (error._tag === "SpaceSearchUnavailableError")
            assert.equal(error.reason, "unsupported");
          assert.isTrue((yield* service.getCapability(environmentId))?.features?.search);
        }),
      ),
  );

  it.effect(
    "consumes at most 500 search candidates before filtering and advances an empty page",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, request, library } = yield* boot();
          yield* Effect.flip(service.search({ ...env, query: "candidateword" }));
          yield* service.search({ ...env, query: "candidateword" });
          for (let offset = 0; offset < 500; offset += 100)
            yield* service.applyBlockBatch(
              request(
                `candidate-seed-${offset}`,
                offset / 100,
                Array.from({ length: 100 }, (_, i) => ({
                  kind: "insert" as const,
                  block: {
                    ...block(`candidate-${offset + i}`, offset + i + 1),
                    content: { runs: [{ text: "candidateword", marks: [] }] },
                  },
                })),
              ),
            );
          const visible = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "candidate-visible",
          );
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "candidate-last",
            pageId: visible.id,
            baseRevision: 0,
            generation: 0,
            mutations: [
              {
                kind: "insert",
                block: {
                  ...block("candidate-live"),
                  content: { runs: [{ text: "candidateword", marks: [] }] },
                },
              },
            ],
          });
          yield* service.trashPage(
            yield* recoveryIntent(service, common, page.id, "trash", "candidate-hide"),
          );
          const first = yield* service.search({ ...env, query: "candidateword" });
          assert.deepEqual(first.items, []);
          assert.isNotNull(first.nextCursor);
          const next = yield* service.search({
            ...env,
            query: "candidateword",
            cursor: first.nextCursor!,
          });
          assert.deepEqual(
            next.items.map((row) => row.blockId),
            [C.SpaceBlockId.make("candidate-live")],
          );
          assert.isNull(next.nextCursor);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const plan = yield* sql<{
              readonly detail: string;
            }>`EXPLAIN QUERY PLAN SELECT rowid FROM spaces_search_fts WHERE spaces_search_fts MATCH '"candidateword"' AND rowid>0 ORDER BY rowid LIMIT 500`;
            assert.isTrue(plan.some((row) => /VIRTUAL TABLE INDEX/.test(row.detail)));
            assert.isFalse(plan.some((row) => /TEMP B-TREE/.test(row.detail)));
            const titlePlan = yield* sql<{
              readonly detail: string;
            }>`EXPLAIN QUERY PLAN SELECT page_id FROM spaces_pages WHERE page_id>'a' ORDER BY page_id LIMIT 101`;
            const blockPlan = yield* sql<{
              readonly detail: string;
            }>`EXPLAIN QUERY PLAN SELECT block_id FROM spaces_blocks WHERE block_id>'a' ORDER BY block_id LIMIT 101`;
            assert.isTrue(
              [...titlePlan, ...blockPlan].every((row) => /SEARCH .* INDEX/.test(row.detail)),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }),
      ),
  );

  it.effect(
    "bounds search projection bytes before fetching snippets and resumes without losing matches",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request } = yield* boot();
          yield* Effect.flip(service.search({ ...env, query: "byteword" }));
          yield* service.search({ ...env, query: "byteword" });
          const values = Array.from({ length: 40 }, (_, i) => ({
            ...block(`search-byte-${i}`, i + 1),
            type: "code",
            content: { text: "byteword " + "x".repeat(32000), language: "" },
          }));
          for (let offset = 0; offset < values.length; offset += 7)
            yield* service.applyBlockBatch(
              request(
                `search-byte-seed-${offset}`,
                offset / 7,
                values
                  .slice(offset, offset + 7)
                  .map((value) => ({ kind: "insert" as const, block: value })),
              ),
            );
          const first = yield* service.search({ ...env, query: "byteword" });
          assert.isAbove(first.items.length, 1);
          assert.isBelow(first.items.length, 40);
          assert.isNotNull(first.nextCursor);
          assert.isTrue(first.items.every((row) => bytes(row.snippet) === 512));
          const next = yield* service.search({
            ...env,
            query: "byteword",
            cursor: first.nextCursor!,
          });
          assert.isNull(next.nextCursor);
          assert.deepEqual(
            [...first.items, ...next.items].map((row) => row.blockId),
            values.map((value) => value.id),
          );
          assert.isAtMost(bytes(first), 65_536);
        }),
      ),
  );

  it.effect("bounds search responses independently of candidate and row limits", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, request, common, page } = yield* boot();
        yield* service.updatePage({
          ...common,
          pageId: page.id,
          mutationId: "response-title",
          baseRevision: 0,
          title: "界".repeat(130),
        });
        yield* Effect.flip(service.search({ ...env, query: "responseword" }));
        yield* service.search({ ...env, query: "responseword" });
        const values = Array.from({ length: 51 }, (_, i) => ({
          ...block(`response-${String(i).padStart(3, "0")}-` + "x".repeat(100), i + 1),
          type: "code",
          content: { text: "responseword " + "x".repeat(600), language: "" },
        }));
        yield* service.applyBlockBatch(
          request(
            "response-seed",
            1,
            values.map((value) => ({ kind: "insert" as const, block: value })),
          ),
        );
        const first = yield* service.search({ ...env, query: "responseword" });
        assert.isAbove(first.items.length, 1);
        assert.isBelow(first.items.length, 50);
        assert.isAtMost(bytes(first), 65_536);
        assert.isNotNull(first.nextCursor);
        const gap = 65_536 - bytes(first);
        const extraTitle = Math.floor(gap / first.items.length) + 1;
        const excess = extraTitle * first.items.length - gap;
        const text = "responseword " + "x".repeat(510 - excess - "responseword ".length);
        yield* service.updatePage({
          ...common,
          pageId: page.id,
          mutationId: "response-exact-title",
          baseRevision: 2,
          title: "界".repeat(130) + "x".repeat(extraTitle),
        });
        yield* service.applyBlockBatch(
          request("response-exact-body", 3, [
            { kind: "replace", block: { ...values[0]!, content: { text, language: "" } } },
          ]),
        );
        const exact = yield* service.search({ ...env, query: "responseword" });
        assert.equal(bytes(exact), 65_536);
        assert.equal(exact.items.length, first.items.length);
        yield* service.applyBlockBatch(
          request("response-plus-one", 4, [
            {
              kind: "replace",
              block: { ...values[0]!, content: { text: text + "x", language: "" } },
            },
          ]),
        );
        const over = yield* service.search({ ...env, query: "responseword" });
        assert.equal(over.items.length, exact.items.length - 1);
        assert.isAtMost(bytes(over), 65_536);
        assert.isNotNull(over.nextCursor);
        const next = yield* service.search({
          ...env,
          query: "responseword",
          cursor: over.nextCursor!,
        });
        assert.deepEqual(
          [...over.items, ...next.items].map((row) => row.blockId),
          values.map((value) => value.id),
        );
        assert.isNull(next.nextCursor);
      }),
    ),
  );

  it.effect(
    "indexes only known current title, run, code and caption text with literal FTS queries",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, request, page, common } = yield* boot();
          const values: C.SpaceBlock[] = [
            {
              ...block("search-runs"),
              content: { runs: [{ text: "Café 界 needle", marks: [] }] },
              futureSecret: "unindexedsecret",
            },
            {
              ...block("search-code", 2),
              type: "code",
              content: { text: "console needle OR NOT NEAR", language: "unindexedlanguage" },
            },
          ];
          yield* service.applyBlockBatch(
            request(
              "search-seed",
              0,
              values.map((value) => ({ kind: "insert" as const, block: value })),
            ),
          );
          const caption = {
            ...block("search-caption", 3),
            type: "image",
            content: { assetId: "fixture-asset", caption: [{ text: "captionneedle", marks: [] }] },
          };
          const opaque = {
            ...block("search-opaque", 4),
            type: "future-chart",
            content: { text: "unindexedsecret" },
          };
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const value of [caption, opaque]) {
              const payload = yield* encodeBlockJson(value);
              yield* sql`INSERT INTO spaces_ids(id,kind) VALUES(${value.id},'block')`;
              yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes) VALUES(${value.id},${page.id},NULL,${value.order},${payload},${bytes(value)})`;
            }
            yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES(${caption.id},'fixture-asset')`;
            yield* sql`UPDATE spaces_pages SET block_count=block_count+2,block_bytes=block_bytes+${bytes(caption) + bytes(opaque)} WHERE page_id=${page.id}`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const pending = yield* Effect.flip(service.search({ ...env, query: "needle" }));
          assert.equal(pending._tag, "SpaceSearchUnavailableError");
          if (pending._tag === "SpaceSearchUnavailableError")
            assert.equal(pending.reason, "building");
          const found = yield* service.search({ ...env, query: "needle" });
          assert.deepEqual(
            found.items.map((item) => item.blockId),
            [values[0]!.id, values[1]!.id],
          );
          assert.deepEqual(
            found.items.map((item) => item.snippet),
            ["Café 界 needle", "console needle OR NOT NEAR"],
          );
          assert.equal(
            (yield* service.search({ ...env, query: "cafe 界" })).items[0]?.blockId,
            values[0]!.id,
          );
          assert.equal(
            (yield* service.search({ ...env, query: "captionneedle" })).items[0]?.blockId,
            caption.id,
          );
          assert.deepEqual((yield* service.search({ ...env, query: "unindexedsecret" })).items, []);
          assert.deepEqual(
            (yield* service.search({ ...env, query: "unindexedlanguage" })).items,
            [],
          );
          assert.equal(
            (yield* service.search({ ...env, query: "OR" })).items[0]?.blockId,
            values[1]!.id,
          );
          for (const query of [
            '"',
            "*",
            "NEAR(needle)",
            "needle OR missing",
            "text:needle",
            "-needle",
            '" OR "',
          ])
            yield* service.search({ ...env, query });
          const title = yield* service.updatePage({
            ...common,
            mutationId: "search-title",
            pageId: page.id,
            baseRevision: 1,
            title: "newtitleneedle",
          });
          assert.equal(title.status, "saved");
          const byTitle = yield* service.search({ ...env, query: "newtitleneedle" });
          assert.equal(byTitle.items[0]?.page.id, page.id);
          assert.isUndefined(byTitle.items[0]?.blockId);
          assert.deepEqual((yield* service.search({ ...env, query: "Page" })).items, []);
        }),
      ),
  );

  it.effect("sets, keeps and clears a page icon and surfaces it in search", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const set = yield* service.updatePage({
          ...common,
          mutationId: "icon-set",
          pageId: page.id,
          baseRevision: page.revision,
          title: "Iconpage",
          icon: "🚀",
        });
        assert.equal(set.status, "saved");
        if (set.status !== "saved") return;
        assert.equal(set.page.icon, "🚀");
        assert.equal(set.page.revision, page.revision + 1);

        const renamed = yield* service.updatePage({
          ...common,
          mutationId: "icon-keep",
          pageId: page.id,
          baseRevision: set.page.revision,
          title: "Iconpage2",
        });
        assert.equal(renamed.status === "saved" && renamed.page.icon, "🚀");
        const pending = yield* Effect.flip(service.search({ ...env, query: "Iconpage2" }));
        assert.equal(pending._tag, "SpaceSearchUnavailableError");
        assert.equal(
          (yield* service.search({ ...env, query: "Iconpage2" })).items[0]?.page.icon,
          "🚀",
        );

        const same = yield* service.updatePage({
          ...common,
          mutationId: "icon-same",
          pageId: page.id,
          baseRevision: renamed.status === "saved" ? renamed.page.revision : 0,
          title: "Iconpage2",
          icon: "🚀",
        });
        assert.equal(
          same.status === "saved" && same.page.revision,
          renamed.status === "saved" ? renamed.page.revision : -1,
        );

        for (const icon of ["hello", " ", "🚀🚀", "\n", "🚀\u0000"]) {
          const rejected = yield* Effect.flip(
            service.updatePage({
              ...common,
              mutationId: "icon-bad",
              pageId: page.id,
              baseRevision: same.status === "saved" ? same.page.revision : 0,
              title: "Iconpage2",
              icon,
            }),
          );
          assert.equal(rejected._tag, "SpaceValidationError");
        }

        const cleared = yield* service.updatePage({
          ...common,
          mutationId: "icon-clear",
          pageId: page.id,
          baseRevision: same.status === "saved" ? same.page.revision : 0,
          title: "Iconpage2",
          icon: null,
        });
        assert.equal(cleared.status === "saved" && "icon" in cleared.page, false);
      }),
    ),
  );

  it.effect(
    "keeps search document identity and current locations through edits, moves and recovery",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, request, common, page, library } = yield* boot();
          const capability = yield* service.getCapability(environmentId);
          assert.equal(capability?.version, 2);
          assert.deepEqual(capability?.features, {
            pins: true,
            recents: true,
            assetList: true,
            allPages: true,
            blockMoves: true,
            referenceResolution: true,
            recovery: true,
            search: true,
            assets: true,
            contextCapture: true,
            databases: true,
            databaseChanges: true,
            pageChanges: true,
            tabs: true,
            syncedBlocks: true,
            comments: true,
            databaseHideTitle: true,
          });
          const value = {
            ...block("search-moving"),
            type: "code",
            content: { text: "oldsearchword", language: "" },
          };
          yield* service.applyBlockBatch(
            request("search-moving-seed", 0, [{ kind: "insert", block: value }]),
          );
          const building = yield* Effect.flip(service.search({ ...env, query: "oldsearchword" }));
          assert.equal(building._tag, "SpaceSearchUnavailableError");
          if (building._tag === "SpaceSearchUnavailableError")
            assert.equal(building.reason, "building");
          yield* service.search({ ...env, query: "oldsearchword" });
          const docs = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT doc_id,source_id,page_id,text FROM spaces_search_docs ORDER BY doc_id`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const initial = yield* docs;
          const edited = { ...value, content: { text: "currentsearchword", language: "" } };
          const input = request("search-moving-edit", 1, [{ kind: "replace", block: edited }]);
          const saved = yield* service.applyBlockBatch(input);
          assert.deepEqual(yield* service.applyBlockBatch(input), saved);
          assert.deepEqual((yield* service.search({ ...env, query: "oldsearchword" })).items, []);
          assert.equal(
            (yield* service.search({ ...env, query: "currentsearchword" })).items[0]?.blockId,
            value.id,
          );
          yield* service.applyBlockBatch(
            request("search-text-away", 2, [
              { kind: "replace", block: { ...block(value.id), type: "divider", content: {} } },
            ]),
          );
          assert.deepEqual(
            (yield* service.search({ ...env, query: "currentsearchword" })).items,
            [],
          );
          yield* service.applyBlockBatch(
            request("search-text-back", 3, [{ kind: "replace", block: edited }]),
          );
          const child = yield* childPage(service, common, page.id, "search-child");
          yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              page.id,
              [value.id],
              { pageId: child.page.id, parentId: null, beforeBlockId: null },
              "search-block-move",
            ),
          );
          const other = yield* service.createSpace({
            ...common,
            mutationId: "search-space",
            title: "Other",
          });
          yield* service.movePage(
            yield* moveIntent(service, common, child.page.id, "search-page-move", {
              kind: "root",
              spaceId: other.space.id,
              beforePageId: null,
            }),
          );
          const moved = yield* service.search({ ...env, query: "currentsearchword" });
          assert.equal(moved.items[0]?.page.id, child.page.id);
          assert.deepEqual(moved.items[0]?.page.location, {
            kind: "root",
            spaceId: other.space.id,
            order: moved.items[0]!.page.rootOrder!,
          });
          assert.deepEqual(
            (yield* service.search({
              ...env,
              spaceId: library.defaultSpaceId,
              query: "currentsearchword",
            })).items,
            [],
          );
          yield* service.trashPage(
            yield* recoveryIntent(service, common, child.page.id, "trash", "search-trash"),
          );
          assert.deepEqual(
            (yield* service.search({ ...env, query: "currentsearchword" })).items,
            [],
          );
          yield* service.restorePage(
            yield* recoveryIntent(service, common, child.page.id, "restore", "search-restore"),
          );
          assert.equal(
            (yield* service.search({ ...env, query: "currentsearchword" })).items[0]?.page.spaceId,
            other.space.id,
          );
          const current = yield* docs;
          assert.equal(
            current.find((row) => row.source_id === value.id)?.doc_id,
            initial.find((row) => row.source_id === value.id)?.doc_id,
          );
          yield* service.trashPage(
            yield* recoveryIntent(service, common, child.page.id, "trash", "search-trash-again"),
          );
          yield* service.permanentlyDeletePage(
            yield* recoveryIntent(
              service,
              common,
              child.page.id,
              "permanentlyDelete",
              "search-purge",
            ),
          );
          assert.deepEqual(
            (yield* service.search({ ...env, query: "currentsearchword" })).items,
            [],
          );
          assert.isFalse(
            (yield* docs).some(
              (row) => row.source_id === value.id || row.source_id === child.page.id,
            ),
          );
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: value.id },
            }),
            { status: "deleted" },
          );
        }),
      ),
  );

  it.effect(
    "persists bounded search backfill across restart and keeps writes behind its cursor",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-search-backfill-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const live = () =>
          SpacesService.layerFromPath(dbPath).pipe(
            Layer.provide(identity),
            Layer.provide(Settings.layerTest({ spacesEnabled: true })),
          );
        const first = yield* Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            let total = 0;
            for (let i = 0; i < 220; i++) {
              const value =
                i < 200
                  ? {
                      ...block(`legacy-${String(i).padStart(3, "0")}`, i + 1),
                      content: { runs: [{ text: "legacyword", marks: [] }] },
                    }
                  : {
                      ...block(`legacy-${String(i).padStart(3, "0")}`, i + 1),
                      type: "code",
                      content: { text: "legacyword " + "x".repeat(32000), language: "" },
                    };
              const payload = yield* encodeBlockJson(value);
              total += bytes(value);
              yield* sql`INSERT INTO spaces_ids(id,kind) VALUES(${value.id},'block')`;
              yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes) VALUES(${value.id},${page.id},NULL,${value.order},${payload},${bytes(value)})`;
            }
            yield* sql`UPDATE spaces_pages SET block_count=220,block_bytes=${total} WHERE page_id=${page.id}`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          for (const phase of ["pages", "blocks"]) {
            const pending = yield* Effect.flip(service.search({ ...env, query: "legacyword" }));
            assert.equal(pending._tag, "SpaceSearchUnavailableError", phase);
          }
          const progress = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT * FROM spaces_search_build`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          assert.deepEqual(progress, [{ singleton: 1, phase: "blocks", after_id: "legacy-099" }]);
          const docIds = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT doc_id,source_id FROM spaces_search_docs ORDER BY doc_id`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          return { common, page, docIds };
        }).pipe(Effect.provide(live()));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`VACUUM`;
          assert.deepEqual(
            yield* sql`SELECT doc_id,source_id FROM spaces_search_docs ORDER BY doc_id`,
            first.docIds,
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const revised = {
            ...block("legacy-000"),
            content: { runs: [{ text: "writerneedle", marks: [] }] },
          };
          yield* service.applyBlockBatch({
            ...first.common,
            pageId: first.page.id,
            mutationId: "search-behind",
            baseRevision: 0,
            generation: 0,
            mutations: [
              { kind: "replace", block: revised },
              { kind: "delete", blockId: C.SpaceBlockId.make("legacy-150") },
              {
                kind: "insert",
                block: {
                  ...block("000-behind"),
                  content: { runs: [{ text: "writerneedle", marks: [] }] },
                },
              },
            ],
          });
          assert.equal(
            (yield* Effect.flip(service.search({ ...env, query: "writerneedle" })))._tag,
            "SpaceSearchUnavailableError",
          );
          for (const after of ["legacy-208", "legacy-216"]) {
            assert.equal(
              (yield* Effect.flip(service.search({ ...env, query: "writerneedle" })))._tag,
              "SpaceSearchUnavailableError",
            );
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              assert.equal(
                (yield* sql`SELECT after_id FROM spaces_search_build`)[0]?.after_id,
                after,
              );
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          }
          const ready = yield* service.search({ ...env, query: "writerneedle" });
          assert.deepEqual(
            ready.items.map((row) => row.blockId),
            [C.SpaceBlockId.make("legacy-000"), C.SpaceBlockId.make("000-behind")],
          );
          const legacy = yield* service.search({ ...env, query: "legacyword", limit: 50 });
          assert.equal(legacy.items.length, 50);
          assert.isNotNull(legacy.nextCursor);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.equal(
              (yield* sql`SELECT count(*) AS n FROM spaces_search_docs WHERE source_id BETWEEN 'legacy-001' AND 'legacy-219'`)[0]
                ?.n,
              218,
            );
            yield* sql`INSERT INTO spaces_search_fts(spaces_search_fts,rank) VALUES('integrity-check',1)`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        }).pipe(Effect.provide(live()));
      }),
  );

  it.effect(
    "bounds literal search queries and binds continuation to query, space and catalog",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, common, page, library } = yield* boot();
          yield* service.applyBlockBatch(
            request(
              "search-cursors",
              0,
              [0, 1, 2].map((n) => ({
                kind: "insert" as const,
                block: {
                  ...block(`search-cursor-${n}`, n + 1),
                  content: { runs: [{ text: "needle", marks: [] }] },
                },
              })),
            ),
          );
          yield* Effect.flip(service.search({ ...env, query: "needle" }));
          const first = yield* service.search({ ...env, query: "needle", limit: 1 });
          assert.isNotNull(first.nextCursor);
          const second = yield* service.search({
            ...env,
            query: "needle",
            cursor: first.nextCursor!,
            limit: 1,
          });
          assert.notEqual(second.items[0]?.blockId, first.items[0]?.blockId);
          for (const change of [{ query: "different" }, { spaceId: library.defaultSpaceId }]) {
            const error = yield* Effect.flip(
              service.search({ ...env, query: "needle", ...change, cursor: first.nextCursor! }),
            );
            assert.equal(error._tag, "SpaceValidationError");
          }
          const exact = "界".repeat(84) + "xx";
          assert.equal(bytes(exact), 256);
          yield* service.search({ ...env, query: exact });
          const over = yield* Effect.flip(service.search({ ...env, query: exact + "x" }));
          assert.equal(over._tag, "SpaceLimitExceededError");
          if (over._tag === "SpaceLimitExceededError")
            assert.deepEqual(
              [over.limit, over.actual, over.maximum],
              ["search.maxQueryBytes", 257, 256],
            );
          yield* service.search({ ...env, query: "a b c d e f g h" });
          const terms = yield* Effect.flip(service.search({ ...env, query: "a b c d e f g h i" }));
          assert.equal(terms._tag, "SpaceLimitExceededError");
          if (terms._tag === "SpaceLimitExceededError")
            assert.equal(terms.limit, "search.maxTerms");
          assert.equal(
            (yield* Effect.flip(service.search({ ...env, query: "  " })))._tag,
            "SpaceValidationError",
          );
          assert.equal(
            (yield* Effect.flip(service.search({ ...env, query: "needle", limit: 51 })))._tag,
            "SpaceLimitExceededError",
          );
          yield* service.updatePage({
            ...common,
            mutationId: "search-catalog",
            pageId: page.id,
            baseRevision: 1,
            title: "Renamed",
          });
          yield* service.search({ ...env, query: "needle", cursor: first.nextCursor! });
          yield* rootPage(service, common, page.spaceId, "search-catalog-root");
          assert.equal(
            (yield* Effect.flip(
              service.search({ ...env, query: "needle", cursor: first.nextCursor! }),
            ))._tag,
            "SpaceCursorStaleError",
          );
        }),
      ),
  );

  it.effect("indexes the text of a synced original on its own page only", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, library, request } = yield* boot();
        const host = yield* rootPage(service, common, library.defaultSpaceId, "search-host");
        const original = {
          ...block("search-original", 1),
          type: "synced_block",
          content: {},
        };
        yield* service.applyBlockBatch(
          request("search-synced", 0, [
            { kind: "insert", block: original },
            {
              kind: "insert",
              block: {
                ...block("search-inside", 1, original.id),
                content: { runs: [{ text: "syncedneedle", marks: [] }] },
              },
            },
          ]),
        );
        yield* service.applyBlockBatch({
          ...common,
          mutationId: C.SpaceMutationId.make("search-copy"),
          pageId: host.id,
          baseRevision: host.revision,
          generation: 0,
          mutations: [
            {
              kind: "insert",
              block: {
                ...block("search-copy", 1),
                type: "synced_ref",
                content: { sourceBlockId: original.id },
              },
            },
          ],
        });
        const pending = yield* Effect.flip(service.search({ ...env, query: "syncedneedle" }));
        assert.equal(pending._tag, "SpaceSearchUnavailableError");
        const found = yield* service.search({ ...env, query: "syncedneedle" });
        assert.deepEqual(
          found.items.map((item) => [item.page.id, item.blockId]),
          [[page.id, C.SpaceBlockId.make("search-inside")]],
        );
      }),
    ),
  );
});
