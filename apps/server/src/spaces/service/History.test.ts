import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../../serverSettings.ts";
import * as SpacesService from "../SpacesService.ts";
import {
  environmentId,
  env,
  identity,
  block,
  bytes,
  fixture,
  boot,
  historyState,
  prepareHistoryDelta,
  childPage,
  blockMoveIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect(
    "retains exact changed-row reverse deltas once, preserving original opaque payload bytes",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, request } = yield* boot();
          const parent = {
            ...block("parent"),
            type: "bulleted_item",
            content: { runs: [{ text: "original", marks: [] }], future: { text: "界" } },
          };
          const child = block("child", 1, parent.id);
          const sibling = block("sibling", 2);
          const insert = request(
            "insert-history",
            0,
            [parent, child, sibling].map((value) => ({ kind: "insert", block: value })),
          );
          const inserted = yield* service.applyBlockBatch(insert);
          const originals = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const edited = {
            ...parent,
            content: { ...parent.content, runs: [{ text: "changed", marks: [] }] },
          };
          yield* service.applyBlockBatch(
            request("replace-history", 1, [{ kind: "replace", block: edited }]),
          );
          yield* service.applyBlockBatch(
            request("delete-history", 2, [{ kind: "delete", blockId: child.id }]),
          );
          yield* service.updatePage({
            ...common,
            mutationId: "title-history",
            pageId: page.id,
            baseRevision: 3,
            title: "Renamed",
          });
          const before = yield* historyState(dbPath);
          assert.deepEqual(
            before.revisions.map((row) => row.to_revision),
            [0, 1, 2, 3, 4],
          );
          assert.deepEqual(JSON.parse(before.revisions[0]!.payload), {
            version: 3,
            pageBefore: null,
            ownerBefore: null,
            trashBefore: null,
            blocksBefore: [],
          });
          assert.deepEqual(
            JSON.parse(before.revisions[1]!.payload).blocksBefore,
            [parent, child, sibling].map((value) => ({ id: value.id, row: null })),
          );
          const replaced = JSON.parse(before.revisions[2]!.payload);
          assert.deepEqual(replaced.blocksBefore, [
            { id: parent.id, row: originals.find((row) => row.block_id === parent.id) },
          ]);
          assert.deepEqual(replaced.pageBefore, {
            pageId: page.id,
            spaceId: page.spaceId,
            title: "Page",
            revision: 1,
            rootOrder: page.rootOrder,
            createdAt: page.createdAt,
            updatedAt: page.updatedAt,
          });
          assert.isNull(replaced.ownerBefore);
          assert.deepEqual(JSON.parse(before.revisions[3]!.payload).blocksBefore, [
            { id: child.id, row: originals.find((row) => row.block_id === child.id) },
          ]);
          assert.deepEqual(JSON.parse(before.revisions[4]!.payload).blocksBefore, []);
          assert.equal(JSON.parse(before.revisions[4]!.payload).pageBefore.title, "Page");
          assert.deepEqual(yield* service.applyBlockBatch(insert), inserted);
          assert.equal(
            (yield* service.applyBlockBatch(request("stale-history", 0, []))).status,
            "conflict",
          );
          yield* service.applyBlockBatch(
            request("no-op-history", 4, [{ kind: "replace", block: edited }]),
          );
          yield* service.updatePage({
            ...common,
            mutationId: "title-no-op",
            pageId: page.id,
            baseRevision: 4,
            title: "Renamed",
          });
          assert.deepEqual(yield* historyState(dbPath), before);
        }),
      ),
  );

  it.effect(
    "retains the newest twenty revisions while metadata changes never snapshot unchanged bodies",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          for (let i = 1; i <= 20; i++)
            yield* service.updatePage({
              ...common,
              mutationId: `title-${i}`,
              pageId: page.id,
              baseRevision: i - 1,
              title: `Title ${i}`,
            });
          const state = yield* historyState(dbPath);
          assert.equal(state.revisions.length, 20);
          assert.deepEqual(
            state.revisions.map((row) => row.to_revision),
            Array.from({ length: 20 }, (_, i) => i + 1),
          );
          assert.equal(JSON.parse(state.revisions[0]!.payload).pageBefore.title, "Page");
          assert.isTrue(
            state.revisions.every((row) => JSON.parse(row.payload).blocksBefore.length === 0),
          );
          assert.deepEqual((yield* service.getCapability(environmentId))?.limits.history, {
            maxRevisionsPerPage: 20,
            retentionMs: 604_800_000,
            maxDeltaBytes: 4_194_304,
            maxPageBytes: 8_388_608,
            maxEnvironmentBytes: 67_108_864,
            cleanupBatchRows: 100,
            cleanupBatchBytes: 4_194_304,
          });
        }),
      ),
  );

  it.effect.each([0, 1])(
    "enforces the independent history delta ceiling at exact UTF8 bytes plus %s",
    (excess) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const input = yield* prepareHistoryDelta(
            service,
            common,
            page.id,
            "boundary",
            4_194_304 + excess,
          );
          assert.isBelow(bytes({ operation: "applyBlockBatch", input }), 262_144);
          const inspect = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              core: yield* sql`SELECT * FROM spaces_core`,
              pages: yield* sql`SELECT * FROM spaces_pages`,
              blocks: yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`,
              ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
              receipts: yield* sql`SELECT * FROM spaces_receipts ORDER BY mutation_id`,
              revisions: yield* sql`SELECT * FROM spaces_revisions ORDER BY page_id, to_revision`,
            };
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const before = yield* inspect;
          if (excess) {
            const error = yield* Effect.flip(service.applyBlockBatch(input));
            assert.equal(error._tag, "SpaceLimitExceededError");
            if (error._tag === "SpaceLimitExceededError") {
              assert.equal(error.limit, "history.maxDeltaBytes");
              assert.equal(error.actual, 4_194_305);
              assert.equal(error.maximum, 4_194_304);
            }
            assert.deepEqual(yield* inspect, before);
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input },
              }),
              { status: "absent" },
            );
          } else {
            const saved = yield* service.applyBlockBatch(input);
            const state = yield* historyState(dbPath);
            const record = state.revisions.find((row) => row.mutation_id === input.mutationId)!;
            assert.equal(record.logical_bytes, 4_194_304);
            assert.equal(JSON.parse(record.payload).blocksBefore.length, 100);
            yield* TestClock.adjust("8 days");
            assert.deepEqual(yield* service.applyBlockBatch(input), saved);
            assert.equal((yield* historyState(dbPath)).bytes, state.bytes);
            yield* service.getCapability(env.environmentId);
            const first = yield* historyState(dbPath);
            assert.equal(first.revisions.length, 1);
            assert.equal(first.bytes, 4_194_304);
            yield* TestClock.setTime(0);
            yield* service.getCapability(env.environmentId);
            assert.equal((yield* historyState(dbPath)).revisions.length, 0);
          }
        }),
      ),
  );

  it.effect(
    "commits at most one hundred expired history rows after refusal, without maintaining ahead of replay",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, library, page } = yield* boot();
          let last = page;
          let known: C.SpacePageUpdateInput | undefined;
          let saved: C.SpacePageUpdateResult | undefined;
          for (let p = 0; p < 6; p++) {
            if (p) {
              const created = yield* service.createPage({
                ...common,
                mutationId: `prune-page-${p}`,
                spaceId: library.defaultSpaceId,
                baseRootOrderRevision: p,
                title: "Page",
              });
              if (created.status !== "saved") return yield* Effect.die("Expected page");
              last = created.page;
            }
            for (let r = 1; r < 20; r++) {
              known = {
                ...common,
                mutationId: C.SpaceMutationId.make(`prune-${p}-${r}`),
                pageId: last.id,
                baseRevision: r - 1,
                title: `Title ${r}`,
              };
              saved = yield* service.updatePage(known);
            }
          }
          if (known === undefined || saved === undefined)
            return yield* Effect.die("Expected saved history");
          assert.equal((yield* historyState(dbPath)).revisions.length, 120);
          yield* TestClock.adjust("8 days");
          assert.deepEqual(yield* service.updatePage(known!), saved);
          assert.equal((yield* historyState(dbPath)).revisions.length, 120);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "updatePage", input: known! },
            }),
            { status: "found", receipt: { operation: "updatePage", result: saved } },
          );
          assert.equal((yield* historyState(dbPath)).revisions.length, 120);
          const error = yield* Effect.flip(
            service.updatePage({
              ...known,
              mutationId: "refused-maintenance",
              title: "x".repeat(513),
            }),
          );
          assert.equal(error._tag, "SpaceLimitExceededError");
          assert.equal((yield* historyState(dbPath)).revisions.length, 20);
          yield* TestClock.setTime(0);
          yield* service.getPage({ ...env, pageId: last.id });
          assert.equal((yield* historyState(dbPath)).revisions.length, 0);
        }),
      ),
  );

  it.effect("evicts complete oldest history records at page and environment byte capacity", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, library, page } = yield* boot();
        const large: string[] = [];
        let last = page;
        for (let p = 0; p < 9; p++) {
          if (p) {
            yield* TestClock.adjust(1);
            const created = yield* service.createPage({
              ...common,
              mutationId: `capacity-page-${p}`,
              spaceId: library.defaultSpaceId,
              baseRootOrderRevision: p,
              title: "Page",
            });
            if (created.status !== "saved") return yield* Effect.die("Expected page");
            last = created.page;
          }
          for (let r = 0; r < 2; r++) {
            const input = yield* prepareHistoryDelta(
              service,
              common,
              last.id,
              `cap-${p}-${r}`,
              3_900_000,
              40,
            );
            yield* service.applyBlockBatch(input);
            large.push(input.mutationId);
          }
        }
        const environment = yield* historyState(dbPath);
        assert.isAtMost(environment.bytes, 67_108_864);
        assert.isAbove(environment.bytes, 63_000_000);
        assert.isFalse(environment.revisions.some((row) => row.mutation_id === large[0]));
        assert.isTrue(
          large.slice(1).every((id) => environment.revisions.some((row) => row.mutation_id === id)),
        );
        const input = yield* prepareHistoryDelta(
          service,
          common,
          last.id,
          "page-overflow",
          3_900_000,
          40,
        );
        const pending = yield* historyState(dbPath);
        assert.isTrue(pending.revisions.some((row) => row.mutation_id === "cap-8-0-delta"));
        assert.isAbove(
          pending.pages.find((row) => row.page_id === last.id)!.retained_revision_bytes + 3_900_000,
          8_388_608,
        );
        yield* service.applyBlockBatch(input);
        const after = yield* historyState(dbPath);
        assert.isAtMost(
          after.pages.find((row) => row.page_id === last.id)!.retained_revision_bytes,
          8_388_608,
        );
        assert.isFalse(after.revisions.some((row) => row.mutation_id === "cap-8-0-delta"));
        assert.isTrue(after.revisions.some((row) => row.mutation_id === "cap-8-1-delta"));
        assert.isTrue(after.revisions.some((row) => row.mutation_id === input.mutationId));
      }),
    ),
  );

  it.effect(
    "rolls back indivisible capacity eviction and makes bounded age-cleanup progress after refusal",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          for (let i = 0; i < 3; i++) {
            const input = yield* prepareHistoryDelta(
              service,
              common,
              page.id,
              `indivisible-${i}`,
              2_400_000,
              20,
            );
            yield* service.applyBlockBatch(input);
          }
          const input = yield* prepareHistoryDelta(
            service,
            common,
            page.id,
            "refused-delta",
            4_194_304,
            40,
          );
          const snapshot = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              core: yield* sql`SELECT * FROM spaces_core`,
              pages: yield* sql`SELECT * FROM spaces_pages`,
              blocks: yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`,
              ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
              receipts: yield* sql`SELECT * FROM spaces_receipts ORDER BY mutation_id`,
              revisions: yield* sql`SELECT * FROM spaces_revisions ORDER BY page_id, to_revision`,
            };
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const before = yield* snapshot;
          const error = yield* Effect.flip(service.applyBlockBatch(input));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError")
            assert.equal(error.limit, "history.maxPageBytes");
          assert.deepEqual(yield* snapshot, before);
          yield* TestClock.adjust("8 days");
          let state = yield* historyState(dbPath);
          for (let pass = 0; pass < 3; pass++) {
            yield* service.getCapability(env.environmentId);
            const next = yield* historyState(dbPath);
            assert.isBelow(next.bytes, state.bytes);
            assert.isAtMost(state.bytes - next.bytes, 4_194_304);
            assert.isAtMost(state.revisions.length - next.revisions.length, 100);
            state = next;
          }
          assert.equal(state.bytes, 0);
          const library = yield* service.listSpaces(env);
          const fresh = {
            ...input,
            mutationId: "after",
            receiptEpoch: library.mutationAdmission.epoch,
          };
          assert.equal((yield* service.applyBlockBatch(fresh)).status, "saved");
          assert.isAtMost((yield* historyState(dbPath)).bytes, 4_194_304);
        }),
      ),
  );

  it.effect("reopens retained history and replays its saved receipt without another capture", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-history-reopen-" });
      const dbPath = path.join(directory, "spaces.sqlite");
      const live = () =>
        SpacesService.layerFromPath(dbPath).pipe(
          Layer.provide(identity),
          Layer.provide(Settings.layerTest({ spacesEnabled: true })),
        );
      const first = yield* Effect.gen(function* () {
        const { service, common, page, request } = yield* boot();
        const input = {
          ...common,
          mutationId: "durable-history",
          pageId: page.id,
          baseRevision: 0,
          title: "Durable title",
        };
        const saved = yield* service.updatePage(input);
        const child = yield* childPage(service, common, page.id, "durable-child");
        const seed = { ...block("durable-moving"), futureEnvelope: { preserved: ["界", 1] } };
        yield* service.applyBlockBatch(
          request("durable-block", 2, [{ kind: "insert", block: seed }]),
        );
        const opaque = {
          ...seed,
          type: "future-widget",
          version: 7,
          content: ["界", { future: [false, null] }],
        };
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [old] =
            yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id=${opaque.id}`;
          const payload = JSON.stringify(opaque);
          const logical = Buffer.byteLength(payload, "utf8");
          yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${logical} WHERE block_id=${opaque.id}`;
          yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${logical - Number(old!.logical_bytes)} WHERE page_id=${page.id}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const move = yield* blockMoveIntent(
          service,
          common,
          page.id,
          [opaque.id],
          { pageId: child.page.id, parentId: null, beforeBlockId: null },
          "durable-move",
        );
        const moved = yield* service.moveBlocks(move);
        assert.equal(moved.status, "saved");
        return { input, saved, child, opaque, move, moved, history: yield* historyState(dbPath) };
      }).pipe(Effect.provide(live()));
      yield* Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        assert.equal(
          (yield* service.getPage({ ...env, pageId: first.input.pageId })).page.title,
          "Durable title",
        );
        assert.deepEqual(yield* service.updatePage(first.input), first.saved);
        const children = yield* service.listPages({
          ...env,
          spaceId: first.child.page.spaceId,
          parentPageId: first.input.pageId,
        });
        assert.deepEqual(
          children.items.map((row) => row.id),
          [first.child.page.id],
        );
        assert.deepEqual(
          (yield* service.getPage({ ...env, pageId: first.child.page.id })).page.location,
          first.child.page.location,
        );
        assert.deepEqual(yield* service.moveBlocks(first.move), first.moved);
        const resolved = yield* service.resolveReference({
          ...env,
          target: { kind: "block", blockId: first.opaque.id },
          pageIdHint: first.input.pageId,
        });
        assert.equal(resolved.status, "resolved");
        if (resolved.status === "resolved") assert.equal(resolved.page.id, first.child.page.id);
        const body = yield* service.readBlocks({
          ...env,
          pageId: first.child.page.id,
          revision: (yield* service.getPage({ ...env, pageId: first.child.page.id })).page.revision,
        });
        assert.equal(body.blocks[0]!.id, first.opaque.id);
        assert.equal(body.blocks[0]!.type, first.opaque.type);
        assert.equal(body.blocks[0]!.version, first.opaque.version);
        assert.deepEqual(body.blocks[0]!.content, first.opaque.content);
        assert.deepEqual(body.blocks[0]!.futureEnvelope, first.opaque.futureEnvelope);
        assert.deepEqual(yield* historyState(dbPath), first.history);
      }).pipe(Effect.provide(live()));
    }),
  );
});
