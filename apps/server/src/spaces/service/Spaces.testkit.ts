import { assert } from "@effect/vitest";
import { EnvironmentId, PageContextRecord, BlockContextRecord } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Settings from "../../serverSettings.ts";
import * as SpacesService from "../SpacesService.ts";

export const isPageContext = Schema.is(PageContextRecord);
export const isBlockContext = Schema.is(BlockContextRecord);

export const environmentId = EnvironmentId.make("test-environment");
export const env = { environmentId };
export const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(environmentId),
});
export const block = (id: string, n = 1, parentId: C.SpaceBlockId | null = null): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId,
  order: n.toString(16).padStart(32, "0"),
  type: "paragraph",
  version: 1,
  content: { runs: [{ text: id, marks: [] }] },
});
export const encodeServiceErrorJson = Schema.encodeEffect(
  Schema.fromJsonString(C.SpaceServiceError),
);
export const encodeBlockJson = Schema.encodeEffect(Schema.fromJsonString(C.SpaceBlock));
export const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
export const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

export const fixture = Effect.fn("SpacesServiceTest.fixture")(function* <A, E>(
  use: (
    dbPath: string,
  ) => Effect.Effect<
    A,
    E,
    SpacesService.SpacesService | Settings.ServerSettingsService | FileSystem.FileSystem
  >,
  enabled = true,
  options?: { readonly backgroundDrain?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-service-" });
  const dbPath = path.join(directory, "spaces.sqlite");
  return yield* use(dbPath).pipe(
    Effect.provide(
      SpacesService.layerFromPath(dbPath, undefined, options).pipe(
        Layer.provide(identity),
        Layer.provideMerge(Settings.layerTest({ spacesEnabled: enabled })),
      ),
    ),
  );
}, Effect.provide(TestClock.layer()));
export const boot = Effect.fn("SpacesServiceTest.boot")(function* () {
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
export const historyState = (dbPath: string) =>
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

export const prepareHistoryDelta = Effect.fn("SpacesServiceTest.prepareHistoryDelta")(function* (
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

export const structureState = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      core: yield* sql`SELECT * FROM spaces_core`,
      searchDocs: yield* sql`SELECT * FROM spaces_search_docs ORDER BY doc_id`,
      spaces: yield* sql`SELECT * FROM spaces ORDER BY space_id`,
      pages: yield* sql`SELECT * FROM spaces_pages ORDER BY page_id`,
      blocks: yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`,
      owners: yield* sql`SELECT * FROM spaces_page_owners ORDER BY child_page_id`,
      ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
      receipts: yield* sql`SELECT * FROM spaces_receipts ORDER BY mutation_id`,
      history: yield* sql`SELECT * FROM spaces_revisions ORDER BY page_id,to_revision`,
      blockPins:
        yield* sql`SELECT block_id,asset_id FROM spaces_block_asset_refs ORDER BY block_id`,
      revisionPins:
        yield* sql`SELECT page_id,to_revision,asset_id FROM spaces_revision_asset_refs ORDER BY page_id,to_revision,asset_id`,
    };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

export const childPage = Effect.fn("SpacesServiceTest.childPage")(function* (
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
export const rootPage = Effect.fn("SpacesServiceTest.rootPage")(function* (
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
export const moveIntent = Effect.fn("SpacesServiceTest.moveIntent")(function* (
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

export const blockMoveIntent = Effect.fn("SpacesServiceTest.blockMoveIntent")(function* (
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

export const recoveryIntent = Effect.fn("SpacesServiceTest.recoveryIntent")(function* (
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
