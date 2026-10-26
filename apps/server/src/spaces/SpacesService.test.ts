import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as SpacesService from "./SpacesService.ts";

const environmentId = EnvironmentId.make("test-environment");
const env = { environmentId };
const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
const block = (id: string, n = 1, parentId: C.SpaceBlockId | null = null): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId,
  order: n.toString(16).padStart(32, "0"),
  type: "paragraph",
  version: 1,
  content: { runs: [{ text: id, marks: [] }] },
});
const encodeServiceErrorJson = Schema.encodeEffect(Schema.fromJsonString(C.SpaceServiceError));
const encodeBlockJson = Schema.encodeEffect(Schema.fromJsonString(C.SpaceBlock));
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

const fixture = Effect.fn("SpacesServiceTest.fixture")(function* <A, E>(
  use: (
    dbPath: string,
  ) => Effect.Effect<
    A,
    E,
    SpacesService.SpacesService | Settings.ServerSettingsService | FileSystem.FileSystem
  >,
  enabled = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-service-" });
  const dbPath = path.join(directory, "spaces.sqlite");
  return yield* use(dbPath).pipe(
    Effect.provide(
      SpacesService.layerFromPath(dbPath).pipe(
        Layer.provide(identity),
        Layer.provideMerge(Settings.layerTest({ spacesEnabled: enabled })),
      ),
    ),
  );
}, Effect.provide(TestClock.layer()));
const boot = Effect.fn("SpacesServiceTest.boot")(function* () {
  const service = yield* SpacesService.SpacesService;
  const library = yield* service.listSpaces(env);
  const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
  const page = yield* service.createPage({
    ...common,
    mutationId: "page",
    spaceId: library.defaultSpaceId,
    baseRootOrderRevision: 0,
    title: "Page",
  });
  assert.equal(page.status, "saved");
  if (page.status !== "saved") return yield* Effect.die("Expected saved page");
  const request = (
    mutationId: string,
    baseRevision: number,
    mutations: readonly C.SpaceBlockMutation[],
    generation = 0,
  ): C.SpaceApplyBlockBatchInput => ({
    ...common,
    mutationId: C.SpaceMutationId.make(mutationId),
    pageId: page.page.id,
    baseRevision,
    generation,
    mutations,
  });
  return { service, library, common, page: page.page, request };
});

interface StoredRevision {
  readonly page_id: string;
  readonly to_revision: number;
  readonly mutation_id: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
  readonly payload: string;
  readonly logical_bytes: number;
  readonly asset_count: number;
}
const historyState = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const revisions =
      yield* sql<StoredRevision>`SELECT * FROM spaces_revisions ORDER BY page_id, to_revision`;
    const pages = yield* sql<{
      readonly page_id: string;
      readonly retained_revision_count: number;
      readonly retained_revision_bytes: number;
    }>`SELECT page_id, retained_revision_count, retained_revision_bytes FROM spaces_pages ORDER BY page_id`;
    const [core] = yield* sql<{
      readonly revision_bytes: number;
    }>`SELECT revision_bytes FROM spaces_core`;
    for (const row of revisions) {
      const pins = yield* sql<{
        readonly asset_id: string;
      }>`SELECT asset_id FROM spaces_revision_asset_refs WHERE page_id = ${row.page_id} AND to_revision = ${row.to_revision} ORDER BY asset_id`;
      assert.equal(row.asset_count, pins.length);
      assert.equal(
        row.logical_bytes,
        bytes({
          pageId: row.page_id,
          toRevision: row.to_revision,
          mutationId: row.mutation_id,
          createdAtMs: row.created_at_ms,
          expiresAtMs: row.expires_at_ms,
          payload: row.payload,
          assetIds: pins.map((pin) => pin.asset_id),
        }),
      );
    }
    for (const page of pages) {
      const retained = revisions.filter((row) => row.page_id === page.page_id);
      assert.equal(page.retained_revision_count, retained.length);
      assert.equal(
        page.retained_revision_bytes,
        retained.reduce((sum, row) => sum + row.logical_bytes, 0),
      );
    }
    assert.equal(
      core?.revision_bytes,
      revisions.reduce((sum, row) => sum + row.logical_bytes, 0),
    );
    return { revisions, pages, bytes: core!.revision_bytes };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

const prepareHistoryDelta = Effect.fn("SpacesServiceTest.prepareHistoryDelta")(function* (
  service: SpacesService.SpacesService["Service"],
  common: { readonly environmentId: EnvironmentId; readonly receiptEpoch: C.SpaceReceiptEpoch },
  pageId: C.SpacePageId,
  prefix: string,
  targetBytes: number,
  blockCount = 99,
) {
  const current = (yield* service.getPage({ ...env, pageId })).page;
  const now = yield* Clock.currentTimeMillis;
  const before = {
    pageId,
    spaceId: current.spaceId,
    title: current.title,
    revision: current.revision + Math.ceil(blockCount / 7),
    rootOrder: current.rootOrder,
    createdAt: current.createdAt,
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  };
  const mutationId = `${prefix}-delta`;
  const newId = C.SpaceBlockId.make(`${prefix}-new`);
  const unit = blockCount === 99 ? '界\\"\n' : "\\";
  const values = (repeat: number, extra: number) =>
    Array.from({ length: blockCount }, (_, i) => ({
      ...block(`${prefix}-${i}`, i + 1),
      type: "code",
      content: {
        language: "",
        text: unit.repeat(repeat) + (i === blockCount - 1 ? "x".repeat(extra) : ""),
      },
    }));
  const measure = (values: readonly C.SpaceBlock[]) => {
    const payload = JSON.stringify({
      version: 3,
      pageBefore: before,
      ownerBefore: null,
      trashBefore: null,
      blocksBefore: [
        ...values.map((value) => ({
          id: value.id,
          row: {
            block_id: value.id,
            page_id: pageId,
            parent_id: null,
            rank: value.order,
            payload: JSON.stringify(value),
            logical_bytes: bytes(value),
            deleted: 0,
            merged_into: null,
          },
        })),
        { id: newId, row: null },
      ],
    });
    return bytes({
      pageId,
      toRevision: before.revision + 1,
      mutationId,
      createdAtMs: now,
      expiresAtMs: now + 604_800_000,
      payload,
      assetIds: [],
    });
  };
  let low = 0,
    high = Math.floor(32_768 / (bytes(unit) - 2));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(values(mid, 0)) <= targetBytes) low = mid;
    else high = mid - 1;
  }
  const prepared = values(low, targetBytes - measure(values(low, 0)));
  assert.equal(measure(prepared), targetBytes);
  assert.isTrue(prepared.every((value) => bytes(value) <= 32_768));
  let revision = current.revision;
  for (let start = 0; start < prepared.length; start += 7) {
    yield* service.applyBlockBatch({
      ...common,
      mutationId: `${prefix}-fill-${start}`,
      pageId,
      baseRevision: revision++,
      generation: 0,
      mutations: prepared
        .slice(start, start + 7)
        .map((value) => ({ kind: "insert", block: value })),
    });
  }
  return {
    ...common,
    mutationId,
    pageId,
    baseRevision: revision,
    generation: 1,
    mutations: [
      ...prepared.map((value) => ({ kind: "delete" as const, blockId: value.id })),
      { kind: "insert" as const, block: block(newId, 100) },
    ],
  };
});

const structureState = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      core: yield* sql`SELECT * FROM spaces_core`,
      spaces: yield* sql`SELECT * FROM spaces ORDER BY space_id`,
      pages: yield* sql`SELECT * FROM spaces_pages ORDER BY page_id`,
      blocks: yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`,
      owners: yield* sql`SELECT * FROM spaces_page_owners ORDER BY child_page_id`,
      ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
      receipts: yield* sql`SELECT * FROM spaces_receipts ORDER BY mutation_id`,
      history: yield* sql`SELECT * FROM spaces_revisions ORDER BY page_id,to_revision`,
      blockPins: yield* sql`SELECT * FROM spaces_block_asset_refs ORDER BY block_id`,
      revisionPins:
        yield* sql`SELECT * FROM spaces_revision_asset_refs ORDER BY page_id,to_revision,asset_id`,
    };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

const childPage = Effect.fn("SpacesServiceTest.childPage")(function* (
  service: SpacesService.SpacesService["Service"],
  common: { readonly environmentId: EnvironmentId; readonly receiptEpoch: C.SpaceReceiptEpoch },
  parent: C.SpacePageId,
  mutationId: string,
  beforeBlockId: C.SpaceBlockId | null = null,
  parentId: C.SpaceBlockId | null = null,
) {
  const placement = { pageId: parent, parentId, beforeBlockId };
  const inspected = yield* service.inspectStructure({
    ...env,
    target: { kind: "blocks", pageId: parent, blockIds: [] },
    destination: { kind: "child", placement },
  });
  const result = yield* service.createChildPage({
    ...common,
    mutationId,
    title: mutationId,
    placement,
    guards: inspected.guards,
  });
  if (result.status !== "saved") return yield* Effect.die("Expected child page");
  return result;
});
const rootPage = Effect.fn("SpacesServiceTest.rootPage")(function* (
  service: SpacesService.SpacesService["Service"],
  common: { readonly environmentId: EnvironmentId; readonly receiptEpoch: C.SpaceReceiptEpoch },
  spaceId: C.SpaceId,
  mutationId: string,
) {
  const library = yield* service.listPages({ ...env, spaceId });
  const result = yield* service.createPage({
    ...common,
    mutationId,
    spaceId,
    title: mutationId,
    baseRootOrderRevision: library.space.rootOrderRevision,
  });
  if (result.status !== "saved") return yield* Effect.die("Expected root page");
  return result.page;
});
const moveIntent = Effect.fn("SpacesServiceTest.moveIntent")(function* (
  service: SpacesService.SpacesService["Service"],
  common: { readonly environmentId: EnvironmentId; readonly receiptEpoch: C.SpaceReceiptEpoch },
  pageId: C.SpacePageId,
  mutationId: string,
  destination: C.SpacePageDestination,
): Effect.fn.Return<C.SpaceMovePageInput, C.SpaceServiceError> {
  const inspected = yield* service.inspectStructure({
    ...env,
    target: { kind: "page", pageId },
    destination,
  });
  return {
    ...common,
    pageId,
    mutationId: C.SpaceMutationId.make(mutationId),
    destination,
    guards: inspected.guards,
  };
});

const blockMoveIntent = Effect.fn("SpacesServiceTest.blockMoveIntent")(function* (
  service: SpacesService.SpacesService["Service"],
  common: { readonly environmentId: EnvironmentId; readonly receiptEpoch: C.SpaceReceiptEpoch },
  sourcePageId: C.SpacePageId,
  blockIds: readonly C.SpaceBlockId[],
  destination: C.SpaceBlockPlacement,
  mutationId: string,
): Effect.fn.Return<C.SpaceMoveBlocksInput, C.SpaceServiceError> {
  const inspected = yield* service.inspectStructure({
    ...env,
    target: { kind: "blocks", pageId: sourcePageId, blockIds },
    destination: { kind: "child", placement: destination },
  });
  return {
    ...common,
    sourcePageId,
    blockIds,
    destination,
    mutationId: C.SpaceMutationId.make(mutationId),
    guards: inspected.guards,
  };
});

const recoveryIntent = Effect.fn("SpacesServiceTest.recoveryIntent")(function* (
  service: SpacesService.SpacesService["Service"],
  common: { readonly environmentId: EnvironmentId; readonly receiptEpoch: C.SpaceReceiptEpoch },
  pageId: C.SpacePageId,
  recovery: C.SpaceRecoveryOperation,
  mutationId: string,
): Effect.fn.Return<C.SpacePageRecoveryInput, C.SpaceServiceError> {
  const inspected = yield* service.inspectStructure({
    ...env,
    target: { kind: "page", pageId },
    recovery,
  });
  return {
    ...common,
    pageId,
    mutationId: C.SpaceMutationId.make(mutationId),
    guards: inspected.guards,
  };
});

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
          yield* sql`INSERT INTO spaces_block_asset_refs VALUES (${child.ownerBlockId},'retained-owner-hook')`;
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
              yield* sql`INSERT INTO spaces_block_asset_refs VALUES (${value.id},'shared-recovery-asset')`;
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
            yield* sql`INSERT INTO spaces_block_asset_refs VALUES (${media.id},'recovery-asset')`;
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

  it.effect(
    "rebalances a real exhausted sibling gap for multiple selected roots in requested order",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "multi-rank-dest",
          );
          const roots = [block("multi-a"), block("multi-b", 2)];
          yield* service.applyBlockBatch(
            request(
              "multi-roots",
              0,
              roots.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const peers = [0, 1].map((i) => ({
            ...block(`multi-peer-${i}`, i),
            futureEnvelope: { untouched: ["界", i] },
          }));
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "multi-peers",
            pageId: destination.id,
            baseRevision: 0,
            generation: 0,
            mutations: peers.map((value) => ({ kind: "insert", block: value })),
          });
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [roots[1]!.id, roots[0]!.id],
            { pageId: destination.id, parentId: null, beforeBlockId: peers[1]!.id },
            "multi-gap",
          );
          const moved = yield* service.moveBlocks(input);
          if (moved.status !== "saved") return yield* Effect.die("Expected multi move");
          assert.deepEqual(
            moved.changed.pages.map((row) => row.revision),
            [2, 2],
          );
          const body = (yield* service.readBlocks({ ...env, pageId: destination.id, revision: 2 }))
            .blocks;
          assert.deepEqual(
            body.map((value) => value.id),
            [peers[0]!.id, roots[1]!.id, roots[0]!.id, peers[1]!.id],
          );
          assert.equal(new Set(body.map((value) => value.order)).size, 4);
          assert.isTrue(body.every((value) => /^[0-9a-f]{32}$/.test(value.order)));
          assert.deepEqual(body[0]!.futureEnvelope, peers[0]!.futureEnvelope);
          assert.deepEqual(body[3]!.futureEnvelope, peers[1]!.futureEnvelope);
          const history = yield* historyState(dbPath);
          const delta = JSON.parse(
            history.revisions.find(
              (row) => row.page_id === destination.id && row.mutation_id === "multi-gap",
            )!.payload,
          );
          assert.equal(delta.blocksBefore.length, 4);
        }),
      ),
  );

  it.effect(
    "bounds moved list depth and exact UTF8 work bytes before changing any ownership or body",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "depth-destination",
          );
          const list = { ...block("depth-moving"), type: "bulleted_item" };
          const leaf = block("depth-moving-leaf", 1, list.id);
          yield* service.applyBlockBatch(
            request(
              "depth-source",
              0,
              [list, leaf].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const ancestors = Array.from({ length: 15 }, (_, i) => ({
            ...block(
              `dest-ancestor-${i}`,
              1,
              i === 0 ? null : C.SpaceBlockId.make(`dest-ancestor-${i - 1}`),
            ),
            type: "bulleted_item",
          }));
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "depth-dest-seed",
            pageId: destination.id,
            baseRevision: 0,
            generation: 0,
            mutations: ancestors.map((value) => ({ kind: "insert", block: value })),
          });
          const placement = {
            pageId: destination.id,
            parentId: ancestors[14]!.id,
            beforeBlockId: null,
          };
          const before = yield* structureState(dbPath);
          const over = {
            ...common,
            mutationId: "depth-over",
            sourcePageId: page.id,
            blockIds: [list.id],
            destination: placement,
            guards: { pages: [], roots: [] },
          };
          const error = yield* Effect.flip(service.moveBlocks(over));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") {
            assert.equal(error.limit, "maxDepth");
            assert.equal(error.actual, 17);
          }
          assert.deepEqual(yield* structureState(dbPath), before);
          const atLimit = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [list.id],
            { ...placement, parentId: ancestors[13]!.id },
            "depth-at-limit",
          );
          assert.equal((yield* service.moveBlocks(atLimit)).status, "saved");
          const wide = Array.from({ length: 5 }, (_, i) => {
            const value = {
              ...block(`wide-moving-${i}`, i + 1),
              type: "code",
              content: { language: "", text: "" },
            };
            return {
              ...value,
              content: { language: "", text: "界".repeat(Math.floor((32768 - bytes(value)) / 3)) },
            };
          });
          yield* service.applyBlockBatch(
            request(
              "wide-seed",
              2,
              wide.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const inspection = yield* service.inspectStructure({
            ...env,
            target: { kind: "blocks", pageId: page.id, blockIds: wide.map((value) => value.id) },
            destination: {
              kind: "child",
              placement: { pageId: destination.id, parentId: null, beforeBlockId: null },
            },
          });
          const state = yield* structureState(dbPath);
          const refused = yield* Effect.flip(
            service.moveBlocks({
              ...common,
              mutationId: "wide-write",
              sourcePageId: page.id,
              blockIds: wide.map((value) => value.id),
              destination: { pageId: destination.id, parentId: null, beforeBlockId: null },
              guards: inspection.guards,
            }),
          );
          assert.equal(refused._tag, "SpaceLimitExceededError");
          if (refused._tag === "SpaceLimitExceededError")
            assert.equal(refused.limit, "maxMutationBytes");
          assert.deepEqual(yield* structureState(dbPath), state);
        }),
      ),
  );

  it.effect(
    "moves disjoint block roots and their owned pages across spaces while preserving opaque data and pins",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, request } = yield* boot();
          const createdSpace = yield* service.createSpace({
            ...common,
            mutationId: "blocks-space",
            title: "Elsewhere",
          });
          if (createdSpace.status !== "saved") return yield* Effect.die("Expected space");
          const destination = yield* rootPage(
            service,
            common,
            createdSpace.space.id,
            "blocks-dest",
          );
          const container = { ...block("move-list"), type: "bulleted_item" };
          const leaf = { ...block("move-leaf", 1, container.id), extra: { keep: ["界", 7] } };
          const tail = block("move-tail", 2);
          yield* service.applyBlockBatch(
            request(
              "move-seed",
              0,
              [container, leaf, tail].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const owned = yield* childPage(
            service,
            common,
            page.id,
            "blocks-owned",
            null,
            container.id,
          );
          const grandchild = yield* childPage(service, common, owned.page.id, "blocks-grandchild");
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [old] =
              yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id=${leaf.id}`;
            const payload = JSON.stringify({
              ...leaf,
              type: "image",
              content: { assetId: "legacy-asset", caption: [{ text: "旧图", marks: [] }] },
              futureEnvelope: { preserve: true },
            });
            yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${Buffer.byteLength(payload, "utf8")} WHERE block_id=${leaf.id}`;
            yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${Buffer.byteLength(payload, "utf8") - Number(old!.logical_bytes)} WHERE page_id=${page.id}`;
            yield* sql`INSERT INTO spaces_block_asset_refs VALUES (${leaf.id},'legacy-asset')`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const original = yield* structureState(dbPath);
          const placement = { pageId: destination.id, parentId: null, beforeBlockId: null };
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [container.id, tail.id],
            placement,
            "blocks-cross-space",
          );
          assert.isTrue(input.guards.pages.some((guard) => guard.pageId === grandchild.page.id));
          assert.equal(input.guards.roots.length, 2);
          const moved = yield* service.moveBlocks(input);
          if (moved.status !== "saved") return yield* Effect.die("Expected moved blocks");
          assert.deepEqual(moved.blockIds, [container.id, tail.id]);
          assert.equal(moved.changed.pages.length, 4);
          assert.deepEqual(moved.changed.roots, []);
          assert.deepEqual(yield* service.moveBlocks(input), moved);
          assert.equal(
            (yield* service.getPage({ ...env, pageId: grandchild.page.id })).page.spaceId,
            createdSpace.space.id,
          );
          const ownedNow = (yield* service.getPage({ ...env, pageId: owned.page.id })).page;
          assert.deepEqual(ownedNow.location, {
            kind: "child",
            spaceId: createdSpace.space.id,
            ownerBlockId: owned.ownerBlockId,
            parentPageId: destination.id,
          });
          const current = yield* structureState(dbPath);
          assert.deepEqual(current.ids, original.ids);
          assert.deepEqual(current.owners, original.owners);
          assert.deepEqual(current.blockPins, original.blockPins);
          const oldLeaf = original.blocks.find((row) => row.block_id === leaf.id)!;
          assert.equal(
            current.blocks.find((row) => row.block_id === leaf.id)!.payload,
            oldLeaf.payload,
          );
          assert.equal(
            current.blocks.find((row) => row.block_id === leaf.id)!.page_id,
            destination.id,
          );
          assert.deepEqual(
            current.pages.filter((row) => row.page_id === page.id).map((row) => row.block_count),
            [0],
          );
          const delta = current.history.filter((row) => row.mutation_id === input.mutationId);
          assert.equal(delta.length, 4);
          for (const id of [page.id, destination.id]) {
            const revision = delta.find((row) => row.page_id === id)!;
            assert.isTrue(
              current.revisionPins.some(
                (pin) =>
                  pin.page_id === id &&
                  pin.to_revision === revision.to_revision &&
                  pin.asset_id === "legacy-asset",
              ),
            );
            const preimage = JSON.parse(String(revision.payload));
            assert.deepEqual(
              preimage.blocksBefore.find((row: { id: string }) => row.id === leaf.id).row.payload,
              oldLeaf.payload,
            );
          }
          const unchanged = yield* historyState(dbPath);
          const noop = yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              destination.id,
              [container.id, tail.id],
              placement,
              "blocks-noop",
            ),
          );
          if (noop.status !== "saved") return yield* Effect.die("Expected no-op");
          assert.deepEqual(noop.changed, { pages: [], roots: [] });
          assert.deepEqual(yield* historyState(dbPath), unchanged);
          const reordered = yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              destination.id,
              [tail.id],
              { ...placement, beforeBlockId: container.id },
              "blocks-reorder",
            ),
          );
          assert.equal(reordered.status, "saved");
          const window = yield* service.readBlocks({
            ...env,
            pageId: destination.id,
            revision: (yield* service.getPage({ ...env, pageId: destination.id })).page.revision,
          });
          assert.deepEqual(
            window.blocks.map((value) => value.id),
            [tail.id, container.id, leaf.id, owned.ownerBlockId],
          );
          const resolved = yield* service.resolveReference({
            ...env,
            target: { kind: "block", blockId: leaf.id },
            pageIdHint: page.id,
            spaceIdHint: C.SpaceId.make("stale-space"),
          });
          assert.equal(resolved.status, "resolved");
          if (resolved.status === "resolved") assert.equal(resolved.page.id, destination.id);
        }),
      ),
  );

  it.effect(
    "rejects overlapping selections, cycles, stale or missing block-move guards and complete closure overflow atomically",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "guard-block-dest",
          );
          const parent = { ...block("guard-list"), type: "bulleted_item" };
          const child = block("guard-leaf", 1, parent.id);
          yield* service.applyBlockBatch(
            request(
              "guard-list-seed",
              0,
              [parent, child].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const owned = yield* childPage(
            service,
            common,
            page.id,
            "guard-block-owned",
            null,
            parent.id,
          );
          const destinationPlacement = {
            pageId: destination.id,
            parentId: null,
            beforeBlockId: null,
          };
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [parent.id],
            destinationPlacement,
            "block-stale",
          );
          yield* service.updatePage({
            ...common,
            mutationId: "block-dest-edit",
            pageId: destination.id,
            baseRevision: 0,
            title: "Edited",
          });
          const history = yield* historyState(dbPath);
          assert.equal((yield* service.moveBlocks(input)).status, "conflict");
          const fresh = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [parent.id],
            destinationPlacement,
            "block-missing",
          );
          assert.equal(
            (yield* service.moveBlocks({
              ...fresh,
              guards: {
                ...fresh.guards,
                pages: fresh.guards.pages.filter((guard) => guard.pageId !== owned.page.id),
              },
            })).status,
            "conflict",
          );
          assert.deepEqual(yield* historyState(dbPath), history);
          for (const value of [
            {
              ...fresh,
              mutationId: "block-duplicates",
              guards: { ...fresh.guards, pages: [...fresh.guards.pages, fresh.guards.pages[0]!] },
            },
            { ...fresh, mutationId: "block-overlap", blockIds: [parent.id, child.id] },
            { ...fresh, mutationId: "block-repeat", blockIds: [parent.id, parent.id] },
            {
              ...fresh,
              mutationId: "block-list-cycle",
              destination: { pageId: page.id, parentId: parent.id, beforeBlockId: null },
            },
            {
              ...fresh,
              mutationId: "block-page-cycle",
              destination: { pageId: owned.page.id, parentId: null, beforeBlockId: null },
            },
          ]) {
            const before = yield* structureState(dbPath);
            assert.equal(
              (yield* Effect.flip(service.moveBlocks(value)))._tag,
              "SpaceValidationError",
            );
            assert.deepEqual(yield* structureState(dbPath), before);
          }
          const packed = { ...block("packed-root", 3), type: "bulleted_item" };
          const packedChildren = Array.from({ length: 96 }, (_, i) =>
            block(`packed-child-${i}`, i + 1, packed.id),
          );
          yield* service.applyBlockBatch(
            request(
              "packed-seed",
              2,
              [packed, ...packedChildren].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const atLimit = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [packed.id],
            destinationPlacement,
            "packed-100",
          );
          assert.equal((yield* service.moveBlocks(atLimit)).status, "saved");
          const emptyDestination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "packed-empty",
          );
          const back = yield* blockMoveIntent(
            service,
            common,
            destination.id,
            [packed.id],
            { pageId: emptyDestination.id, parentId: null, beforeBlockId: null },
            "packed-101",
          );
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "packed-extra",
            pageId: destination.id,
            baseRevision: (yield* service.getPage({ ...env, pageId: destination.id })).page
              .revision,
            generation: 0,
            mutations: [{ kind: "insert", block: block("packed-extra-leaf", 97, packed.id) }],
          });
          const before = yield* structureState(dbPath);
          const error = yield* Effect.flip(service.moveBlocks(back));
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
    "resolves stable merged identities after moves, further joins and final deletion without resurrecting bodies",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "reference-dest",
          );
          const [a, b, c] = [block("ref-a"), block("ref-b", 2), block("ref-c", 3)] as const;
          yield* service.applyBlockBatch(
            request(
              "refs-seed",
              0,
              [a, b, c].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          yield* service.applyBlockBatch(
            request("refs-join", 1, [{ kind: "delete", blockId: a.id, mergedInto: b.id }]),
          );
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [b.id, c.id],
            { pageId: destination.id, parentId: null, beforeBlockId: null },
            "refs-move",
          );
          assert.equal((yield* service.moveBlocks(input)).status, "saved");
          const resolve = () =>
            service.resolveReference({
              ...env,
              target: { kind: "block", blockId: a.id },
              pageIdHint: page.id,
            });
          const first = yield* resolve();
          assert.equal(first.status, "merged");
          if (first.status === "merged") {
            assert.equal(first.blockId, b.id);
            assert.equal(first.requestedBlockId, a.id);
            assert.equal(first.page.id, destination.id);
          }
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "refs-second-join",
            pageId: destination.id,
            baseRevision: 1,
            generation: 0,
            mutations: [{ kind: "delete", blockId: b.id, mergedInto: c.id }],
          });
          const second = yield* resolve();
          assert.equal(second.status, "merged");
          if (second.status === "merged") assert.equal(second.blockId, c.id);
          yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              destination.id,
              [c.id],
              { pageId: page.id, parentId: null, beforeBlockId: null },
              "refs-return",
            ),
          );
          const moved = yield* resolve();
          if (moved.status !== "merged") return yield* Effect.die("Expected merged target");
          assert.equal(moved.page.id, page.id);
          yield* service.applyBlockBatch(
            request("refs-final-delete", 4, [{ kind: "delete", blockId: c.id }]),
          );
          assert.deepEqual(yield* resolve(), { status: "deleted" });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(
              yield* sql`SELECT * FROM spaces_blocks WHERE block_id IN ('ref-a','ref-b','ref-c')`,
              [],
            );
            const ids =
              yield* sql`SELECT id,deleted,merged_into FROM spaces_ids WHERE id IN ('ref-a','ref-b','ref-c') ORDER BY id`;
            assert.deepEqual(ids, [
              { id: a.id, deleted: 1, merged_into: c.id },
              { id: b.id, deleted: 1, merged_into: c.id },
              { id: c.id, deleted: 1, merged_into: null },
            ]);
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
            assert.equal(
              (yield* sql`SELECT block_count,block_bytes FROM spaces_pages WHERE page_id=${page.id}`)[0]
                ?.block_count,
              0,
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch(request("refs-reuse", 5, [{ kind: "insert", block: a }])),
            ))._tag,
            "SpaceValidationError",
          );
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: C.SpaceBlockId.make("never-known") },
            }),
            { status: "unavailable" },
          );
          const pageReference = yield* service.resolveReference({
            ...env,
            target: { kind: "page", pageId: destination.id },
            pageIdHint: page.id,
          });
          assert.equal(pageReference.status, "resolved");
          if (pageReference.status === "resolved")
            assert.equal(pageReference.page.id, destination.id);
        }),
      ),
  );

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
            yield* service.getPage({ ...env, pageId: page.id });
            const first = yield* historyState(dbPath);
            assert.equal(first.revisions.length, 1);
            assert.equal(first.bytes, 4_194_304);
            yield* TestClock.setTime(0);
            yield* service.getPage({ ...env, pageId: page.id });
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
            yield* service.getPage({ ...env, pageId: page.id });
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

  it.effect(
    "never opens disabled storage, gates every operation, and retains data over disable/re-enable",
    () =>
      fixture(
        (dbPath) =>
          Effect.gen(function* () {
            const service = yield* SpacesService.SpacesService;
            const settings = yield* Settings.ServerSettingsService;
            const fs = yield* FileSystem.FileSystem;
            assert.isNull(yield* service.getCapability(environmentId));
            const operations: ReadonlyArray<
              (raw: unknown) => Effect.Effect<unknown, C.SpaceServiceError>
            > = [
              service.listSpaces,
              service.listPages,
              service.getPage,
              service.readBlocks,
              service.createSpace,
              service.renameSpace,
              service.setDefaultSpace,
              service.createPage,
              service.updatePage,
              service.applyBlockBatch,
              service.lookupMutationReceipt,
              service.createChildPage,
              service.movePage,
              service.inspectStructure,
              service.moveBlocks,
              service.resolveReference,
              service.trashPage,
              service.restorePage,
              service.permanentlyDeletePage,
              service.listTrash,
            ];
            for (const operation of operations) {
              assert.equal(
                yield* operation({}).pipe(
                  Effect.match({
                    onFailure: (error) => error._tag,
                    onSuccess: () => "unexpected success",
                  }),
                ),
                "SpacesDisabledError",
              );
            }
            assert.isFalse(yield* fs.exists(dbPath));
            yield* settings.updateSettings({ spacesEnabled: true });
            assert.equal(
              (yield* Effect.flip(service.listSpaces({ environmentId: "another" })))._tag,
              "SpaceEnvironmentMismatchError",
            );
            assert.isFalse(yield* fs.exists(dbPath));
            const library = yield* service.listSpaces(env);
            const saved = yield* service.createSpace({
              ...env,
              receiptEpoch: library.mutationAdmission.epoch,
              mutationId: "create",
              title: "Retained",
            });
            yield* settings.updateSettings({ spacesEnabled: false });
            assert.isNull(yield* service.getCapability(environmentId));
            assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
            yield* settings.updateSettings({ spacesEnabled: true });
            const again = yield* service.listSpaces(env);
            assert.isTrue(
              again.items.some(
                (space) => space.id === saved.space.id && space.title === "Retained",
              ),
            );
            assert.equal((yield* service.getCapability(environmentId))?.version, 2);
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(SqlClient.SqlClient)));
          }),
        false,
      ),
  );

  it.effect("initialization failure is typed and leaves disabled startup usable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-unavailable-" });
      const obstacle = path.join(directory, "file");
      yield* fs.writeFileString(obstacle, "not a directory");
      yield* Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        const settings = yield* Settings.ServerSettingsService;
        assert.isNull(yield* service.getCapability(environmentId));
        yield* settings.updateSettings({ spacesEnabled: true });
        assert.isNull(yield* service.getCapability(environmentId));
        const failure = yield* Effect.flip(service.listSpaces(env));
        assert.equal(failure._tag, "SpacesUnavailableError");
        if (failure._tag === "SpacesUnavailableError") assert.equal(failure.stage, "initializing");
        yield* settings.updateSettings({ spacesEnabled: false });
        assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
      }).pipe(
        Effect.provide(
          SpacesService.layerFromPath(path.join(obstacle, "spaces.sqlite")).pipe(
            Layer.provide(identity),
            Layer.provideMerge(Settings.layerTest()),
          ),
        ),
      );
      assert.equal(yield* fs.readFileString(obstacle), "not a directory");
    }),
  );

  it.effect(
    "serializes first acquisition and commits a single guarded winner with a durable conflict",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const libraries = yield* Effect.all([service.listSpaces(env), service.listSpaces(env)], {
            concurrency: "unbounded",
          });
          assert.deepEqual(libraries[0], libraries[1]);
          const { request, page } = yield* boot();
          const a = request("a", 0, [{ kind: "insert", block: block("a") }], 3);
          const b = request("b", 0, [{ kind: "insert", block: block("b") }], 4);
          const outcomes = yield* Effect.all(
            [service.applyBlockBatch(a), service.applyBlockBatch(b)],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["conflict", "saved"]);
          const loser = outcomes[0].status === "conflict" ? a : b;
          const conflict = outcomes.find((outcome) => outcome.status === "conflict")!;
          assert.equal(conflict.revision, 1);
          if (conflict.status === "conflict") assert.equal(conflict.current.pages[0]?.revision, 1);
          const window = yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 });
          assert.equal(window.blocks.length, 1);
          const found = yield* service.lookupMutationReceipt({
            request: { operation: "applyBlockBatch", input: loser },
          });
          assert.deepEqual(found, {
            status: "found",
            receipt: { operation: "applyBlockBatch", result: conflict },
          });
          assert.deepEqual(yield* service.applyBlockBatch(loser), conflict);
        }),
      ),
  );

  it.effect(
    "replays exact receipts after revisions and expiry, rejects mismatched intent and never executes an expired absence",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, common, page } = yield* boot();
          const first = request("save", 0, [{ kind: "insert", block: block("a") }], 7);
          const saved = yield* service.applyBlockBatch(first);
          yield* service.updatePage({
            ...common,
            pageId: page.id,
            mutationId: "rename",
            baseRevision: 1,
            title: "New",
          });
          const missing = { ...first, mutationId: "never-submitted" };
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: missing },
            }),
            { status: "absent" },
          );
          for (const changed of [
            { ...first, generation: 8 },
            { ...first, receiptEpoch: "other" },
            { ...first, mutations: [{ kind: "insert", block: { ...block("a"), opaque: 1 } }] },
          ]) {
            assert.equal(
              (yield* Effect.flip(service.applyBlockBatch(changed)))._tag,
              "SpaceMutationIdMismatchError",
            );
          }
          assert.equal(
            (yield* Effect.flip(
              service.createSpace({ ...common, mutationId: "save", title: "different operation" }),
            ))._tag,
            "SpaceMutationIdMismatchError",
          );
          yield* TestClock.adjust("2 days");
          assert.deepEqual(yield* service.applyBlockBatch(first), saved);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: missing },
            }),
            { status: "unknown" },
          );
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(missing)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* TestClock.setTime(0);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(missing)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* TestClock.adjust("10 days");
          // Known receipts replay even past retention until a bounded issuance pass actually removes them.
          assert.deepEqual(yield* service.applyBlockBatch(first), saved);
          const current = yield* service.listSpaces(env);
          assert.notEqual(current.mutationAdmission.epoch, first.receiptEpoch);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: first },
            }),
            { status: "unknown" },
          );
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(first)))._tag,
            "SpaceMutationAdmissionError",
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 2);
        }),
      ),
  );

  it.effect(
    "rejects excess properties on original raw requests and the fixed raw ceiling before stripping or fingerprinting",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request } = yield* boot();
          const valid = request("strict", 0, [{ kind: "insert", block: block("a") }]);
          for (const raw of [
            { ...valid, extra: true },
            { ...valid, mutations: [{ ...valid.mutations[0], extra: true }] },
          ]) {
            assert.equal(
              (yield* Effect.flip(service.applyBlockBatch(raw)))._tag,
              "SpaceValidationError",
            );
          }
          const huge = { ...valid, extra: "x".repeat(1_048_576) };
          const error = yield* Effect.flip(service.applyBlockBatch(huge));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.maximum, 1_048_576);
          const lookup = { request: { operation: "applyBlockBatch", input: valid }, extra: true };
          assert.equal(
            (yield* Effect.flip(service.lookupMutationReceipt(lookup)))._tag,
            "SpaceValidationError",
          );
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: valid },
            }),
            { status: "absent" },
          );
        }),
      ),
  );

  it.effect(
    "preserves exact UTF-8 titles and block envelopes at the byte boundary, rejecting one byte over atomically",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, request, page } = yield* boot();
          const title = "界".repeat(170);
          assert.equal(bytes(title), 512);
          const savedTitle = yield* service.updatePage({
            ...common,
            pageId: page.id,
            mutationId: "title",
            baseRevision: 0,
            title,
          });
          assert.equal(savedTitle.status, "saved");
          const badTitle = {
            ...common,
            pageId: page.id,
            mutationId: "bad-title",
            baseRevision: 1,
            title: title + "a",
          };
          const failure = yield* Effect.flip(service.updatePage(badTitle));
          assert.equal(failure._tag, "SpaceLimitExceededError");
          const small = {
            ...block("a"),
            content: { runs: [{ text: "", marks: [] }] },
            opaque: { future: "kept" },
          };
          const room = 32_768 - bytes(small);
          const text =
            "界".repeat(Math.floor((room - 16) / 3)) +
            "x".repeat(room - 3 * Math.floor((room - 16) / 3));
          const exact = { ...small, content: { runs: [{ text, marks: [] }] } };
          assert.equal(bytes(exact), 32_768);
          yield* service.applyBlockBatch(request("exact", 1, [{ kind: "insert", block: exact }]));
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks,
            [exact],
          );
          const oversized = { ...exact, content: { runs: [{ text: text + "x", marks: [] }] } };
          const bad = request("too-large", 2, [{ kind: "replace", block: oversized }]);
          const blockError = yield* Effect.flip(service.applyBlockBatch(bad));
          assert.equal(blockError._tag, "SpaceLimitExceededError");
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: bad },
            }),
            { status: "absent" },
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.title, title);
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks,
            [exact],
          );
        }),
      ),
  );

  it.effect(
    "validates the final graph, preserves unloaded children, and retains durable minimal merge identities",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, request, page, common, library } = yield* boot();
          const parent = { ...block("parent"), type: "bulleted_item" };
          const child = block("child", 1, parent.id);
          const other = block("other", 2);
          yield* service.applyBlockBatch(
            request(
              "initial",
              0,
              [parent, child, other].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const window = yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: 1,
            limit: 1,
          });
          assert.deepEqual(window.blocks, [parent]);
          assert.isNotNull(window.nextCursor);
          const next = yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: 1,
            limit: 1,
            cursor: window.nextCursor,
          });
          assert.deepEqual(next.blocks, [child]);
          const bad = request("parent-delete", 1, [{ kind: "delete", blockId: parent.id }]);
          const failure = yield* Effect.flip(service.applyBlockBatch(bad));
          assert.equal(failure._tag, "SpaceValidationError");
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: bad },
            }),
            { status: "absent" },
          );
          yield* service.applyBlockBatch(
            request("edit-window", 1, [
              {
                kind: "replace",
                block: { ...parent, content: { runs: [{ text: "Edited", marks: [] }] } },
              },
            ]),
          );
          const complete = yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 });
          assert.deepEqual(complete.blocks.slice(1), [child, other]);
          assert.equal(
            (yield* Effect.flip(
              service.readBlocks({
                ...env,
                pageId: page.id,
                revision: 2,
                cursor: window.nextCursor,
              }),
            ))._tag,
            "SpaceCursorStaleError",
          );
          const second = yield* service.createPage({
            ...common,
            mutationId: "second-page",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 1,
            title: "Second",
          });
          assert.equal(second.status, "saved");
          if (second.status !== "saved") return;
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch({
                ...request("cross-page", 0, [{ kind: "insert", block: block("child") }]),
                pageId: second.page.id,
              }),
            ))._tag,
            "SpaceValidationError",
          );
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch({
                ...request("cross-parent", 0, [
                  { kind: "insert", block: block("new-child", 1, parent.id) },
                ]),
                pageId: second.page.id,
              }),
            ))._tag,
            "SpaceValidationError",
          );
          yield* service.applyBlockBatch(
            request("join", 2, [{ kind: "delete", blockId: child.id, mergedInto: other.id }]),
          );
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch(
                request("resurrection", 3, [{ kind: "insert", block: child }]),
              ),
            ))._tag,
            "SpaceValidationError",
          );
          yield* service.applyBlockBatch(
            request("reparent-final", 3, [
              { kind: "delete", blockId: parent.id },
              { kind: "replace", block: { ...other, parentId: null } },
            ]),
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 4 })).blocks,
            [other],
          );
          // Independent storage inspection verifies the retained identity link and logical accounting.
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [tombstone] = yield* sql<{
              readonly merged_into: string;
              readonly deleted: number;
            }>`SELECT merged_into, deleted FROM spaces_ids WHERE id = 'child'`;
            assert.equal(tombstone?.merged_into, other.id);
            assert.equal(tombstone?.deleted, 1);
            assert.deepEqual(yield* sql`SELECT 1 FROM spaces_blocks WHERE block_id='child'`, []);
            const [counters] = yield* sql<{
              readonly block_count: number;
              readonly block_bytes: number;
            }>`SELECT block_count, block_bytes FROM spaces_pages WHERE page_id = ${page.id}`;
            const rows = yield* sql<{
              readonly payload: string;
            }>`SELECT payload FROM spaces_blocks WHERE page_id = ${page.id}`;
            assert.equal(counters?.block_count, 1);
            assert.equal(
              counters?.block_bytes,
              rows.reduce((sum, row) => sum + Buffer.byteLength(row.payload, "utf8"), 0),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }),
      ),
  );

  it.effect(
    "rejects cycles, non-list parents, duplicate IDs and excessive induced depth without partial commits",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const parent = { ...block("parent"), type: "bulleted_item" };
          for (const [name, mutations, reason] of [
            [
              "duplicate",
              [
                { kind: "insert", block: parent },
                { kind: "insert", block: parent },
              ],
              "duplicate_id",
            ],
            [
              "parent",
              [
                { kind: "insert", block: block("leaf") },
                { kind: "insert", block: block("child", 1, C.SpaceBlockId.make("leaf")) },
              ],
              "invalid_parent",
            ],
            [
              "cycle",
              [
                { kind: "insert", block: { ...parent, parentId: C.SpaceBlockId.make("child") } },
                {
                  kind: "insert",
                  block: { ...block("child", 1, parent.id), type: "bulleted_item" },
                },
              ],
              "cycle",
            ],
            [
              "order",
              [{ kind: "insert", block: { ...parent, order: "arbitrary" } }],
              "invalid_order",
            ],
          ] as const) {
            const input = request(name, 0, mutations);
            const error = yield* Effect.flip(service.applyBlockBatch(input));
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError") assert.equal(error.reason, reason);
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input },
              }),
              { status: "absent" },
            );
          }
          const chain = Array.from({ length: 16 }, (_, i) => ({
            ...block(`depth-${i}`, 1, i === 0 ? null : C.SpaceBlockId.make(`depth-${i - 1}`)),
            type: "bulleted_item",
          }));
          yield* service.applyBlockBatch(
            request(
              "depth",
              0,
              chain.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const deep = request("too-deep", 1, [
            { kind: "insert", block: block("depth-16", 1, chain[15]!.id) },
          ]);
          const error = yield* Effect.flip(service.applyBlockBatch(deep));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxDepth");
          assert.equal(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks.length,
            16,
          );
          // A new parent above an existing deep subtree must validate unloaded descendants too.
          const induced = request("induced-depth", 1, [
            { kind: "insert", block: { ...block("new-root"), type: "bulleted_item" } },
            { kind: "replace", block: { ...chain[0]!, parentId: C.SpaceBlockId.make("new-root") } },
          ]);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(induced)))._tag,
            "SpaceLimitExceededError",
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 1);
        }),
      ),
  );

  it.effect(
    "preserves opaque fields through reads and unrelated edits and refuses stripping or unsupported creation",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const rich = {
            ...block("opaque"),
            extension: { future: [1, "界"] },
            content: {
              runs: [
                { text: "old", marks: [{ type: "bold", version: 1, extra: "mark" }], extra: "run" },
              ],
              future: "content",
            },
          };
          yield* service.applyBlockBatch(request("opaque", 0, [{ kind: "insert", block: rich }]));
          const edited = {
            ...rich,
            content: { ...rich.content, runs: [{ ...rich.content.runs[0]!, text: "new" }] },
          };
          yield* service.applyBlockBatch(
            request("edit", 1, [
              { kind: "replace", block: edited },
              { kind: "insert", block: block("other", 2) },
            ]),
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks[0],
            edited,
          );
          for (const stripped of [
            { ...edited, extension: null },
            { ...edited, content: { runs: edited.content.runs } },
            { ...edited, content: { ...edited.content, runs: [{ text: "stripped", marks: [] }] } },
          ]) {
            const error = yield* Effect.flip(
              service.applyBlockBatch(request("strip", 2, [{ kind: "replace", block: stripped }])),
            );
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError")
              assert.equal(error.reason, "unsupported_block");
          }
          for (const unsupported of [
            { ...block("unsupported"), type: "child_page", content: { pageId: "elsewhere" } },
            { ...block("unsupported"), type: "image", content: { assetId: "asset" } },
            { ...block("unsupported"), version: 2 },
            { ...block("unsupported"), type: "future" },
          ])
            assert.equal(
              (yield* Effect.flip(
                service.applyBlockBatch(
                  request("unsupported", 2, [{ kind: "insert", block: unsupported }]),
                ),
              ))._tag,
              "SpaceValidationError",
            );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks[0],
            edited,
          );
        }),
      ),
  );

  it.effect(
    "bounds block reads by whole response bytes and keeps revision-bound list cursors and root guards",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page, common, library } = yield* boot();
          const large = Array.from({ length: 10 }, (_, i) => {
            const base = {
              ...block(`large-${i}`, i + 1),
              type: "code",
              content: { text: "", language: "text" },
            };
            return {
              ...base,
              content: { ...base.content, text: "x".repeat(32_768 - bytes(base)) },
            };
          });
          yield* service.applyBlockBatch(
            request(
              "large-a",
              0,
              large.slice(0, 5).map((value) => ({ kind: "insert", block: value })),
            ),
          );
          yield* service.applyBlockBatch(
            request(
              "large-b",
              1,
              large.slice(5).map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const first = yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 });
          assert.equal(first.blocks.length, 7);
          assert.isAtMost(bytes(first), 262_144);
          assert.isNotNull(first.nextCursor);
          const second = yield* service.readBlocks({
            ...env,
            pageId: page.id,
            revision: 2,
            cursor: first.nextCursor,
          });
          assert.deepEqual([...first.blocks, ...second.blocks], large);
          assert.isNull(second.nextCursor);
          assert.equal(
            (yield* Effect.flip(
              service.readBlocks({ ...env, pageId: page.id, revision: 2, limit: 101 }),
            ))._tag,
            "SpaceLimitExceededError",
          );
          const extra = yield* service.createSpace({ ...common, mutationId: "space", title: "" });
          const firstList = yield* service.listSpaces({ ...env, limit: 1 });
          assert.isNotNull(firstList.nextCursor);
          const rest = yield* service.listSpaces({
            ...env,
            cursor: firstList.nextCursor,
            limit: 1,
          });
          assert.equal(rest.items.length, 1);
          assert.equal(new Set([...firstList.items, ...rest.items].map((item) => item.id)).size, 2);
          const staleRoot = yield* service.createPage({
            ...common,
            mutationId: "stale-root",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "Refused",
          });
          assert.equal(staleRoot.status, "conflict");
          assert.equal(
            (yield* service.listPages({ ...env, spaceId: library.defaultSpaceId })).items.length,
            1,
          );
          yield* service.renameSpace({
            ...common,
            mutationId: "rename",
            spaceId: extra.space.id,
            baseRevision: 0,
            title: "Renamed",
          });
          assert.equal(
            (yield* Effect.flip(service.listSpaces({ ...env, cursor: firstList.nextCursor })))._tag,
            "SpaceCursorStaleError",
          );
          const switched = yield* service.setDefaultSpace({
            ...common,
            mutationId: "default",
            spaceId: extra.space.id,
            baseRevision: 1,
            defaultSpaceId: library.defaultSpaceId,
            baseDefaultRevision: 0,
          });
          assert.equal(switched.status, "saved");
          const after = yield* service.listSpaces(env);
          assert.equal(after.defaultSpaceId, extra.space.id);
          assert.equal(after.items.filter((space) => space.isDefault).length, 1);
        }),
      ),
  );

  it.effect(
    "keeps admitted writes alive across disable and owns lazy storage until the layer closes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-admission-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const accepted = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const settingsContext = yield* Layer.build(Settings.layerTest({ spacesEnabled: true }));
        const settings = Context.get(settingsContext, Settings.ServerSettingsService);
        const pauseIdentity = yield* Ref.make(false);
        const waitIdentity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Ref.get(pauseIdentity).pipe(
            Effect.flatMap((pause) =>
              pause
                ? Deferred.succeed(accepted, undefined).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                    Effect.as(environmentId),
                  )
                : Effect.succeed(environmentId),
            ),
          ),
        });
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          yield* Ref.set(pauseIdentity, true);
          const fiber = yield* service
            .createSpace({
              ...env,
              receiptEpoch: library.mutationAdmission.epoch,
              mutationId: "accepted",
              title: "Accepted before disable",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(accepted);
          yield* settings.updateSettings({ spacesEnabled: false });
          yield* Deferred.succeed(proceed, undefined);
          const saved = yield* Fiber.join(fiber);
          assert.equal(saved.space.title, "Accepted before disable");
          assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(waitIdentity),
              Layer.provide(Layer.succeedContext(settingsContext)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          assert.isTrue(library.items.some((space) => space.title === "Accepted before disable"));
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(identity),
              Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            ),
          ),
        );
      }),
  );
  it.effect(
    "enforces complete request bytes and induced node limits at their exact persisted boundaries",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const values = Array.from({ length: 8 }, (_, i) => {
            const base = {
              ...block(`request-${i}`, i + 1),
              type: "code",
              content: { language: "", text: "" },
            };
            return {
              ...base,
              content: { language: "", text: "x".repeat(i === 7 ? 0 : 32_768 - bytes(base)) },
            };
          });
          const input = request(
            "request-exact",
            0,
            values.map((value) => ({ kind: "insert", block: value })),
          );
          const room = 262_144 - bytes({ operation: "applyBlockBatch", input });
          values[7] = {
            ...values[7]!,
            content: {
              language: "",
              text:
                "界".repeat(Math.floor((room - 16) / 3)) +
                "x".repeat(room - 3 * Math.floor((room - 16) / 3)),
            },
          };
          const exact = request(
            "request-exact",
            0,
            values.map((value) => ({ kind: "insert", block: value })),
          );
          assert.equal(bytes({ operation: "applyBlockBatch", input: exact }), 262_144);
          const result = yield* service.applyBlockBatch(exact);
          assert.equal(result.status, "saved");
          const overValues = [...values];
          overValues[7] = {
            ...values[7]!,
            content: { ...values[7]!.content, text: Reflect.get(values[7]!.content, "text") + "x" },
          };
          const over = request(
            "request-over!",
            1,
            overValues.map((value) => ({ kind: "replace", block: value })),
          );
          // replace adds one byte per operation relative to insert; compensate before testing the boundary.
          const lastText = Reflect.get(overValues[7]!.content, "text") as string;
          overValues[7] = {
            ...overValues[7]!,
            content: { language: "", text: lastText.slice(0, -8) },
          };
          const tooLarge = {
            ...over,
            mutations: overValues.map((value) => ({ kind: "replace" as const, block: value })),
          };
          assert.equal(bytes({ operation: "applyBlockBatch", input: tooLarge }), 262_145);
          const error = yield* Effect.flip(service.applyBlockBatch(tooLarge));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError")
            assert.equal(error.limit, "maxMutationBytes");
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 1);
          const parent = { ...block("container", 10), type: "bulleted_item" };
          const children = Array.from({ length: 100 }, (_, i) =>
            block(`child-${i}`, i + 1, parent.id),
          );
          yield* service.applyBlockBatch(
            request(
              "nodes-exact",
              1,
              [parent, ...children.slice(0, 99)].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          yield* service.applyBlockBatch(
            request("last-child", 2, [{ kind: "insert", block: children[99]! }]),
          );
          const induced = request("induced", 3, [
            {
              kind: "replace",
              block: { ...parent, content: { runs: [{ text: "Changed", marks: [] }] } },
            },
          ]);
          const inducedError = yield* Effect.flip(service.applyBlockBatch(induced));
          assert.equal(inducedError._tag, "SpaceLimitExceededError");
          if (inducedError._tag === "SpaceLimitExceededError") {
            assert.equal(inducedError.limit, "maxMutationNodes");
            assert.equal(inducedError.actual, 101);
          }
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: induced },
            }),
            { status: "absent" },
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 3);
        }),
      ),
  );

  it.effect(
    "bounds raw decoding before the current policy and accounts for JSON escaping in IDs",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, common, page } = yield* boot();
          const base = { ...common, mutationId: "protocol", title: "" };
          const room = 1_048_576 - bytes({ operation: "createSpace", input: base });
          const exact = { ...base, title: "x".repeat(room) };
          const error = yield* Effect.flip(service.createSpace(exact));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.maximum, 262_144);
          const over = yield* Effect.flip(
            service.createSpace({ ...exact, title: exact.title + "x" }),
          );
          assert.equal(over._tag, "SpaceLimitExceededError");
          if (over._tag === "SpaceLimitExceededError") assert.equal(over.maximum, 1_048_576);
          const id = "界".repeat(42);
          assert.equal(bytes(id), 128);
          const allowed = { ...block(id), content: { runs: [{ text: '\n"', marks: [] }] } };
          yield* service.applyBlockBatch(
            request("id-exact", 0, [{ kind: "insert", block: allowed }]),
          );
          const rejected = request("id-over", 1, [{ kind: "insert", block: block(id + "x") }]);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(rejected)))._tag,
            "SpaceLimitExceededError",
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks,
            [allowed],
          );
        }),
      ),
  );

  it.effect(
    "commits identical concurrent intent once and accounts for persisted receipts independently",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, library } = yield* boot();
          const input = { ...common, mutationId: "same", title: "界" };
          const results = yield* Effect.all(
            [service.createSpace(input), service.createSpace(input)],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(results[0], results[1]);
          assert.equal((yield* service.listSpaces(env)).items.length, 2);
          const noOp = yield* service.setDefaultSpace({
            ...common,
            mutationId: "no-op",
            spaceId: library.defaultSpaceId,
            defaultSpaceId: library.defaultSpaceId,
            baseRevision: 0,
            baseDefaultRevision: 0,
          });
          assert.equal(noOp.status, "saved");
          assert.equal((yield* service.listSpaces(env)).catalogRevision, 2);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [meta] = yield* sql<{
              readonly receipt_rows: number;
              readonly receipt_bytes: number;
            }>`SELECT receipt_rows, receipt_bytes FROM spaces_core`;
            const rows = yield* sql<{
              readonly mutation_id: string;
              readonly fingerprint: string;
              readonly payload: string;
              readonly epoch: string;
              readonly logical_bytes: number;
              readonly retain_until: number;
            }>`SELECT * FROM spaces_receipts`;
            assert.equal(meta?.receipt_rows, 3);
            const logical = rows.map((row) => ({
              environmentId,
              mutationId: row.mutation_id,
              receiptEpoch: row.epoch,
              fingerprint: row.fingerprint,
              createdAt: "1970-01-01T00:00:00.000Z",
              retainUntil: "1970-01-09T00:00:00.000Z",
              receipt: parseJson(row.payload),
            }));
            assert.deepEqual(
              rows.map((row) => row.logical_bytes),
              logical.map(bytes),
            );
            assert.equal(
              meta?.receipt_bytes,
              logical.reduce((total, row) => total + bytes(row), 0),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }),
      ),
  );
  it.effect(
    "refuses new work at receipt quota without evicting unexpired receipts and cleans only a bounded expired batch",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
          const parent = yield* rootPage(service, common, library.defaultSpaceId, "quota-parent");
          const recoveryTarget = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "quota-trash-target",
          );
          yield* service.trashPage(
            yield* recoveryIntent(
              service,
              common,
              recoveryTarget.id,
              "trash",
              "quota-trash-initial",
            ),
          );
          const input = {
            ...common,
            mutationId: "receipt-00000",
            spaceId: library.defaultSpaceId,
            baseRevision: 0,
            title: library.items[0]!.title,
          };
          const first = yield* service.renameSpace(input);
          for (let i = 1; i < 9_997; i++)
            yield* service.renameSpace({
              ...input,
              mutationId: `receipt-${String(i).padStart(5, "0")}`,
            });
          const rejected = { ...common, mutationId: "over-capacity", title: "Must roll back" };
          const error = yield* Effect.flip(service.createSpace(rejected));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxReceiptRows");
          const placement = { pageId: parent.id, parentId: null, beforeBlockId: null };
          const guarded = yield* service.inspectStructure({
            ...env,
            target: { kind: "blocks", pageId: parent.id, blockIds: [] },
            destination: { kind: "child", placement },
          });
          const snapshot = yield* structureState(dbPath);
          const childError = yield* Effect.flip(
            service.createChildPage({
              ...common,
              mutationId: "quota-child",
              title: "No",
              placement,
              guards: guarded.guards,
            }),
          );
          assert.equal(childError._tag, "SpaceLimitExceededError");
          if (childError._tag === "SpaceLimitExceededError")
            assert.equal(childError.limit, "maxReceiptRows");
          assert.deepEqual(yield* structureState(dbPath), snapshot);
          for (const operation of ["trash", "restore", "permanentlyDelete"] as const) {
            const target = operation === "trash" ? parent.id : recoveryTarget.id;
            const intent = yield* recoveryIntent(
              service,
              common,
              target,
              operation,
              `quota-recovery-${operation}`,
            );
            const attempt =
              operation === "trash"
                ? service.trashPage(intent).pipe(Effect.asVoid)
                : operation === "restore"
                  ? service.restorePage(intent).pipe(Effect.asVoid)
                  : service.permanentlyDeletePage(intent).pipe(Effect.asVoid);
            const error = yield* Effect.flip(attempt);
            assert.equal(error._tag, "SpaceLimitExceededError");
            if (error._tag === "SpaceLimitExceededError")
              assert.equal(error.limit, "maxReceiptRows");
            assert.deepEqual(yield* structureState(dbPath), snapshot);
          }
          assert.deepEqual(yield* service.renameSpace(input), first);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "createSpace", input: rejected },
            }),
            { status: "absent" },
          );
          const before = yield* service.listSpaces(env);
          assert.equal(before.items.length, 1);
          assert.equal(before.catalogRevision, 3);
          const inspect = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{
              readonly count: number;
              readonly actual: number;
            }>`SELECT receipt_rows AS count, (SELECT COUNT(*) FROM spaces_receipts) AS actual FROM spaces_core`;
            return row;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          assert.deepEqual(yield* inspect, { count: 10_000, actual: 10_000 });
          yield* TestClock.adjust("8 days");
          const rotated = yield* service.listSpaces(env);
          assert.notEqual(rotated.mutationAdmission.epoch, common.receiptEpoch);
          assert.deepEqual(yield* inspect, { count: 9_900, actual: 9_900 });
          assert.deepEqual(
            yield* service.lookupMutationReceipt({ request: { operation: "renameSpace", input } }),
            { status: "unknown" },
          );
          const retained = { ...input, mutationId: "receipt-09996" };
          assert.equal((yield* service.renameSpace(retained)).status, "saved");
          assert.equal(
            (yield* Effect.flip(service.renameSpace(input)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* service.createSpace({
            ...rejected,
            receiptEpoch: rotated.mutationAdmission.epoch,
          });
          assert.deepEqual(yield* inspect, { count: 9_901, actual: 9_901 });
        }),
      ),
  );

  it.effect("enforces final live page bytes atomically without transient-order rejection", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, request, page, common, library } = yield* boot();
        const values = Array.from({ length: 1024 }, (_, i) => {
          const base = {
            ...block(`capacity-${i}`, i + 1),
            type: "code",
            content: { language: "", text: "" },
          };
          return { ...base, content: { language: "", text: "x".repeat(32_768 - bytes(base)) } };
        });
        let revision = 0;
        for (let offset = 0; offset < values.length; offset += 7) {
          yield* service.applyBlockBatch(
            request(
              `fill-${offset}`,
              revision++,
              values.slice(offset, offset + 7).map((value) => ({ kind: "insert", block: value })),
            ),
          );
        }
        const over = request("page-byte-over", revision, [
          { kind: "insert", block: block("extra") },
        ]);
        const error = yield* Effect.flip(service.applyBlockBatch(over));
        assert.equal(error._tag, "SpaceLimitExceededError");
        if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxPageBytes");
        assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, revision);
        assert.deepEqual(
          yield* service.lookupMutationReceipt({
            request: { operation: "applyBlockBatch", input: over },
          }),
          { status: "absent" },
        );
        const old = values[0]!;
        const base = { ...block("extra"), type: "code", content: { language: "", text: "" } };
        const replacement = {
          ...base,
          content: { language: "", text: "x".repeat(32_768 - bytes(base)) },
        };
        yield* service.applyBlockBatch(
          request("final-state", revision, [
            { kind: "insert", block: replacement },
            { kind: "delete", blockId: old.id },
          ]),
        );
        const first = yield* service.readBlocks({
          ...env,
          pageId: page.id,
          revision: revision + 1,
          limit: 1,
        });
        assert.deepEqual(first.blocks, [replacement]);
        const source = yield* rootPage(service, common, library.defaultSpaceId, "byte-source");
        const moved = block("byte-moved");
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "byte-source-seed",
          pageId: source.id,
          baseRevision: 0,
          generation: 0,
          mutations: [{ kind: "insert", block: moved }],
        });
        const intent = yield* blockMoveIntent(
          service,
          common,
          source.id,
          [moved.id],
          { pageId: page.id, parentId: null, beforeBlockId: null },
          "byte-move-over",
        );
        const before = yield* structureState(dbPath);
        const moveError = yield* Effect.flip(service.moveBlocks(intent));
        assert.equal(moveError._tag, "SpaceLimitExceededError");
        if (moveError._tag === "SpaceLimitExceededError")
          assert.equal(moveError.limit, "maxPageBytes");
        assert.deepEqual(yield* structureState(dbPath), before);
      }),
    ),
  );

  it.effect(
    "releases deleted body charges while keeping IDs reserved and refusing final live count overflow",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, request, page, common, library } = yield* boot();
          for (let offset = 0; offset < 10_000; offset += 100) {
            yield* service.applyBlockBatch(
              request(
                `fill-${offset}`,
                offset / 100,
                Array.from({ length: 100 }, (_, i) => ({
                  kind: "insert" as const,
                  block: block(`count-${offset + i}`, offset + i + 1),
                })),
              ),
            );
          }
          yield* service.applyBlockBatch(
            request("delete", 100, [{ kind: "delete", blockId: C.SpaceBlockId.make("count-0") }]),
          );
          yield* service.applyBlockBatch(
            request("freed-slot", 101, [{ kind: "insert", block: block("freed-slot") }]),
          );
          const over = request("page-count-over", 102, [
            { kind: "insert", block: block("one-too-many") },
          ]);
          const error = yield* Effect.flip(service.applyBlockBatch(over));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") {
            assert.equal(error.limit, "maxPageBlocks");
            assert.equal(error.actual, 10_001);
          }
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 102);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: over },
            }),
            { status: "absent" },
          );
          const source = yield* rootPage(service, common, library.defaultSpaceId, "count-source");
          const moved = block("count-moved");
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "count-source-seed",
            pageId: source.id,
            baseRevision: 0,
            generation: 0,
            mutations: [{ kind: "insert", block: moved }],
          });
          const intent = yield* blockMoveIntent(
            service,
            common,
            source.id,
            [moved.id],
            { pageId: page.id, parentId: null, beforeBlockId: null },
            "count-move-over",
          );
          const before = yield* structureState(dbPath);
          const moveError = yield* Effect.flip(service.moveBlocks(intent));
          assert.equal(moveError._tag, "SpaceLimitExceededError");
          if (moveError._tag === "SpaceLimitExceededError") {
            assert.equal(moveError.limit, "maxPageBlocks");
            assert.equal(moveError.actual, 10001);
          }
          assert.deepEqual(yield* structureState(dbPath), before);
        }),
      ),
  );

  it.effect.each(["future-widget", "opaque-list"] as const)(
    "opens pre-existing %s payloads losslessly and refuses unsupported changes",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-future-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const production = SpacesService.layerFromPath(dbPath).pipe(
          Layer.provide(identity),
          Layer.provide(Settings.layerTest({ spacesEnabled: true })),
        );
        const original = yield* Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          yield* service.applyBlockBatch(
            request("initial", 0, [{ kind: "insert", block: block("future") }]),
          );
          return page;
        }).pipe(Effect.provide(production));
        const future = {
          ...block("future"),
          type: kind === "opaque-list" ? "bulleted_item" : "future-widget",
          version: kind === "opaque-list" ? 1 : 3,
          content:
            kind === "opaque-list"
              ? { future: "opaque-layout" }
              : { nested: ["界", { opaque: true }] },
          envelope: { preserved: 1 },
        };
        // Fixture represents an existing document written by a newer version, which core intentionally cannot create.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const payload = yield* encodeBlockJson(future);
          yield* sql`UPDATE spaces_blocks SET payload = ${payload}, logical_bytes = ${bytes(future)} WHERE block_id = 'future'`;
          yield* sql`UPDATE spaces_pages SET block_bytes = ${bytes(future)}, revision = 2 WHERE page_id = ${original.id}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const page = yield* service.getPage({ ...env, pageId: original.id });
          const common = {
            ...env,
            pageId: original.id,
            receiptEpoch: page.mutationAdmission.epoch,
          };
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: original.id, revision: 2 })).blocks,
            [future],
          );
          yield* service.updatePage({
            ...common,
            mutationId: "rename",
            baseRevision: 2,
            title: "Future kept",
          });
          if (kind === "opaque-list") {
            const childInput = {
              ...common,
              mutationId: "opaque-parent",
              baseRevision: 3,
              generation: 0,
              mutations: [{ kind: "insert", block: block("new-child", 1, future.id) }],
            };
            const error = yield* Effect.flip(service.applyBlockBatch(childInput));
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError") assert.equal(error.reason, "invalid_parent");
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input: childInput },
              }),
              { status: "absent" },
            );
            const unsupportedParent = {
              ...block("new-parent"),
              type: "bulleted_item",
              content: { future: "opaque-layout" },
            };
            const sameBatch = {
              ...childInput,
              mutationId: "new-opaque-parent",
              mutations: [
                { kind: "insert", block: block("new-child", 1, unsupportedParent.id) },
                { kind: "insert", block: unsupportedParent },
              ],
            };
            const sameBatchError = yield* Effect.flip(service.applyBlockBatch(sameBatch));
            assert.equal(sameBatchError._tag, "SpaceValidationError");
            if (sameBatchError._tag === "SpaceValidationError")
              assert.equal(sameBatchError.reason, "unsupported_block");
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input: sameBatch },
              }),
              { status: "absent" },
            );
            assert.deepEqual(
              (yield* service.readBlocks({ ...env, pageId: original.id, revision: 3 })).blocks,
              [future],
            );
          }
          for (const mutation of [
            { kind: "replace", block: block("future") },
            { kind: "delete", blockId: future.id },
          ] as const) {
            const error = yield* Effect.flip(
              service.applyBlockBatch({
                ...common,
                mutationId: "unsupported-edit",
                baseRevision: 3,
                generation: 0,
                mutations: [mutation],
              }),
            );
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError")
              assert.equal(error.reason, "unsupported_block");
          }
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "unrelated",
            baseRevision: 3,
            generation: 0,
            mutations: [{ kind: "insert", block: block("supported", 2) }],
          });
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: original.id, revision: 4 })).blocks,
            [future, block("supported", 2)],
          );
        }).pipe(Effect.provide(production));
      }),
  );
  it.effect.each(["envelope", "content", "run", "mark"] as const)(
    "preserves own opaque inherited-name fields at the %s boundary",
    (level) =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, page } = yield* boot();
          const extensions: Record<string, Schema.Json> = {
            toString: "future-data",
            constructor: { nested: ["界", false, 7] },
            valueOf: 0,
            hasOwnProperty: false,
          };
          const withExtras = (opaque: Record<string, Schema.Json>, text = "old"): C.SpaceBlock => ({
            ...block("inherited"),
            ...(level === "envelope" ? opaque : {}),
            content: {
              ...(level === "content" ? opaque : {}),
              runs: [
                {
                  ...(level === "run" ? opaque : {}),
                  text,
                  marks: [{ ...(level === "mark" ? opaque : {}), type: "bold", version: 1 }],
                },
              ],
            },
          });
          const original = withExtras(extensions);
          yield* service.applyBlockBatch(
            request("own-initial", 0, [{ kind: "insert", block: original }]),
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks,
            [original],
          );
          const edited = withExtras(extensions, "known-field-edit");
          yield* service.applyBlockBatch(
            request("own-valid", 1, [{ kind: "replace", block: edited }]),
          );
          const badVariants = [
            Object.fromEntries(Object.entries(extensions).filter(([key]) => key !== "toString")),
            { ...extensions, toString: { nested: "changed primitive" } },
            Object.fromEntries(Object.entries(extensions).filter(([key]) => key !== "constructor")),
            { ...extensions, constructor: { nested: ["changed"] } },
            Object.fromEntries(Object.entries(extensions).filter(([key]) => key !== "valueOf")),
            Object.fromEntries(
              Object.entries(extensions).filter(([key]) => key !== "hasOwnProperty"),
            ),
          ];
          for (const [index, opaque] of badVariants.entries()) {
            const input = request(`own-refused-${index}`, 2, [
              { kind: "replace", block: withExtras(opaque, "discarded") },
            ]);
            const error = yield* Effect.flip(service.applyBlockBatch(input));
            assert.equal(error._tag, "SpaceValidationError");
            if (error._tag === "SpaceValidationError")
              assert.equal(error.reason, "unsupported_block");
            assert.deepEqual(
              yield* service.lookupMutationReceipt({
                request: { operation: "applyBlockBatch", input },
              }),
              { status: "absent" },
            );
          }
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 2);
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 2 })).blocks,
            [edited],
          );
        }),
      ),
  );
  it.effect.each([
    { method: "mutation", size: 500_000 },
    { method: "mutation", size: 256 },
    { method: "lookup", size: 500_000 },
    { method: "lookup", size: 256 },
  ] as const)(
    "bounds missing receipt epoch errors for $method with $size characters",
    ({ method, size }) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const input = {
            ...common,
            mutationId: "huge-epoch",
            receiptEpoch: "x".repeat(size),
            title: "",
          };
          const request = { operation: "createSpace" as const, input };
          assert.isBelow(bytes(request), 1_048_576);
          const inspect = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return {
              meta: yield* sql`SELECT catalog_revision, receipt_rows, receipt_bytes FROM spaces_core`,
              spaces: yield* sql`SELECT space_id, title, revision FROM spaces ORDER BY space_id`,
              page: yield* sql`SELECT revision, block_count, block_bytes FROM spaces_pages WHERE page_id = ${page.id}`,
              attempted:
                yield* sql`SELECT mutation_id FROM spaces_receipts WHERE mutation_id = ${input.mutationId}`,
            };
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          const before = yield* inspect;
          const outcome: Effect.Effect<unknown, C.SpaceServiceError> =
            method === "mutation"
              ? service.createSpace(input)
              : service.lookupMutationReceipt({ request });
          const failure = yield* outcome.pipe(
            Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
          );
          assert.isNotNull(failure);
          if (failure === null) return;
          assert.equal(failure._tag, "SpaceLimitExceededError");
          if (failure._tag === "SpaceLimitExceededError") {
            const requestLimit = method === "mutation" && size === 500_000;
            assert.equal(failure.limit, requestLimit ? "maxMutationBytes" : "maxIdBytes");
            assert.equal(failure.actual, requestLimit ? bytes(request) : bytes(input.receiptEpoch));
            assert.equal(failure.maximum, requestLimit ? 262_144 : 128);
          }
          const serialized = yield* encodeServiceErrorJson(failure);
          assert.isBelow(Buffer.byteLength(serialized, "utf8"), 256);
          assert.notInclude(serialized, input.receiptEpoch);
          assert.deepEqual(yield* inspect, before);
          assert.deepEqual(before.attempted, []);
        }),
      ),
  );
});
