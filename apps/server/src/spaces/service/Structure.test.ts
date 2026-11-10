import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  env,
  block,
  bytes,
  fixture,
  boot,
  historyState,
  prepareHistoryDelta,
  structureState,
  childPage,
  rootPage,
  moveIntent,
  blockMoveIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect("refuses a join whose reverse redirect closure exceeds the shared node budget", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, request } = yield* boot();
        const values = Array.from({ length: 99 }, (_, i) => block(`pred-${i}`, i + 1));
        const survivor = block("pred-survivor", 100),
          target = block("pred-target", 101);
        yield* service.applyBlockBatch(
          request(
            "pred-seed",
            0,
            [...values, survivor].map((value) => ({ kind: "insert", block: value })),
          ),
        );
        yield* service.applyBlockBatch(
          request("pred-target-seed", 1, [{ kind: "insert", block: target }]),
        );
        yield* service.applyBlockBatch(
          request(
            "pred-joins",
            2,
            values.map((value) => ({ kind: "delete", blockId: value.id, mergedInto: survivor.id })),
          ),
        );
        const before = yield* structureState(dbPath);
        const error = yield* Effect.flip(
          service.applyBlockBatch(
            request("pred-over", 3, [
              { kind: "delete", blockId: survivor.id, mergedInto: target.id },
            ]),
          ),
        );
        assert.equal(error._tag, "SpaceLimitExceededError");
        if (error._tag === "SpaceLimitExceededError") {
          assert.equal(error.limit, "maxMutationNodes");
          assert.equal(error.actual, 101);
        }
        const after = yield* structureState(dbPath);
        for (const key of [
          "pages",
          "blocks",
          "ids",
          "history",
          "receipts",
          "blockPins",
          "revisionPins",
        ] as const)
          assert.deepEqual(after[key], before[key]);
        assert.equal(after.core[0]!.catalog_revision, before.core[0]!.catalog_revision);
      }),
    ),
  );

  it.effect(
    "creates normalized child pages, materializes authoritative targets, and lists roots or direct children",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const first = yield* childPage(service, common, page.id, "first-child");
          const second = yield* childPage(service, common, page.id, "second-child");
          const grandchild = yield* childPage(service, common, first.page.id, "grandchild");
          assert.isNull(first.page.rootOrder);
          assert.deepEqual(first.page.location, {
            kind: "child",
            spaceId: library.defaultSpaceId,
            parentPageId: page.id,
            ownerBlockId: first.ownerBlockId,
          });
          assert.deepEqual(
            (yield* service.listPages({ ...env, spaceId: library.defaultSpaceId })).items.map(
              (row) => row.id,
            ),
            [page.id],
          );
          const direct = yield* service.listPages({
            ...env,
            spaceId: library.defaultSpaceId,
            parentPageId: page.id,
            limit: 1,
          });
          assert.deepEqual(
            direct.items.map((row) => row.id),
            [first.page.id],
          );
          assert.isNotNull(direct.nextCursor);
          assert.deepEqual(
            (yield* service.listPages({
              ...env,
              spaceId: library.defaultSpaceId,
              parentPageId: page.id,
              limit: 1,
              cursor: direct.nextCursor!,
            })).items.map((row) => row.id),
            [second.page.id],
          );
          assert.deepEqual(
            (yield* service.listPages({
              ...env,
              spaceId: library.defaultSpaceId,
              parentPageId: first.page.id,
            })).items.map((row) => row.id),
            [grandchild.page.id],
          );
          assert.equal(
            (yield* Effect.flip(
              service.listPages({
                ...env,
                spaceId: library.defaultSpaceId,
                parentPageId: first.page.id,
                cursor: direct.nextCursor!,
              }),
            ))._tag,
            "SpaceValidationError",
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [owner] =
              yield* sql`SELECT payload, logical_bytes FROM spaces_blocks WHERE block_id = ${first.ownerBlockId}`;
            const raw = JSON.parse(String(owner!.payload));
            assert.deepEqual(raw.content, {});
            const forged = JSON.stringify({
              ...raw,
              content: { pageId: "forged-page", future: { value: "preserve" } },
              futureEnvelope: [1, 2],
            });
            const logical = Buffer.byteLength(forged, "utf8");
            yield* sql`UPDATE spaces_blocks SET payload = ${forged}, logical_bytes = ${logical} WHERE block_id = ${first.ownerBlockId}`;
            yield* sql`UPDATE spaces_pages SET block_bytes = block_bytes + ${logical - Number(owner!.logical_bytes)} WHERE page_id = ${page.id}`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const parent = (yield* service.getPage({ ...env, pageId: page.id })).page;
          const window = yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: parent.revision,
          });
          assert.deepEqual(window.blocks.find((row) => row.id === first.ownerBlockId)?.content, {
            pageId: first.page.id,
            future: { value: "preserve" },
          });
          const forged = {
            ...block("forged-owner"),
            type: "child_page",
            content: { pageId: first.page.id },
          };
          for (const mutations of [
            [{ kind: "insert" as const, block: forged }],
            [
              {
                kind: "replace" as const,
                block: { ...window.blocks[0]!, content: { pageId: second.page.id } },
              },
            ],
            [{ kind: "delete" as const, blockId: first.ownerBlockId }],
          ]) {
            const error = yield* Effect.flip(
              service.applyBlockBatch(
                request(`forged-${mutations[0]!.kind}`, parent.revision, mutations),
              ),
            );
            assert.equal(error._tag, "SpaceValidationError");
          }
          yield* service.updatePage({
            ...common,
            mutationId: "nested-title",
            pageId: first.page.id,
            baseRevision: 1,
            title: "Renamed child",
          });
          const state = yield* historyState(dbPath);
          const title = state.revisions.find((row) => row.mutation_id === "nested-title")!;
          assert.deepEqual(JSON.parse(title.payload).ownerBefore, {
            childPageId: first.page.id,
            ownerBlockId: first.ownerBlockId,
          });
          assert.isNull(JSON.parse(title.payload).pageBefore.rootOrder);
        }),
      ),
  );

  it.effect(
    "moves root to child to another parent to root without reusing a retired owner marker",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const other = yield* rootPage(service, common, library.defaultSpaceId, "other-parent");
          const moved = yield* rootPage(service, common, library.defaultSpaceId, "moved-page");
          const nest = yield* moveIntent(service, common, moved.id, "nest", {
            kind: "child",
            placement: { pageId: page.id, parentId: null, beforeBlockId: null },
          });
          const first = yield* service.movePage(nest);
          if (first.status !== "saved") return yield* Effect.die("Expected nested page");
          assert.isNotNull(first.ownerBlockId);
          assert.equal(first.page.id, moved.id);
          assert.equal(first.page.revision, 1);
          assert.deepEqual(yield* service.movePage(nest), first);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [old] =
              yield* sql`SELECT payload,logical_bytes FROM spaces_blocks WHERE block_id = ${first.ownerBlockId}`;
            const payload = JSON.stringify({
              ...JSON.parse(String(old!.payload)),
              version: 2,
              content: ["opaque", { future: "界" }],
              futureEnvelope: { preserve: true },
            });
            const logical = Buffer.byteLength(payload, "utf8");
            yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${logical} WHERE block_id=${first.ownerBlockId}`;
            yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${logical - Number(old!.logical_bytes)} WHERE page_id=${page.id}`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

          const secondInput = yield* moveIntent(service, common, moved.id, "other", {
            kind: "child",
            placement: { pageId: other.id, parentId: null, beforeBlockId: null },
          });
          const second = yield* service.movePage(secondInput);
          if (second.status !== "saved") return yield* Effect.die("Expected moved child");
          assert.equal(second.ownerBlockId, first.ownerBlockId);
          const movedBody = yield* service.readBlocks({
            ...env,
            pageId: other.id,
            revision: (yield* service.getPage({ ...env, pageId: other.id })).page.revision,
          });
          assert.deepEqual(movedBody.blocks[0]!.content, ["opaque", { future: "界" }]);
          assert.deepEqual(movedBody.blocks[0]!.futureEnvelope, { preserve: true });

          assert.equal(second.page.revision, 2);
          assert.equal(second.page.location?.kind, "child");
          if (second.page.location?.kind === "child")
            assert.equal(second.page.location.parentPageId, other.id);
          const promoted = yield* service.movePage(
            yield* moveIntent(service, common, moved.id, "promote", {
              kind: "root",
              spaceId: library.defaultSpaceId,
              beforePageId: other.id,
            }),
          );
          if (promoted.status !== "saved") return yield* Effect.die("Expected root");
          assert.isNull(promoted.ownerBlockId);
          assert.equal(promoted.page.revision, 3);
          assert.isNotNull(promoted.page.rootOrder);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(
              yield* sql`SELECT * FROM spaces_page_owners WHERE child_page_id = ${moved.id}`,
              [],
            );
            assert.equal(
              (yield* sql`SELECT deleted FROM spaces_ids WHERE id = ${first.ownerBlockId}`)[0]
                ?.deleted,
              1,
            );
            assert.equal(
              (yield* sql`SELECT kind FROM spaces_ids WHERE id = ${first.ownerBlockId}`)[0]?.kind,
              "block",
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const again = yield* service.movePage(
            yield* moveIntent(service, common, moved.id, "nest-again", {
              kind: "child",
              placement: { pageId: page.id, parentId: null, beforeBlockId: null },
            }),
          );
          if (again.status !== "saved") return yield* Effect.die("Expected nested page");
          assert.notEqual(again.ownerBlockId, first.ownerBlockId);
          assert.equal(again.page.id, moved.id);
          const before = yield* historyState(dbPath);
          const noop = yield* service.movePage(
            yield* moveIntent(service, common, moved.id, "no-op-move", {
              kind: "child",
              placement: { pageId: page.id, parentId: null, beforeBlockId: null },
            }),
          );
          assert.equal(noop.status, "saved");
          if (noop.status === "saved") assert.deepEqual(noop.changed, { pages: [], roots: [] });
          assert.deepEqual(yield* historyState(dbPath), before);
        }),
      ),
  );

  it.effect(
    "conflicts on incomplete or stale structural guards and rejects irrelevant guards, cycles, and non-list parents",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const child = yield* childPage(service, common, page.id, "guard-child");
          const descendant = yield* childPage(service, common, child.page.id, "guard-descendant");
          const other = yield* rootPage(service, common, library.defaultSpaceId, "guard-other");
          const input = yield* moveIntent(service, common, child.page.id, "stale-structure", {
            kind: "child",
            placement: { pageId: other.id, parentId: null, beforeBlockId: null },
          });
          assert.isTrue(input.guards.pages.some((row) => row.pageId === descendant.page.id));
          yield* service.updatePage({
            ...common,
            mutationId: "changed-descendant",
            pageId: descendant.page.id,
            baseRevision: 0,
            title: "Changed",
          });
          const before = yield* historyState(dbPath);
          assert.equal((yield* service.movePage(input)).status, "conflict");
          const fresh = yield* moveIntent(
            service,
            common,
            child.page.id,
            "missing-structure",
            input.destination,
          );
          assert.equal(
            (yield* service.movePage({
              ...fresh,
              guards: {
                ...fresh.guards,
                pages: fresh.guards.pages.filter((row) => row.pageId !== descendant.page.id),
              },
            })).status,
            "conflict",
          );
          for (const pages of [
            [...fresh.guards.pages, fresh.guards.pages[0]!],
            [...fresh.guards.pages, { pageId: "irrelevant", revision: 0 }],
          ]) {
            assert.equal(
              (yield* Effect.flip(
                service.movePage({
                  ...fresh,
                  mutationId: `invalid-${pages.length}-${pages.at(-1)!.pageId}`,
                  guards: { ...fresh.guards, pages },
                }),
              ))._tag,
              "SpaceValidationError",
            );
          }
          const cycle = {
            kind: "child" as const,
            placement: { pageId: descendant.page.id, parentId: null, beforeBlockId: null },
          };
          assert.equal(
            (yield* Effect.flip(
              service.movePage({ ...fresh, mutationId: "cycle-structure", destination: cycle }),
            ))._tag,
            "SpaceValidationError",
          );
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "paragraph-parent",
            pageId: other.id,
            baseRevision: 0,
            generation: 0,
            mutations: [{ kind: "insert", block: block("not-a-list") }],
          });
          assert.equal(
            (yield* Effect.flip(
              service.inspectStructure({
                ...env,
                target: { kind: "page", pageId: child.page.id },
                destination: {
                  kind: "child",
                  placement: { pageId: other.id, parentId: "not-a-list", beforeBlockId: null },
                },
              }),
            ))._tag,
            "SpaceValidationError",
          );
          const after = yield* historyState(dbPath);
          assert.deepEqual(
            after.revisions.filter((row) => row.page_id !== other.id),
            before.revisions.filter((row) => row.page_id !== other.id),
          );
          assert.equal(
            (yield* service.getPage({ ...env, pageId: child.page.id })).page.location?.kind,
            "child",
          );
        }),
      ),
  );

  it.effect(
    "moves a complete subtree with a 32MiB body at the shared node boundary and refuses node101 whole",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          let revision = 0;
          for (let start = 0; start < 1023; start += 7) {
            const values = Array.from({ length: Math.min(7, 1023 - start) }, (_, i) => {
              const base = {
                ...block(`unchanged-${start + i}`, start + i + 1),
                type: "code",
                content: { language: "", text: "" },
                futureEnvelope: { preserve: true },
              };
              return {
                ...base,
                content: { ...base.content, text: "x".repeat(32_768 - bytes(base)) },
              };
            });
            yield* service.applyBlockBatch({
              ...common,
              pageId: page.id,
              mutationId: `body-${start}`,
              baseRevision: revision++,
              generation: 0,
              mutations: values.map((value) => ({ kind: "insert", block: value })),
            });
          }
          const children: C.SpacePageId[] = [];
          for (let i = 0; i < 32; i++)
            children.push((yield* childPage(service, common, page.id, `subtree-${i}`)).page.id);
          const destination = yield* service.createSpace({
            ...common,
            mutationId: "other-space",
            title: "Other",
          });
          yield* rootPage(service, common, destination.space.id, "destination-anchor");
          const input = yield* moveIntent(service, common, page.id, "cross-space", {
            kind: "root",
            spaceId: destination.space.id,
            beforePageId: null,
          });
          assert.equal(input.guards.pages.length, 34);
          assert.equal(input.guards.roots.length, 2);
          const moved = yield* service.movePage(input);
          if (moved.status !== "saved") return yield* Effect.die("Expected subtree move");
          assert.equal(moved.changed.pages.length, 33);
          for (const id of [page.id, ...children])
            assert.equal(
              (yield* service.getPage({ ...env, pageId: id })).page.spaceId,
              destination.space.id,
            );
          assert.deepEqual(
            (yield* service.listPages({ ...env, spaceId: library.defaultSpaceId })).items,
            [],
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.equal(
              (yield* sql`SELECT COUNT(*) AS n FROM spaces_blocks WHERE page_id = ${page.id} AND block_id LIKE 'unchanged-%'`)[0]
                ?.n,
              1023,
            );
            assert.equal(
              (yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id = 'unchanged-0'`)[0]
                ?.logical_bytes,
              32_768,
            );
            const plan =
              yield* sql`EXPLAIN QUERY PLAN SELECT b.block_id,o.child_page_id FROM spaces_blocks b LEFT JOIN spaces_page_owners o ON o.owner_block_id=b.block_id WHERE b.page_id=${page.id} AND b.deleted=0 AND json_extract(b.payload,'$.type')='child_page' ORDER BY b.rank,b.block_id LIMIT 100`;
            const indexUse = plan
              .map((row) => String(row.detail))
              .map((detail) => /SEARCH b USING (?:COVERING )?INDEX (\S+)/.exec(detail))
              .find((match) => match !== null);
            assert.isDefined(indexUse);
            const indexes = yield* sql`PRAGMA index_list('spaces_blocks')`;
            assert.equal(indexes.find((row) => row.name === indexUse![1])?.partial, 1);
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          yield* childPage(service, common, page.id, "subtree-32");
          const snapshot = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              pages:
                yield* sql`SELECT page_id,space_id,root_order,revision,block_count,block_bytes FROM spaces_pages ORDER BY page_id`,
              owners: yield* sql`SELECT * FROM spaces_page_owners ORDER BY child_page_id`,
              ids: yield* sql`SELECT id FROM spaces_ids ORDER BY id`,
              receipts: yield* sql`SELECT mutation_id FROM spaces_receipts ORDER BY mutation_id`,
            };
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const before = yield* snapshot;
          const rejected = {
            ...input,
            mutationId: "node-101",
            destination: { kind: "root", spaceId: library.defaultSpaceId, beforePageId: null },
          };
          const error = yield* Effect.flip(service.movePage(rejected));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") {
            assert.equal(error.limit, "maxMutationNodes");
            assert.equal(error.actual, 101);
          }
          assert.deepEqual(yield* snapshot, before);
        }),
      ),
  );

  it.effect("bounds page and marker-list depth independently at sixteen", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        let deepest = page.id;
        let penultimate = page.id;
        for (let depth = 2; depth <= 16; depth++) {
          penultimate = deepest;
          deepest = (yield* childPage(service, common, deepest, `depth-${depth}`)).page.id;
        }
        const ordinary = block("depth16-ordinary");
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "depth16-seed",
          pageId: deepest,
          baseRevision: 0,
          generation: 0,
          mutations: [{ kind: "insert", block: ordinary }],
        });
        const target = { kind: "blocks" as const, pageId: deepest, blockIds: [ordinary.id] };
        const placement = { pageId: deepest, parentId: null, beforeBlockId: null };
        const sourcePlan = yield* service.inspectStructure({ ...env, target });
        const noopInput = {
          ...common,
          mutationId: "depth16-noop",
          sourcePageId: deepest,
          blockIds: [ordinary.id],
          destination: placement,
          guards: sourcePlan.guards,
        };
        const original = yield* structureState(dbPath);
        const inspectionError = yield* service
          .inspectStructure({ ...env, target, destination: { kind: "child", placement } })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
        const noop = yield* service.moveBlocks(noopInput).pipe(
          Effect.match({
            onFailure: (error) => ({ kind: "error" as const, error }),
            onSuccess: (result) => ({ kind: "result" as const, result }),
          }),
        );
        assert.deepEqual(
          [inspectionError, noop.kind === "error" ? noop.error : null],
          [null, null],
        );
        if (noop.kind !== "result" || noop.result.status !== "saved")
          return yield* Effect.die("Expected saved depth16 no-op");
        assert.deepEqual(noop.result.changed, { pages: [], roots: [] });
        const unchanged = yield* structureState(dbPath);
        for (const key of [
          "spaces",
          "pages",
          "blocks",
          "owners",
          "ids",
          "history",
          "blockPins",
          "revisionPins",
        ] as const)
          assert.deepEqual(unchanged[key], original[key]);
        assert.equal(unchanged.core[0]!.catalog_revision, original.core[0]!.catalog_revision);
        assert.equal(unchanged.receipts.length, original.receipts.length + 1);
        assert.equal(unchanged.core[0]!.receipt_rows, Number(original.core[0]!.receipt_rows) + 1);
        assert.deepEqual(
          yield* service.lookupMutationReceipt({
            request: { operation: "moveBlocks", input: noopInput },
          }),
          { status: "found", receipt: { operation: "moveBlocks", result: noop.result } },
        );
        assert.deepEqual(yield* service.moveBlocks(noopInput), noop.result);
        assert.deepEqual(yield* structureState(dbPath), unchanged);

        const out = yield* service.moveBlocks(
          yield* blockMoveIntent(
            service,
            common,
            deepest,
            [ordinary.id],
            { pageId: penultimate, parentId: null, beforeBlockId: null },
            "depth16-out",
          ),
        );
        assert.equal(out.status, "saved");
        const back = yield* service.moveBlocks(
          yield* blockMoveIntent(
            service,
            common,
            penultimate,
            [ordinary.id],
            placement,
            "depth16-back",
          ),
        );
        if (back.status !== "saved") return yield* Effect.die("Expected move into depth16 page");
        assert.equal(back.changed.pages.length, 2);
        const body = yield* service.readBlocks({
          ...env,
          pageId: deepest,
          revision: (yield* service.getPage({ ...env, pageId: deepest })).page.revision,
        });
        assert.equal(body.blocks[0]!.id, ordinary.id);
        assert.deepEqual(body.blocks[0]!.content, ordinary.content);

        const owned = yield* childPage(service, common, penultimate, "depth16-owned");
        const ownedBefore = yield* structureState(dbPath);
        const overflows = [
          service
            .inspectStructure({
              ...env,
              target: { kind: "blocks", pageId: penultimate, blockIds: [owned.ownerBlockId] },
              destination: { kind: "child", placement },
            })
            .pipe(Effect.asVoid),
          service
            .moveBlocks({
              ...common,
              mutationId: "owned-depth17",
              sourcePageId: penultimate,
              blockIds: [owned.ownerBlockId],
              destination: placement,
              guards: { pages: [], roots: [] },
            })
            .pipe(Effect.asVoid),
          service
            .movePage({
              ...common,
              mutationId: "page-move-depth17",
              pageId: owned.page.id,
              destination: { kind: "child", placement },
              guards: { pages: [], roots: [] },
            })
            .pipe(Effect.asVoid),
        ];
        for (const attempt of overflows) {
          const failure = yield* Effect.flip(attempt);
          assert.equal(failure._tag, "SpaceLimitExceededError");
          if (failure._tag === "SpaceLimitExceededError") {
            assert.equal(failure.limit, "maxDepth");
            assert.equal(failure.actual, 17);
          }
          assert.deepEqual(yield* structureState(dbPath), ownedBefore);
        }

        const snapshot = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT id FROM spaces_ids ORDER BY id`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        const before = yield* snapshot;
        const error = yield* Effect.flip(
          service.createChildPage({
            ...common,
            mutationId: "page-depth17",
            title: "No",
            placement: { pageId: deepest, parentId: null, beforeBlockId: null },
            guards: { pages: [], roots: [] },
          }),
        );
        assert.equal(error._tag, "SpaceLimitExceededError");
        if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxDepth");
        assert.deepEqual(yield* snapshot, before);
        const lists = Array.from({ length: 16 }, (_, i) => ({
          ...block(`list-${i}`, i + 1, i ? C.SpaceBlockId.make(`list-${i - 1}`) : null),
          type: "bulleted_item",
        }));
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "lists",
          pageId: page.id,
          baseRevision: 1,
          generation: 0,
          mutations: lists.map((value) => ({ kind: "insert", block: value })),
        });
        yield* childPage(service, common, page.id, "marker-depth16", null, lists[14]!.id);
        const prior = yield* snapshot;
        const invalid = yield* Effect.flip(
          service.createChildPage({
            ...common,
            mutationId: "marker-depth17",
            title: "No",
            placement: { pageId: page.id, parentId: lists[15]!.id, beforeBlockId: null },
            guards: { pages: [], roots: [] },
          }),
        );
        assert.equal(invalid._tag, "SpaceLimitExceededError");
        if (invalid._tag === "SpaceLimitExceededError") assert.equal(invalid.actual, 17);
        assert.deepEqual(yield* snapshot, prior);
      }),
    ),
  );

  it.effect(
    "rebalances actual exhausted root and block ranks once while preserving opaque sibling fields",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const other = yield* rootPage(service, common, library.defaultSpaceId, "rank-other");
          const source = yield* rootPage(service, common, library.defaultSpaceId, "rank-source");
          yield* service.movePage(
            yield* moveIntent(service, common, source.id, "rank-zero", {
              kind: "root",
              spaceId: library.defaultSpaceId,
              beforePageId: page.id,
            }),
          );
          const before = (yield* service.listPages({ ...env, spaceId: library.defaultSpaceId }))
            .space.rootOrderRevision;
          const result = yield* service.movePage(
            yield* moveIntent(service, common, other.id, "rank-rebalance", {
              kind: "root",
              spaceId: library.defaultSpaceId,
              beforePageId: page.id,
            }),
          );
          if (result.status !== "saved") return yield* Effect.die("Expected root rebalance");
          assert.equal(result.changed.pages.length, 3);
          const roots = yield* service.listPages({ ...env, spaceId: library.defaultSpaceId });
          assert.equal(roots.space.rootOrderRevision, before + 1);
          assert.deepEqual(
            roots.items.map((row) => row.id),
            [source.id, other.id, page.id],
          );
          assert.isTrue(roots.items.every((row) => /^[0-9a-f]{32}$/.test(row.rootOrder!)));
          const parent = roots.items.find((row) => row.id === page.id)!;
          const peers = [0, 1].map((n) => ({
            ...block(`peer-${n}`, n),
            futureEnvelope: { value: "界", flags: [true, null] },
          }));
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "rank-peers",
            pageId: page.id,
            baseRevision: parent.revision,
            generation: 0,
            mutations: peers.map((value) => ({ kind: "insert", block: value })),
          });
          const child = yield* childPage(
            service,
            common,
            page.id,
            "block-rank-rebalance",
            peers[1]!.id,
          );
          const current = (yield* service.getPage({ ...env, pageId: page.id })).page;
          assert.equal(current.revision, parent.revision + 2);
          const body = (yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: current.revision,
          })).blocks;
          assert.deepEqual(
            body.map((row) => row.id),
            [peers[0]!.id, child.ownerBlockId, peers[1]!.id],
          );
          assert.deepEqual(body[0]!.futureEnvelope, peers[0]!.futureEnvelope);
          assert.deepEqual(body[2]!.futureEnvelope, peers[1]!.futureEnvelope);
          const retained = yield* historyState(dbPath);
          const delta = retained.revisions.find(
            (row) => row.mutation_id === "block-rank-rebalance" && row.page_id === page.id,
          )!;
          assert.equal(JSON.parse(delta.payload).blocksBefore.length, 3);
        }),
      ),
  );

  it.effect("refuses a packed rank window rather than renumbering beyond the shared budget", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page, library } = yield* boot();
        const roots = [page];
        for (let i = 1; i < 100; i++)
          roots.push(yield* rootPage(service, common, library.defaultSpaceId, `packed-${i}`));
        yield* service.movePage(
          yield* moveIntent(service, common, roots[99]!.id, "packed-zero", {
            kind: "root",
            spaceId: library.defaultSpaceId,
            beforePageId: page.id,
          }),
        );
        const snapshot = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            pages:
              yield* sql`SELECT page_id,root_order,revision FROM spaces_pages ORDER BY page_id`,
            catalog: yield* sql`SELECT catalog_revision FROM spaces_core`,
            receipts: yield* sql`SELECT mutation_id FROM spaces_receipts ORDER BY mutation_id`,
          };
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        const before = yield* snapshot;
        const error = yield* Effect.flip(
          service.movePage({
            ...common,
            mutationId: "packed-refusal",
            pageId: roots[98]!.id,
            destination: { kind: "root", spaceId: library.defaultSpaceId, beforePageId: page.id },
            guards: { pages: [], roots: [] },
          }),
        );
        assert.equal(error._tag, "SpaceLimitExceededError");
        if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxMutationNodes");
        assert.deepEqual(yield* snapshot, before);
      }),
    ),
  );

  it.effect(
    "shares one history-pruning budget across moved page and both parent captures, with complete rollback",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const other = yield* rootPage(service, common, library.defaultSpaceId, "history-parent");
          const child = yield* childPage(service, common, page.id, "history-child");
          for (const [index, parent] of [page, other].entries()) {
            const delta = yield* prepareHistoryDelta(
              service,
              common,
              parent.id,
              `parent-history-${index}`,
              3_000_000,
              40,
            );
            const large = yield* service.applyBlockBatch(delta);
            if (large.status !== "saved") return yield* Effect.die("Expected large history");
            let revision = large.revision;
            for (let i = 0; i < 19; i++)
              yield* service.updatePage({
                ...common,
                mutationId: `retain-${index}-${i}`,
                pageId: parent.id,
                baseRevision: revision++,
                title: `Title ${i}`,
              });
          }
          const state = yield* historyState(dbPath);
          for (const id of [page.id, other.id])
            assert.equal(
              state.revisions.filter((row) => row.page_id === id)[0]!.logical_bytes,
              3_000_000,
            );
          const input = yield* moveIntent(
            service,
            common,
            child.page.id,
            "shared-history-refusal",
            { kind: "child", placement: { pageId: other.id, parentId: null, beforeBlockId: null } },
          );
          const before = yield* structureState(dbPath);
          const error = yield* Effect.flip(service.movePage(input));
          assert.equal(error._tag, "SpacesUnavailableError");
          if (error._tag === "SpacesUnavailableError") assert.equal(error.stage, "capacity");
          assert.deepEqual(yield* structureState(dbPath), before);
        }),
      ),
  );

  it.effect(
    "refuses oversized ownership metadata without truncating the inspected or mutated closure",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const children: Effect.Success<ReturnType<typeof childPage>>[] = [];
          for (let i = 0; i < 9; i++)
            children.push(yield* childPage(service, common, page.id, `wide-owner-${i}`));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const child of children) {
              const [row] =
                yield* sql`SELECT payload,logical_bytes FROM spaces_blocks WHERE block_id=${child.ownerBlockId}`;
              const raw = JSON.parse(String(row!.payload));
              const base = { ...raw, futureEnvelope: "" };
              const payload = JSON.stringify({
                ...base,
                futureEnvelope: "界".repeat(Math.floor((32_768 - bytes(base)) / 3)),
              });
              const logical = Buffer.byteLength(payload, "utf8");
              assert.isAtMost(logical, 32_768);
              yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${logical} WHERE block_id=${child.ownerBlockId}`;
              yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${logical - Number(row!.logical_bytes)} WHERE page_id=${page.id}`;
            }
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const destination = { kind: "root", spaceId: library.defaultSpaceId, beforePageId: null };
          const before = yield* structureState(dbPath);
          const inspect = yield* Effect.flip(
            service.inspectStructure({
              ...env,
              target: { kind: "page", pageId: page.id },
              destination,
            }),
          );
          assert.equal(inspect._tag, "SpaceLimitExceededError");
          if (inspect._tag === "SpaceLimitExceededError")
            assert.equal(inspect.limit, "maxMutationBytes");
          const write = yield* Effect.flip(
            service.movePage({
              ...common,
              mutationId: "wide-owner-refusal",
              pageId: page.id,
              destination,
              guards: { pages: [], roots: [] },
            }),
          );
          assert.equal(write._tag, "SpaceLimitExceededError");
          assert.deepEqual(yield* structureState(dbPath), before);
        }),
      ),
  );
});
