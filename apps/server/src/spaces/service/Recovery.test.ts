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
  env,
  identity,
  block,
  fixture,
  boot,
  historyState,
  prepareHistoryDelta,
  structureState,
  childPage,
  rootPage,
  moveIntent,
  blockMoveIntent,
  recoveryIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect("counts surviving owner-marker pins before admitting the whole purge", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const child = yield* childPage(service, common, page.id, "owner-pin-child");
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "owner-pin-body",
          pageId: child.page.id,
          baseRevision: 0,
          generation: 0,
          mutations: Array.from({ length: 92 }, (_, i) => ({
            kind: "insert" as const,
            block: block(`owner-pin-${i}`, i + 1),
          })),
        });
        yield* service.trashPage(
          yield* recoveryIntent(service, common, child.page.id, "trash", "owner-pin-trash"),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (${child.ownerBlockId},'retained-owner-hook')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        const read = yield* service.inspectStructure({
          ...env,
          target: { kind: "page", pageId: child.page.id },
          recovery: "restore",
        });
        const input = {
          ...common,
          mutationId: "owner-pin-purge",
          pageId: child.page.id,
          guards: read.guards,
        };
        const before = yield* structureState(dbPath);
        const error = yield* Effect.flip(service.permanentlyDeletePage(input));
        assert.equal(error._tag, "SpaceLimitExceededError");
        if (error._tag === "SpaceLimitExceededError") {
          assert.equal(error.limit, "maxMutationNodes");
          assert.equal(error.actual, 101);
        }
        assert.deepEqual(yield* structureState(dbPath), before);
      }),
    ),
  );

  it.effect(
    "purges a nested trash root while preserving its live parent, shared asset pin, and merged outcomes",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const child = yield* childPage(service, common, page.id, "nested-purge-child");
          const grand = yield* childPage(service, common, child.page.id, "nested-purge-grand");
          const outside = block("nested-outside"),
            a = block("nested-a"),
            b = block("nested-b", 2);
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "nested-outside-seed",
            pageId: page.id,
            baseRevision: 1,
            generation: 0,
            mutations: [{ kind: "insert", block: outside }],
          });
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "nested-join-seed",
            pageId: child.page.id,
            baseRevision: 1,
            generation: 0,
            mutations: [a, b].map((value) => ({ kind: "insert", block: value })),
          });
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "nested-join",
            pageId: child.page.id,
            baseRevision: 2,
            generation: 0,
            mutations: [{ kind: "delete", blockId: a.id, mergedInto: b.id }],
          });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            for (const [value, owner] of [
              [outside, page],
              [b, child.page],
            ] as const) {
              const [old] =
                yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id=${value.id}`;
              const payload = JSON.stringify({
                ...value,
                type: "image",
                content: { assetId: "shared-recovery-asset" },
                futureEnvelope: { preserved: true },
              });
              const logical = Buffer.byteLength(payload, "utf8");
              yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${logical} WHERE block_id=${value.id}`;
              yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${logical - Number(old!.logical_bytes)} WHERE page_id=${owner.id}`;
              yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (${value.id},'shared-recovery-asset')`;
            }
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              child.page.id,
              [b.id],
              { pageId: grand.page.id, parentId: null, beforeBlockId: null },
              "nested-media-move",
            ),
          );
          const merged = yield* service.resolveReference({
            ...env,
            target: { kind: "block", blockId: a.id },
            pageIdHint: page.id,
          });
          assert.equal(merged.status, "merged");
          if (merged.status === "merged") assert.equal(merged.page.id, grand.page.id);
          yield* service.trashPage(
            yield* recoveryIntent(service, common, child.page.id, "trash", "nested-trash"),
          );
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: child.ownerBlockId },
            }),
            { status: "trashed", pageId: child.page.id },
          );
          assert.deepEqual(
            yield* service.resolveReference({ ...env, target: { kind: "block", blockId: a.id } }),
            { status: "trashed", pageId: grand.page.id },
          );
          const before = yield* structureState(dbPath);
          const oldParent = before.pages.find((row) => row.page_id === page.id)!;
          const oldMarker = before.blocks.find((row) => row.block_id === child.ownerBlockId)!;
          const deleted = yield* service.permanentlyDeletePage(
            yield* recoveryIntent(
              service,
              common,
              child.page.id,
              "permanentlyDelete",
              "nested-purge",
            ),
          );
          if (deleted.status !== "saved") return yield* Effect.die("Expected nested purge");
          assert.deepEqual(deleted.changed.pages, [
            { pageId: page.id, revision: Number(oldParent.revision) + 1 },
          ]);
          assert.deepEqual(deleted.changed.roots, []);
          const state = yield* structureState(dbPath);
          assert.deepEqual(
            state.pages.map((row) => row.page_id),
            [page.id],
          );
          assert.deepEqual(
            state.blocks.map((row) => row.block_id),
            [outside.id],
          );
          assert.deepEqual(state.blockPins, [
            { block_id: outside.id, asset_id: "shared-recovery-asset" },
          ]);
          assert.deepEqual(state.revisionPins, []);
          assert.equal(state.ids.find((row) => row.id === a.id)!.merged_into, b.id);
          assert.equal(state.ids.find((row) => row.id === b.id)!.deleted, 1);
          assert.equal(state.ids.find((row) => row.id === child.ownerBlockId)!.deleted, 1);
          const capture = JSON.parse(
            String(state.history.find((row) => row.mutation_id === "nested-purge")!.payload),
          );
          assert.deepEqual(capture.blocksBefore, [{ id: child.ownerBlockId, row: oldMarker }]);
          const parent = (yield* service.getPage({ ...env, pageId: page.id })).page;
          assert.deepEqual(
            (yield* service.readBlocks({
              ...env,
              pageId: page.id,
              revision: parent.revision,
            })).blocks.map((row) => row.id),
            [outside.id],
          );
          assert.deepEqual(
            yield* service.resolveReference({ ...env, target: { kind: "block", blockId: a.id } }),
            { status: "deleted" },
          );
          yield* historyState(dbPath);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }),
      ),
  );

  it.effect.each(["retired", "missing", "hidden-parent"] as const)(
    "restores %s owners at the guarded space root without reusing the marker",
    (mode) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const child = yield* childPage(service, common, page.id, `orphan-${mode}`);
          yield* service.trashPage(
            yield* recoveryIntent(service, common, child.page.id, "trash", `orphan-trash-${mode}`),
          );
          if (mode === "hidden-parent")
            yield* service.trashPage(
              yield* recoveryIntent(service, common, page.id, "trash", "orphan-parent-trash"),
            );
          else
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              const [row] =
                yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id=${child.ownerBlockId}`;
              if (mode === "retired") {
                const payload = JSON.stringify({
                  id: child.ownerBlockId,
                  pageId: page.id,
                  mergedInto: null,
                });
                const size = Buffer.byteLength(payload, "utf8");
                yield* sql`UPDATE spaces_blocks SET deleted=1,merged_into=NULL,payload=${payload},logical_bytes=${size} WHERE block_id=${child.ownerBlockId}`;
                yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${size - Number(row!.logical_bytes)} WHERE page_id=${page.id}`;
              } else {
                yield* sql`DELETE FROM spaces_page_owners WHERE child_page_id=${child.page.id}`;
                yield* sql`DELETE FROM spaces_blocks WHERE block_id=${child.ownerBlockId}`;
                yield* sql`UPDATE spaces_pages SET block_count=block_count-1,block_bytes=block_bytes-${row!.logical_bytes} WHERE page_id=${page.id}`;
              }
              yield* sql`UPDATE spaces_ids SET deleted=1 WHERE id=${child.ownerBlockId}`;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          assert.isTrue(
            (yield* service.listTrash(env)).items.some((row) => row.pageId === child.page.id),
          );
          if (mode === "missing") {
            const state = yield* structureState(dbPath);
            const origin = String(
              state.pages.find((row) => row.page_id === child.page.id)!.trash_origin,
            );
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE spaces_pages SET trash_origin=${JSON.stringify({ ...JSON.parse(origin), spaceId: "missing-surviving-space" })} WHERE page_id=${child.page.id}`;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
            const before = yield* structureState(dbPath);
            const error = yield* Effect.flip(
              service.restorePage({
                ...common,
                mutationId: "orphan-no-space",
                pageId: child.page.id,
                guards: { pages: [], roots: [] },
              }),
            );
            assert.equal(error._tag, "SpacesUnavailableError");
            assert.deepEqual(yield* structureState(dbPath), before);
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE spaces_pages SET trash_origin=${origin} WHERE page_id=${child.page.id}`;
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          }
          const inspected = yield* service.inspectStructure({
            ...env,
            target: { kind: "page", pageId: child.page.id },
            recovery: "restore",
          });
          if (mode !== "hidden-parent")
            assert.isUndefined(inspected.pages.find((row) => row.id === child.page.id)!.location);
          assert.deepEqual(inspected.recovery, { operation: "restore", pageIds: [child.page.id] });
          const restored = yield* service.restorePage({
            ...common,
            mutationId: `orphan-restore-${mode}`,
            pageId: child.page.id,
            guards: inspected.guards,
          });
          if (restored.status !== "saved") return yield* Effect.die("Expected root fallback");
          assert.equal(restored.page.location?.kind, "root");
          assert.equal(restored.page.spaceId, library.defaultSpaceId);
          assert.isUndefined(restored.page.trash);
          const state = yield* structureState(dbPath);
          assert.equal(state.ids.find((row) => row.id === child.ownerBlockId)!.deleted, 1);
          assert.isUndefined(state.blocks.find((row) => row.block_id === child.ownerBlockId));
          assert.equal(state.pages.find((row) => row.page_id === page.id)!.block_count, 0);
          assert.equal(state.pages.find((row) => row.page_id === page.id)!.block_bytes, 0);
          assert.isUndefined(state.owners.find((row) => row.child_page_id === child.page.id));
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: child.ownerBlockId },
            }),
            { status: "deleted" },
          );
        }),
      ),
  );

  it.effect(
    "conflicts on stale recovery guards and refuses normalized ownership cycles without partial state",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const child = yield* childPage(service, common, page.id, "recovery-guard-child");
          const grand = yield* childPage(service, common, child.page.id, "recovery-guard-grand");
          const trash = yield* recoveryIntent(
            service,
            common,
            child.page.id,
            "trash",
            "recovery-stale-trash",
          );
          yield* service.updatePage({
            ...common,
            mutationId: "recovery-edit-grand",
            pageId: grand.page.id,
            baseRevision: 0,
            title: "Later",
          });
          const before = yield* historyState(dbPath);
          assert.equal((yield* service.trashPage(trash)).status, "conflict");
          assert.deepEqual(yield* historyState(dbPath), before);
          yield* service.trashPage(
            yield* recoveryIntent(service, common, child.page.id, "trash", "recovery-guard-trash"),
          );
          for (const operation of ["restore", "permanentlyDelete"] as const) {
            const input = yield* recoveryIntent(
              service,
              common,
              child.page.id,
              operation,
              `recovery-stale-${operation}`,
            );
            const current = (yield* service.getPage({ ...env, pageId: page.id })).page;
            yield* service.updatePage({
              ...common,
              mutationId: `recovery-parent-${operation}`,
              pageId: page.id,
              baseRevision: current.revision,
              title: operation,
            });
            const history = yield* historyState(dbPath);
            const result = yield* operation === "restore"
              ? service.restorePage(input)
              : service.permanentlyDeletePage(input);
            assert.equal(result.status, "conflict");
            assert.deepEqual(yield* historyState(dbPath), history);
          }
          const input = yield* recoveryIntent(
            service,
            common,
            child.page.id,
            "restore",
            "recovery-missing-guard",
          );
          assert.equal(
            (yield* service.restorePage({
              ...input,
              guards: {
                ...input.guards,
                pages: input.guards.pages.filter((row) => row.pageId !== grand.page.id),
              },
            })).status,
            "conflict",
          );
          const snapshot = yield* structureState(dbPath);
          const duplicate = yield* Effect.flip(
            service.restorePage({
              ...input,
              mutationId: "recovery-duplicate",
              guards: { ...input.guards, pages: [...input.guards.pages, input.guards.pages[0]!] },
            }),
          );
          assert.equal(duplicate._tag, "SpaceValidationError");
          assert.deepEqual(yield* structureState(dbPath), snapshot);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [owner] =
              yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id=${child.ownerBlockId}`;
            yield* sql`UPDATE spaces_blocks SET page_id=${grand.page.id} WHERE block_id=${child.ownerBlockId}`;
            yield* sql`UPDATE spaces_pages SET block_count=block_count-1,block_bytes=block_bytes-${owner!.logical_bytes} WHERE page_id=${page.id}`;
            yield* sql`UPDATE spaces_pages SET block_count=block_count+1,block_bytes=block_bytes+${owner!.logical_bytes} WHERE page_id=${grand.page.id}`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const cyclic = yield* structureState(dbPath);
          const cycle = yield* Effect.flip(
            service.restorePage({ ...input, mutationId: "recovery-cycle" }),
          );
          assert.equal(cycle._tag, "SpaceValidationError");
          if (cycle._tag === "SpaceValidationError") assert.equal(cycle.reason, "cycle");
          assert.deepEqual(yield* structureState(dbPath), cyclic);
        }),
      ),
  );

  it.effect(
    "admits a complete100node purge and refuses101 including retained history, then progresses after bounded expiry",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const other = yield* rootPage(service, common, library.defaultSpaceId, "purge-other");
          for (const [target, count] of [
            [page, 95],
            [other, 96],
          ] as const) {
            yield* service.applyBlockBatch({
              ...common,
              mutationId: `purge-seed-${count}`,
              pageId: target.id,
              baseRevision: 0,
              generation: 0,
              mutations: Array.from({ length: count }, (_, i) => ({
                kind: "insert" as const,
                block: block(`purge-${count}-${i}`, i + 1),
              })),
            });
            yield* service.trashPage(
              yield* recoveryIntent(service, common, target.id, "trash", `purge-trash-${count}`),
            );
          }
          const atLimit = yield* recoveryIntent(
            service,
            common,
            page.id,
            "permanentlyDelete",
            "purge-at100",
          );
          assert.equal((yield* service.permanentlyDeletePage(atLimit)).status, "saved");
          const guard = yield* service.inspectStructure({
            ...env,
            target: { kind: "page", pageId: other.id },
            recovery: "restore",
          });
          const over = {
            ...common,
            mutationId: "purge-at101",
            pageId: other.id,
            guards: guard.guards,
          };
          const before = yield* structureState(dbPath);
          for (const attempt of [
            service
              .inspectStructure({
                ...env,
                target: { kind: "page", pageId: other.id },
                recovery: "permanentlyDelete",
              })
              .pipe(Effect.asVoid),
            service.permanentlyDeletePage(over).pipe(Effect.asVoid),
          ]) {
            const error = yield* Effect.flip(attempt);
            assert.equal(error._tag, "SpaceLimitExceededError");
            if (error._tag === "SpaceLimitExceededError") {
              assert.equal(error.limit, "maxMutationNodes");
              assert.equal(error.actual, 101);
            }
            assert.deepEqual(yield* structureState(dbPath), before);
          }
          yield* TestClock.adjust("8 days");
          const admission = yield* service.listSpaces(env);
          const fresh = { ...env, receiptEpoch: admission.mutationAdmission.epoch };
          const after = yield* service.permanentlyDeletePage(
            yield* recoveryIntent(
              service,
              fresh,
              other.id,
              "permanentlyDelete",
              "purge-after-expiry",
            ),
          );
          assert.equal(after.status, "saved");
          const state = yield* structureState(dbPath);
          assert.deepEqual(state.pages, []);
          assert.deepEqual(state.history, []);
          assert.equal(state.core[0]!.revision_bytes, 0);
        }),
      ),
  );

  it.effect.each(["trash", "restore"] as const)(
    "rolls back %s when multiple page captures exceed the shared history cleanup bytes",
    (operation) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const child = yield* childPage(service, common, page.id, `history-${operation}-child`);
          for (const [index, target] of [page, child.page].entries()) {
            const delta = yield* prepareHistoryDelta(
              service,
              common,
              target.id,
              `recovery-history-${operation}-${index}`,
              3000000,
              40,
            );
            const saved = yield* service.applyBlockBatch(delta);
            if (saved.status !== "saved") return yield* Effect.die("Expected history");
            let revision = saved.revision;
            for (let i = 0; i < (operation === "restore" ? 18 : 19); i++)
              yield* service.updatePage({
                ...common,
                mutationId: `recovery-retain-${operation}-${index}-${i}`,
                pageId: target.id,
                baseRevision: revision++,
                title: `Retain ${i}`,
              });
          }
          if (operation === "restore")
            assert.equal(
              (yield* service.trashPage(
                yield* recoveryIntent(service, common, page.id, "trash", "history-before-restore"),
              )).status,
              "saved",
            );
          const input = yield* recoveryIntent(
            service,
            common,
            page.id,
            operation,
            `history-refuse-${operation}`,
          );
          const before = yield* structureState(dbPath);
          const error = yield* Effect.flip(
            operation === "trash" ? service.trashPage(input) : service.restorePage(input),
          );
          assert.equal(error._tag, "SpacesUnavailableError");
          if (error._tag === "SpacesUnavailableError") assert.equal(error.stage, "capacity");
          assert.deepEqual(yield* structureState(dbPath), before);
        }),
      ),
  );

  it.effect(
    "retains nested trash and asset hooks over restart, restores, and explicitly purges without erasing identity",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-recovery-reopen-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const live = () =>
          SpacesService.layerFromPath(dbPath).pipe(
            Layer.provide(identity),
            Layer.provide(Settings.layerTest({ spacesEnabled: true })),
          );
        const first = yield* Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const child = yield* childPage(service, common, page.id, "recovery-child");
          const grandchild = yield* childPage(
            service,
            common,
            child.page.id,
            "recovery-grandchild",
          );
          const media = block("recovery-media");
          yield* service.applyBlockBatch(
            request("recovery-media-seed", 1, [{ kind: "insert", block: media }]),
          );
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [old] =
              yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id=${media.id}`;
            const payload = JSON.stringify({
              ...media,
              type: "image",
              content: { assetId: "recovery-asset", caption: [{ text: "原图", marks: [] }] },
              futureEnvelope: { keep: [false, "界"] },
            });
            const logical = Buffer.byteLength(payload, "utf8");
            yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${logical} WHERE block_id=${media.id}`;
            yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${logical - Number(old!.logical_bytes)} WHERE page_id=${page.id}`;
            yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (${media.id},'recovery-asset')`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              page.id,
              [media.id],
              { pageId: child.page.id, parentId: null, beforeBlockId: null },
              "recovery-media-move",
            ),
          );
          const original = yield* structureState(dbPath);
          const activePurge = yield* Effect.flip(
            service.permanentlyDeletePage({
              ...common,
              mutationId: "purge-live-refusal",
              pageId: page.id,
              guards: { pages: [], roots: [] },
            }),
          );
          assert.equal(activePurge._tag, "SpaceValidationError");
          if (activePurge._tag === "SpaceValidationError")
            assert.equal(activePurge.reason, "invalid_recovery_state");
          assert.deepEqual(yield* structureState(dbPath), original);

          const input = yield* recoveryIntent(service, common, page.id, "trash", "recovery-trash");
          const saved = yield* service.trashPage(input);
          if (saved.status !== "saved") return yield* Effect.die("Expected trash");
          assert.equal(saved.changed.pages.length, 3);
          assert.equal(saved.changed.roots.length, 1);
          assert.isDefined(saved.page.trash);
          const state = yield* structureState(dbPath);
          assert.deepEqual(state.blocks, original.blocks);
          assert.deepEqual(state.owners, original.owners);
          assert.deepEqual(state.blockPins, original.blockPins);
          assert.deepEqual(state.revisionPins, original.revisionPins);
          assert.equal(
            state.pages.filter((row) => row.trash_batch_id === saved.page.trash!.batchId).length,
            3,
          );
          assert.deepEqual(yield* service.trashPage(input), saved);
          const nestedPurge = yield* Effect.flip(
            service.permanentlyDeletePage({
              ...common,
              mutationId: "purge-nonroot-refusal",
              pageId: grandchild.page.id,
              guards: { pages: [], roots: [] },
            }),
          );
          assert.equal(nestedPurge._tag, "SpaceValidationError");
          if (nestedPurge._tag === "SpaceValidationError")
            assert.equal(nestedPurge.reason, "invalid_recovery_state");
          assert.deepEqual(yield* structureState(dbPath), state);

          assert.deepEqual(
            (yield* service.listPages({ ...env, spaceId: library.defaultSpaceId })).items,
            [],
          );
          const listed = yield* service.listTrash(env);
          assert.deepEqual(
            listed.items.map((row) => row.pageId),
            [page.id],
          );
          let cursor: C.SpaceCursor | undefined;
          let trashCursor: C.SpaceCursor | null = null;
          const listedIds: C.SpacePageId[] = [];
          let emptyProgress = false;
          for (let read = 0; read < 3; read++) {
            const window = yield* service.listTrash({
              ...env,
              limit: 1,
              ...(cursor ? { cursor } : {}),
            });
            listedIds.push(...window.items.map((row) => row.pageId));
            if (read === 0) trashCursor = window.nextCursor;
            if (window.items.length === 0 && window.nextCursor !== null) emptyProgress = true;
            cursor = window.nextCursor ?? undefined;
          }
          assert.deepEqual(listedIds, [page.id]);
          assert.isUndefined(cursor);
          assert.isTrue(emptyProgress);
          assert.isNotNull(trashCursor);
          const wrongCursor = yield* Effect.flip(
            service.listPages({ ...env, spaceId: library.defaultSpaceId, cursor: trashCursor }),
          );
          assert.equal(wrongCursor._tag, "SpaceValidationError");
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const plan =
              yield* sql`EXPLAIN QUERY PLAN SELECT page_id FROM spaces_pages WHERE trash_batch_id IS NOT NULL ORDER BY trashed_at_ms,page_id LIMIT 2`;
            const index = plan
              .map((row) => /USING (?:COVERING )?INDEX (\S+)/.exec(String(row.detail)))
              .find((match) => match !== null);
            assert.isDefined(index);
            const indexes = yield* sql`PRAGMA index_list('spaces_pages')`;
            assert.equal(indexes.find((row) => row.name === index![1])?.partial, 1);
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

          for (const attempt of [
            service.getPage({ ...env, pageId: page.id }).pipe(Effect.asVoid),
            service.readBlocks({ ...env, pageId: child.page.id, revision: 0 }).pipe(Effect.asVoid),
            service
              .updatePage({
                ...common,
                mutationId: "trash-edit",
                pageId: page.id,
                baseRevision: 0,
                title: "No",
              })
              .pipe(Effect.asVoid),
            service.applyBlockBatch(request("trash-body", 0, [])).pipe(Effect.asVoid),
          ]) {
            const error = yield* Effect.flip(attempt);
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError") assert.equal(error.reason, "trashed");
          }
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "page", pageId: grandchild.page.id },
            }),
            { status: "trashed", pageId: grandchild.page.id },
          );
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: media.id },
              pageIdHint: page.id,
            }),
            { status: "trashed", pageId: child.page.id },
          );
          return {
            common,
            page,
            child,
            grandchild,
            media,
            library,
            input,
            saved,
            original,
            trashCursor,
          };
        }).pipe(Effect.provide(live()));
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          assert.deepEqual(
            (yield* service.listTrash(env)).items.map((row) => row.pageId),
            [first.page.id],
          );
          assert.deepEqual(yield* service.trashPage(first.input), first.saved);
          const restore = yield* recoveryIntent(
            service,
            first.common,
            first.page.id,
            "restore",
            "recovery-restore",
          );
          const restored = yield* service.restorePage(restore);
          if (restored.status !== "saved") return yield* Effect.die("Expected restored pages");
          assert.equal(restored.changed.pages.length, 3);
          assert.equal(restored.page.rootOrder, first.page.rootOrder);
          assert.isUndefined(restored.page.trash);
          assert.equal(
            (yield* Effect.flip(service.listTrash({ ...env, cursor: first.trashCursor! })))._tag,
            "SpaceCursorStaleError",
          );
          assert.equal(
            (yield* service.getPage({ ...env, pageId: first.grandchild.page.id })).page.location
              ?.kind,
            "child",
          );
          const active = yield* structureState(dbPath);
          assert.deepEqual(active.blocks, first.original.blocks);
          assert.deepEqual(active.blockPins, first.original.blockPins);
          assert.deepEqual(active.revisionPins, first.original.revisionPins);
          const delta = active.history.find(
            (row) => row.mutation_id === "recovery-restore" && row.page_id === first.page.id,
          )!;
          const preimage = JSON.parse(String(delta.payload));
          assert.equal(preimage.version, 3);
          assert.equal(preimage.trashBefore.batchId, first.saved.page.trash!.batchId);
          assert.equal(
            JSON.parse(preimage.trashBefore.origin).spaceId,
            first.library.defaultSpaceId,
          );
          const secondTrash = yield* recoveryIntent(
            service,
            first.common,
            first.page.id,
            "trash",
            "recovery-trash2",
          );
          assert.equal((yield* service.trashPage(secondTrash)).status, "saved");
          const purge = yield* recoveryIntent(
            service,
            first.common,
            first.page.id,
            "permanentlyDelete",
            "recovery-purge",
          );
          const deleted = yield* service.permanentlyDeletePage(purge);
          if (deleted.status !== "saved") return yield* Effect.die("Expected purged pages");
          assert.deepEqual(
            new Set(deleted.deletedPageIds),
            new Set([first.page.id, first.child.page.id, first.grandchild.page.id]),
          );
          const state = yield* structureState(dbPath);
          assert.deepEqual(state.pages, []);
          assert.deepEqual(state.blocks, []);
          assert.deepEqual(state.owners, []);
          assert.deepEqual(state.history, []);
          assert.deepEqual(state.blockPins, []);
          assert.deepEqual(state.revisionPins, []);
          assert.equal(state.core[0]!.revision_bytes, 0);
          assert.equal(state.spaces[0]!.is_default, 1);
          assert.deepEqual(yield* service.permanentlyDeletePage(purge), deleted);
          assert.deepEqual(yield* service.restorePage(restore), restored);
          assert.deepEqual(yield* structureState(dbPath), state);
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: first.media.id },
              pageIdHint: first.page.id,
            }),
            { status: "deleted" },
          );
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "page", pageId: first.child.page.id },
            }),
            { status: "deleted" },
          );
          assert.deepEqual((yield* service.listTrash(env)).items, []);
          const fresh = yield* rootPage(
            service,
            first.common,
            first.library.defaultSpaceId,
            "recovery-new-page",
          );
          const error = yield* Effect.flip(
            service.applyBlockBatch({
              ...first.common,
              mutationId: "recovery-reuse",
              pageId: fresh.id,
              baseRevision: 0,
              generation: 0,
              mutations: [{ kind: "insert", block: block(first.media.id) }],
            }),
          );
          assert.equal(error._tag, "SpaceValidationError");
          if (error._tag === "SpaceValidationError") assert.equal(error.reason, "duplicate_id");
        }).pipe(Effect.provide(live()));
      }),
  );

  it.effect(
    "preserves independent trash batches and excludes a detached descendant from its former batch restore",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const child = yield* childPage(service, common, page.id, "batch-child");
          const grandchild = yield* childPage(service, common, child.page.id, "batch-independent");
          const independent = yield* service.trashPage(
            yield* recoveryIntent(
              service,
              common,
              grandchild.page.id,
              "trash",
              "independent-trash",
            ),
          );
          if (independent.status !== "saved")
            return yield* Effect.die("Expected independent batch");
          const trashed = yield* service.trashPage(
            yield* recoveryIntent(service, common, page.id, "trash", "batch-trash"),
          );
          if (trashed.status !== "saved") return yield* Effect.die("Expected parent batch");
          const before = yield* structureState(dbPath);
          assert.equal(
            before.pages.find((row) => row.page_id === grandchild.page.id)!.trash_batch_id,
            independent.page.trash!.batchId,
          );
          assert.notEqual(independent.page.trash!.batchId, trashed.page.trash!.batchId);
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: grandchild.ownerBlockId },
            }),
            { status: "trashed", pageId: child.page.id },
          );
          const detached = yield* service.movePage(
            yield* moveIntent(service, common, child.page.id, "batch-detach", {
              kind: "root",
              spaceId: library.defaultSpaceId,
              beforePageId: null,
            }),
          );
          if (detached.status !== "saved") return yield* Effect.die("Expected detached child");
          assert.equal(detached.page.trash?.batchId, trashed.page.trash!.batchId);
          assert.equal(detached.page.location?.kind, "root");
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: child.ownerBlockId },
            }),
            { status: "deleted" },
          );
          const restored = yield* service.restorePage(
            yield* recoveryIntent(service, common, page.id, "restore", "batch-parent-restore"),
          );
          if (restored.status !== "saved") return yield* Effect.die("Expected restored parent");
          assert.deepEqual(
            restored.changed.pages.map((row) => row.pageId),
            [page.id],
          );
          const state = yield* structureState(dbPath);
          assert.equal(
            state.pages.find((row) => row.page_id === child.page.id)!.trash_batch_id,
            trashed.page.trash!.batchId,
          );
          assert.equal(
            state.pages.find((row) => row.page_id === grandchild.page.id)!.trash_batch_id,
            independent.page.trash!.batchId,
          );
          const childRestore = yield* service.restorePage(
            yield* recoveryIntent(service, common, child.page.id, "restore", "batch-child-restore"),
          );
          if (childRestore.status !== "saved")
            return yield* Effect.die("Expected detached restore");
          assert.equal(childRestore.page.location?.kind, "root");
          assert.equal(childRestore.changed.pages.length, 1);
          const grandRestore = yield* service.restorePage(
            yield* recoveryIntent(
              service,
              common,
              grandchild.page.id,
              "restore",
              "batch-independent-restore",
            ),
          );
          if (grandRestore.status !== "saved")
            return yield* Effect.die("Expected independent restore");
          assert.deepEqual(grandRestore.page.location, {
            kind: "child",
            spaceId: library.defaultSpaceId,
            ownerBlockId: grandchild.ownerBlockId,
            parentPageId: child.page.id,
          });
          assert.deepEqual((yield* service.listTrash(env)).items, []);
          const final = yield* structureState(dbPath);
          assert.equal(final.ids.find((row) => row.id === child.ownerBlockId)!.deleted, 1);
          assert.isUndefined(final.blocks.find((row) => row.block_id === child.ownerBlockId));
        }),
      ),
  );
});
