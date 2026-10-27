import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";

import * as Config from "../../config.ts";
import * as Secrets from "../../auth/ServerSecretStore.ts";
import * as Identity from "../../environment/ServerEnvironment.ts";
import * as Settings from "../../serverSettings.ts";
import * as Service from "../SpacesService.ts";

const environmentId = EnvironmentId.make("media-refs");
const env = { environmentId };
const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const fixture = Effect.fn("SpacesMediaTest.fixture")(function* <A, E, R>(
  use: (input: {
    readonly config: Config.ServerConfig["Service"];
    readonly live: () => ReturnType<typeof Service.layerFromPath>;
  }) => Effect.Effect<A, E, R>,
) {
  const context = yield* Layer.buildWithScope(
    Config.ServerConfig.layerTest(process.cwd(), { prefix: "spaces-media-" }),
    yield* Effect.scope,
  );
  const config = Context.get(context, Config.ServerConfig);
  const live = () =>
    Service.layerFromPath(config.spacesDbPath, {
      assetsDir: config.spacesAssetsDir,
      stagingDir: config.spacesStagingDir,
    });
  return yield* use({ config, live }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Secrets.layer.pipe(Layer.provide(Layer.succeedContext(context))),
        Settings.layerTest({ spacesEnabled: true }),
        Layer.succeed(Identity.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
    ),
  );
}, Effect.provide(NodeServices.layer));

const upload = Effect.fn("SpacesMediaTest.upload")(function* (requestId: string) {
  const service = yield* Service.SpacesService;
  const reservation = yield* service.createAssetUpload(
    {
      ...env,
      requestId,
      expectedBytes: pdf.length,
      mediaKind: "pdf",
      mimeType: "application/pdf",
      name: "paper.pdf",
    },
    "owner",
  );
  yield* service.receiveAssetUpload(
    reservation.relativeUrl.slice(reservation.relativeUrl.lastIndexOf("/") + 1),
    String(pdf.length),
    Stream.make(pdf),
  );
  return yield* service.finalizeAssetUpload({ ...env, uploadId: reservation.uploadId }, "owner");
});
const media = (id: string, assetId: C.SpaceAssetId, text = id): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: id.padStart(32, "0"),
  type: "pdf",
  version: 1,
  content: { assetId, caption: [{ text, marks: [] }] },
});
const text = (id: string, value = id): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: id.padStart(32, "0"),
  type: "paragraph",
  version: 1,
  content: { runs: [{ text: value, marks: [] }] },
});
const boot = Effect.fn("SpacesMediaTest.boot")(function* () {
  const service = yield* Service.SpacesService;
  const library = yield* service.listSpaces(env);
  const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
  const result = yield* service.createPage({
    ...common,
    mutationId: "page",
    spaceId: library.defaultSpaceId,
    baseRootOrderRevision: 0,
    title: "Media",
  });
  if (result.status !== "saved") return yield* Effect.die("Expected page");
  const pageId = result.page.id;
  const request = (
    mutationId: string,
    baseRevision: number,
    mutations: readonly C.SpaceBlockMutation[],
  ) => ({
    ...common,
    mutationId,
    pageId,
    baseRevision,
    generation: baseRevision,
    mutations,
  });
  return { service, pageId, request };
});
const inspect = Effect.fn("SpacesMediaTest.inspect")(function* (
  config: Config.ServerConfig["Service"],
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      core: yield* sql`SELECT * FROM spaces_core`,
      pages: yield* sql`SELECT * FROM spaces_pages ORDER BY page_id`,
      blocks: yield* sql`SELECT * FROM spaces_blocks ORDER BY block_id`,
      ids: yield* sql`SELECT * FROM spaces_ids ORDER BY id`,
      receipts: yield* sql`SELECT * FROM spaces_receipts ORDER BY mutation_id`,
      revisions: yield* sql<{
        readonly to_revision: number;
        readonly mutation_id: string;
        readonly payload: string;
        readonly asset_count: number;
        readonly logical_bytes: number;
      }>`SELECT * FROM spaces_revisions ORDER BY page_id,to_revision`,
      current: yield* sql<{
        readonly block_id: string;
        readonly asset_id: string;
      }>`SELECT * FROM spaces_block_asset_refs ORDER BY block_id`,
      history: yield* sql<{
        readonly to_revision: number;
        readonly asset_id: string;
      }>`SELECT * FROM spaces_revision_asset_refs ORDER BY page_id,to_revision,asset_id`,
      usage: yield* sql`SELECT * FROM spaces_asset_usage`,
    };
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
  );
});

it.effect(
  "captures OLD pins before replacement/deletion and reopens stable receipts and normalized history",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const { service, pageId, request } = yield* boot();
          const a = yield* upload("a");
          const b = yield* upload("b");
          const original = media("a", a.assetId);
          const insert = request("insert", 0, [
            { kind: "insert", block: original },
            { kind: "insert", block: media("b", a.assetId) },
          ]);
          yield* service.applyBlockBatch(insert);
          expect((yield* inspect(config)).current.map((row) => row.asset_id)).toEqual([
            a.assetId,
            a.assetId,
          ]);
          const replaced = media("a", b.assetId, "B");
          const replacement = request("replace", 1, [{ kind: "replace", block: replaced }]);
          const saved = yield* service.applyBlockBatch(replacement);
          const state = yield* inspect(config);
          expect(state.current).toEqual([
            { block_id: "a", asset_id: b.assetId },
            { block_id: "b", asset_id: a.assetId },
          ]);
          expect(state.history.map((row) => [row.to_revision, row.asset_id])).toEqual([
            [2, a.assetId],
          ]);
          expect(
            JSON.parse(
              JSON.parse(state.revisions.find((row) => row.to_revision === 2)!.payload)
                .blocksBefore[0].row.payload,
            ),
          ).toEqual(original);
          const deletion = request("delete", 2, [{ kind: "delete", blockId: original.id }]);
          yield* service.applyBlockBatch(deletion);
          const after = yield* inspect(config);
          expect(after.current).toEqual([{ block_id: "b", asset_id: a.assetId }]);
          expect(after.history.map((row) => [row.to_revision, row.asset_id])).toEqual([
            [2, a.assetId],
            [3, b.assetId],
          ]);
          expect(yield* service.applyBlockBatch(replacement)).toEqual(saved);
          expect(yield* inspect(config)).toEqual(after);
          return { a, b, pageId, replacement, saved, after };
        }).pipe(Effect.provide(live()));
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          expect(yield* service.applyBlockBatch(first.replacement)).toEqual(first.saved);
          expect(yield* inspect(config)).toEqual(first.after);
          yield* TestClock.adjust("8 days");
          expect(yield* service.applyBlockBatch(first.replacement)).toEqual(first.saved);
          const late = yield* inspect(config);
          expect(late.revisions).toEqual(first.after.revisions);
          expect(late.current).toEqual(first.after.current);
          expect(late.history).toEqual(first.after.history);
          yield* service.getPage({ ...env, pageId: first.pageId });
          const pruned = yield* inspect(config);
          expect(pruned.history).toEqual([]);
          expect(pruned.current).toEqual([{ block_id: "b", asset_id: first.a.assetId }]);
          expect(yield* service.getAssetMetadata({ ...env, assetId: first.b.assetId })).toEqual(
            first.b,
          );
        }).pipe(Effect.provide(live()));
      }),
    ),
);

it.effect(
  "rejects invalid media handles/kinds/environments and rolls back combined text/media batches",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, request } = yield* boot();
        const ready = yield* upload("ready");
        const pending = yield* service.createAssetUpload(
          {
            ...env,
            requestId: "pending",
            expectedBytes: pdf.length,
            mimeType: "application/pdf",
            mediaKind: "pdf",
            name: "pending.pdf",
          },
          "owner",
        );
        const valid = media("a", ready.assetId);
        const before = yield* inspect(config);
        const cases = [
          { block: media("b", pending.assetId), reason: "not_found" },
          {
            block: media("b", C.SpaceAssetId.make("00000000-0000-4000-8000-000000000000")),
            reason: "not_found",
          },
          { block: media("b", C.SpaceAssetId.make("page")), reason: "invalid_input" },
          { block: { ...media("b", ready.assetId), type: "image" }, reason: "media_mismatch" },
          {
            block: {
              ...media("b", ready.assetId),
              content: { assetId: ready.assetId, url: "/api/assets/secret" },
            },
            reason: "unsupported_block",
          },
        ];
        for (const [index, test] of cases.entries()) {
          const input = request(`invalid-${index}`, 0, [
            { kind: "insert", block: valid },
            { kind: "insert", block: text("c") },
            { kind: "insert", block: test.block },
          ]);
          expect(yield* service.applyBlockBatch(input).pipe(Effect.flip)).toMatchObject({
            reason: test.reason,
          });
          expect(yield* inspect(config)).toEqual(before);
        }
        expect(
          yield* service
            .applyBlockBatch({
              ...request("foreign", 0, [{ kind: "insert", block: valid }]),
              environmentId: EnvironmentId.make("elsewhere"),
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "SpaceEnvironmentMismatchError" });
        expect(
          yield* service
            .applyBlockBatch(
              request("quota", 0, [
                { kind: "insert", block: valid },
                { kind: "insert", block: text("c", "x".repeat(32_768)) },
              ]),
            )
            .pipe(Effect.flip),
        ).toMatchObject({ limit: "maxBlockBytes" });
        expect(yield* inspect(config)).toEqual(before);
        for (const state of ["deleting", "deleted"]) {
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE spaces_asset_blobs SET state = ${state} WHERE digest = ${ready.digest}`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
          const stateBefore = yield* inspect(config);
          expect(
            yield* service
              .applyBlockBatch(request(`tombstone-${state}`, 0, [{ kind: "insert", block: valid }]))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "not_found" });
          expect(yield* inspect(config)).toEqual(stateBefore);
        }
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE spaces_asset_blobs SET state = 'ready' WHERE digest = ${ready.digest}`;
          yield* sql`UPDATE spaces_assets SET state = 'deleted' WHERE asset_id = ${ready.assetId}`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const revoked = yield* inspect(config);
        expect(
          yield* service
            .applyBlockBatch(request("revoked", 0, [{ kind: "insert", block: valid }]))
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "not_found" });
        expect(yield* inspect(config)).toEqual(revoked);
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "keeps unreconciled legacy media read-only when current pins are missing or inconsistent",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, request, pageId } = yield* boot();
        const a = yield* upload("legacy-a");
        const b = yield* upload("legacy-b");
        const original = media("a", a.assetId);
        yield* service.applyBlockBatch(request("insert", 0, [{ kind: "insert", block: original }]));
        for (const mismatched of [false, true]) {
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DELETE FROM spaces_block_asset_refs WHERE block_id = 'a'`;
            if (mismatched)
              yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES ('a',${b.assetId})`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
          const before = yield* inspect(config);
          for (const mutation of [
            { kind: "replace" as const, block: media("a", b.assetId) },
            { kind: "delete" as const, blockId: original.id },
          ]) {
            expect(
              yield* service
                .applyBlockBatch(request(`legacy-${mismatched}-${mutation.kind}`, 1, [mutation]))
                .pipe(Effect.flip),
            ).toMatchObject({ reason: "unsupported_block" });
            expect(yield* inspect(config)).toEqual(before);
          }
          expect((yield* service.readBlocks({ ...env, pageId, revision: 1 })).blocks).toEqual([
            original,
          ]);
        }
      }).pipe(Effect.provide(live())),
    ),
);

it.effect("pins transitions between text and media without changing unrelated references", () =>
  fixture(({ config, live }) =>
    Effect.gen(function* () {
      const { service, request } = yield* boot();
      const a = yield* upload("transition-a");
      const b = yield* upload("transition-b");
      yield* service.applyBlockBatch(
        request("initial", 0, [
          { kind: "insert", block: text("a") },
          { kind: "insert", block: media("b", b.assetId) },
        ]),
      );
      yield* service.applyBlockBatch(
        request("to-media", 1, [{ kind: "replace", block: media("a", a.assetId) }]),
      );
      expect((yield* inspect(config)).current).toEqual([
        { block_id: "a", asset_id: a.assetId },
        { block_id: "b", asset_id: b.assetId },
      ]);
      expect((yield* inspect(config)).history).toEqual([]);
      yield* service.applyBlockBatch(
        request("to-text", 2, [{ kind: "replace", block: text("a", "after") }]),
      );
      const state = yield* inspect(config);
      expect(state.current).toEqual([{ block_id: "b", asset_id: b.assetId }]);
      expect(state.history.map((row) => [row.to_revision, row.asset_id])).toEqual([[3, a.assetId]]);
    }).pipe(Effect.provide(live())),
  ),
);

it.effect("deduplicates revision pins at99 unique assets and refuses the100th atomically", () =>
  fixture(({ config, live }) =>
    Effect.gen(function* () {
      const { service, request } = yield* boot();
      const assets = yield* Effect.forEach(
        Array.from({ length: 100 }, (_, i) => i),
        (i) => upload(`asset-${i}`),
      );
      const blocks = assets.map((asset, i) =>
        media(i.toString(16).padStart(3, "0"), asset.assetId),
      );
      yield* service.applyBlockBatch(
        request(
          "insert",
          0,
          blocks.map((block) => ({ kind: "insert", block })),
        ),
      );
      const before = yield* inspect(config);
      const deletes = blocks.map((block) => ({ kind: "delete" as const, blockId: block.id }));
      const input = request("hundred", 1, deletes);
      expect(yield* service.applyBlockBatch(input).pipe(Effect.flip)).toMatchObject({
        _tag: "SpacesUnavailableError",
        stage: "capacity",
      });
      expect(yield* inspect(config)).toEqual(before);
      expect(
        yield* service.lookupMutationReceipt({ request: { operation: "applyBlockBatch", input } }),
      ).toEqual({ status: "absent" });
      yield* service.applyBlockBatch(request("ninety-nine", 1, deletes.slice(0, 99)));
      const after = yield* inspect(config);
      expect(after.history).toHaveLength(99);
      expect(after.current).toEqual([{ block_id: blocks[99]!.id, asset_id: assets[99]!.assetId }]);
      expect(after.revisions.find((row) => row.mutation_id === "ninety-nine")?.asset_count).toBe(
        99,
      );
      const duplicate = media("fff", assets[99]!.assetId);
      yield* service.applyBlockBatch(
        request("duplicate", 2, [{ kind: "insert", block: duplicate }]),
      );
      yield* service.applyBlockBatch(
        request("same-pin", 3, [{ kind: "delete", blockId: duplicate.id }, deletes[99]!]),
      );
      const state = yield* inspect(config);
      expect(state.revisions.find((row) => row.mutation_id === "same-pin")?.asset_count).toBe(1);
      expect(
        state.history.filter((row) => row.to_revision === 4).map((row) => row.asset_id),
      ).toEqual([assets[99]!.assetId]);
    }).pipe(Effect.provide(live())),
  ),
);

it.effect(
  "rolls back media and text changes when retained media beforeimages exceed history bytes",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, request } = yield* boot();
        const asset = yield* upload("large-captions");
        const blocks = Array.from({ length: 40 }, (_, i) =>
          media(i.toString(16).padStart(3, "0"), asset.assetId, "\\".repeat(15_000)),
        );
        let revision = 0;
        for (let start = 0; start < blocks.length; start += 7) {
          yield* service.applyBlockBatch(
            request(
              `insert-${start}`,
              revision++,
              blocks.slice(start, start + 7).map((block) => ({ kind: "insert", block })),
            ),
          );
        }
        const before = yield* inspect(config);
        const input = request("too-much-history", revision, [
          { kind: "insert", block: text("fff") },
          ...blocks.map((block) => ({
            kind: "replace" as const,
            block: media(block.id, asset.assetId, "small"),
          })),
        ]);
        expect(yield* service.applyBlockBatch(input).pipe(Effect.flip)).toMatchObject({
          limit: "history.maxDeltaBytes",
        });
        expect(yield* inspect(config)).toEqual(before);
        expect(
          yield* service.lookupMutationReceipt({
            request: { operation: "applyBlockBatch", input },
          }),
        ).toEqual({ status: "absent" });
      }).pipe(Effect.provide(live())),
    ),
);

it.effect("preserves rich caption extensions and keeps opaque/future media read-only", () =>
  fixture(({ config, live }) =>
    Effect.gen(function* () {
      const { service, request, pageId } = yield* boot();
      const asset = yield* upload("opaque");
      const rich = {
        ...media("a", asset.assetId),
        content: {
          assetId: asset.assetId,
          caption: [
            {
              text: "before",
              marks: [{ type: "bold", version: 1, future: "mark" }],
              future: "run",
            },
          ],
        },
      };
      yield* service.applyBlockBatch(request("insert", 0, [{ kind: "insert", block: rich }]));
      const changed = {
        ...rich,
        content: { ...rich.content, caption: [{ ...rich.content.caption[0]!, text: "after" }] },
      };
      yield* service.applyBlockBatch(request("caption", 1, [{ kind: "replace", block: changed }]));
      const before = yield* inspect(config);
      const stripped = {
        ...changed,
        content: {
          assetId: asset.assetId,
          caption: [{ text: "after", marks: [{ type: "bold", version: 1 }] }],
        },
      };
      expect(
        yield* service
          .applyBlockBatch(request("stripped", 2, [{ kind: "replace", block: stripped }]))
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "unsupported_block" });
      expect(yield* inspect(config)).toEqual(before);
      for (const [index, opaque] of [
        { ...changed, version: 2 },
        { ...changed, content: { ...changed.content, future: { opaque: true } } },
        {
          ...changed,
          content: {
            ...changed.content,
            caption: [{ text: "future", marks: [{ type: "future", version: 1 }] }],
          },
        },
      ].entries()) {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE spaces_pages SET block_bytes = block_bytes + ${Buffer.byteLength(JSON.stringify(opaque))} - (SELECT logical_bytes FROM spaces_blocks WHERE block_id = 'a') WHERE page_id = ${pageId}`;
          yield* sql`UPDATE spaces_blocks SET payload = ${JSON.stringify(opaque)},logical_bytes = ${Buffer.byteLength(JSON.stringify(opaque))} WHERE block_id = 'a'`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        expect(
          (yield* service.readBlocks({ ...env, pageId, revision: 2 + index })).blocks.find(
            (block) => block.id === "a",
          ),
        ).toEqual(opaque);
        for (const mutation of [
          { kind: "replace" as const, block: changed },
          { kind: "delete" as const, blockId: changed.id },
        ])
          expect(
            yield* service
              .applyBlockBatch(request(`opaque-${index}-${mutation.kind}`, 2 + index, [mutation]))
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "unsupported_block" });
        yield* service.applyBlockBatch(
          request(`unrelated-${index}`, 2 + index, [
            { kind: "insert", block: text((index + 16).toString(16)) },
          ]),
        );
        expect(
          (yield* service.readBlocks({ ...env, pageId, revision: 3 + index })).blocks.find(
            (block) => block.id === "a",
          ),
        ).toEqual(opaque);
        expect((yield* inspect(config)).current).toEqual([
          { block_id: "a", asset_id: asset.assetId },
        ]);
      }
    }).pipe(Effect.provide(live())),
  ),
);

const recoveryInput = Effect.fn("SpacesMediaTest.recoveryInput")(function* (
  pageId: C.SpacePageId,
  recovery: C.SpaceRecoveryOperation,
  mutationId: string,
) {
  const service = yield* Service.SpacesService;
  const library = yield* service.listSpaces(env);
  const inspected = yield* service.inspectStructure({
    ...env,
    target: { kind: "page", pageId },
    recovery,
  });
  return {
    ...env,
    receiptEpoch: library.mutationAdmission.epoch,
    pageId,
    mutationId,
    guards: inspected.guards,
  };
});

it.effect(
  "retains uploaded media through cross-space moves, nested recovery, purge and revision pruning",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const first = yield* Effect.gen(function* () {
          const { service, pageId, request } = yield* boot();
          const library = yield* service.listSpaces(env);
          const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
          const a = yield* upload("lifecycle-a"),
            b = yield* upload("lifecycle-b");
          yield* service.applyBlockBatch(
            request("lifecycle-insert", 0, [
              { kind: "insert", block: media("a", a.assetId, "originalneedle") },
              { kind: "insert", block: media("b", a.assetId, "sharedneedle") },
            ]),
          );
          yield* service.applyBlockBatch(
            request("lifecycle-replace", 1, [
              { kind: "replace", block: media("a", b.assetId, "captionneedle") },
            ]),
          );
          const placement = { pageId, parentId: null, beforeBlockId: null };
          const childPlan = yield* service.inspectStructure({
            ...env,
            target: { kind: "blocks", pageId, blockIds: [] },
            destination: { kind: "child", placement },
          });
          const child = yield* service.createChildPage({
            ...common,
            mutationId: "lifecycle-child",
            title: "Child",
            placement,
            guards: childPlan.guards,
          });
          if (child.status !== "saved") return yield* Effect.die("Expected child");
          const createdSpace = yield* service.createSpace({
            ...common,
            mutationId: "lifecycle-space",
            title: "Elsewhere",
          });
          if (createdSpace.status !== "saved") return yield* Effect.die("Expected space");
          const destination = {
            kind: "root" as const,
            spaceId: createdSpace.space.id,
            beforePageId: null,
          };
          const pagePlan = yield* service.inspectStructure({
            ...env,
            target: { kind: "page", pageId },
            destination,
          });
          expect(
            (yield* service.movePage({
              ...common,
              mutationId: "lifecycle-page-move",
              pageId,
              destination,
              guards: pagePlan.guards,
            })).status,
          ).toBe("saved");
          const childPlacement = { pageId: child.page.id, parentId: null, beforeBlockId: null };
          const blockIds = [C.SpaceBlockId.make("a")];
          const blockPlan = yield* service.inspectStructure({
            ...env,
            target: { kind: "blocks", pageId, blockIds },
            destination: { kind: "child", placement: childPlacement },
          });
          const move = {
            ...common,
            mutationId: "lifecycle-block-move",
            sourcePageId: pageId,
            blockIds,
            destination: childPlacement,
            guards: blockPlan.guards,
          };
          const moved = yield* service.moveBlocks(move);
          expect(moved.status).toBe("saved");
          const afterMove = yield* inspect(config);
          expect(afterMove.current).toEqual([
            { block_id: "a", asset_id: b.assetId },
            { block_id: "b", asset_id: a.assetId },
          ]);
          expect(afterMove.history.map((row) => row.asset_id)).toContain(a.assetId);
          expect(afterMove.history.map((row) => row.asset_id)).toContain(b.assetId);
          expect((yield* service.getPage({ ...env, pageId: child.page.id })).page.spaceId).toBe(
            createdSpace.space.id,
          );
          expect(yield* service.moveBlocks(move)).toEqual(moved);
          expect(yield* inspect(config)).toEqual(afterMove);
          const current = (yield* service.readBlocks({
            ...env,
            pageId: child.page.id,
            revision: (yield* service.getPage({ ...env, pageId: child.page.id })).page.revision,
          })).blocks[0]!;
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "lifecycle-caption",
            pageId: child.page.id,
            baseRevision: (yield* service.getPage({ ...env, pageId: child.page.id })).page.revision,
            generation: 0,
            mutations: [
              {
                kind: "replace",
                block: {
                  ...current,
                  content: { assetId: b.assetId, caption: [{ text: "editedneedle", marks: [] }] },
                },
              },
            ],
          });
          for (const _pass of [0, 1]) {
            const result = yield* service
              .search({ ...env, query: "editedneedle" })
              .pipe(Effect.result);
            if (result._tag === "Failure")
              expect(result.failure).toMatchObject({
                _tag: "SpaceSearchUnavailableError",
                reason: "building",
              });
          }
          expect(
            (yield* service.search({ ...env, query: "editedneedle" })).items.map(
              (row) => row.blockId,
            ),
          ).toEqual(blockIds);
          expect((yield* service.search({ ...env, query: "captionneedle" })).items).toEqual([]);
          const beforeTrash = (yield* inspect(config)).current;
          expect(
            (yield* service.trashPage(
              yield* recoveryInput(child.page.id, "trash", "lifecycle-trash"),
            )).status,
          ).toBe("saved");
          expect((yield* inspect(config)).current).toEqual(beforeTrash);
          expect((yield* service.search({ ...env, query: "editedneedle" })).items).toEqual([]);
          return { a, b, childId: child.page.id, pageId, beforeTrash };
        }).pipe(Effect.provide(live()), Effect.scoped);
        yield* Effect.gen(function* () {
          const service = yield* Service.SpacesService;
          expect((yield* inspect(config)).current).toEqual(first.beforeTrash);
          expect(
            (yield* service.restorePage(
              yield* recoveryInput(first.childId, "restore", "lifecycle-restore"),
            )).status,
          ).toBe("saved");
          expect(
            (yield* service.search({ ...env, query: "editedneedle" })).items.map(
              (row) => row.blockId,
            ),
          ).toEqual(["a"]);
          const resolved = yield* service.resolveAssetFile({ ...env, assetId: first.b.assetId });
          const fs = yield* FileSystem.FileSystem;
          expect(new Uint8Array(yield* fs.readFile(resolved.path))).toEqual(pdf);
          expect(yield* service.getAssetMetadata({ ...env, assetId: first.b.assetId })).toEqual(
            first.b,
          );
          for (const _pass of Array.from({ length: 20 }, (_, i) => i))
            yield* service.maintainAssets;
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            historyPending: false,
            unresolved: false,
            gcEnabled: false,
          });
          yield* service.trashPage(
            yield* recoveryInput(first.childId, "trash", "lifecycle-retrash"),
          );
          const purge = yield* recoveryInput(first.childId, "permanentlyDelete", "lifecycle-purge");
          const purged = yield* service.permanentlyDeletePage(purge);
          expect(purged.status).toBe("saved");
          const after = yield* inspect(config);
          expect(after.current).toEqual([{ block_id: "b", asset_id: first.a.assetId }]);
          expect(after.blocks.map((row) => row.block_id)).not.toContain("a");
          expect(after.blocks.some((row) => row.deleted === 1)).toBe(false);
          expect(after.history.map((row) => row.asset_id)).toContain(first.b.assetId);
          expect((yield* service.search({ ...env, query: "editedneedle" })).items).toEqual([]);
          expect(yield* service.permanentlyDeletePage(purge)).toEqual(purged);
          expect(yield* inspect(config)).toEqual(after);
          yield* TestClock.adjust("8 days");
          expect(yield* service.permanentlyDeletePage(purge)).toEqual(purged);
          expect((yield* inspect(config)).history).toEqual(after.history);
          yield* service.getPage({ ...env, pageId: first.pageId });
          const pruned = yield* inspect(config);
          expect(pruned.history).toEqual([]);
          expect(pruned.current).toEqual(after.current);
          expect(pruned.core[0]?.revision_bytes).toBe(0);
          expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
            unresolved: false,
            gcEnabled: false,
          });
          expect(new Uint8Array(yield* fs.readFile(resolved.path))).toEqual(pdf);
        }).pipe(Effect.provide(live()), Effect.scoped);
      }),
    ),
);

it.effect(
  "keeps opaque moved media pinned and removes only purged or pruned reconciliation issues",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, pageId, request } = yield* boot();
        const asset = yield* upload("opaque-move");
        yield* service.applyBlockBatch(
          request("opaque-seed", 0, [{ kind: "insert", block: media("a", asset.assetId) }]),
        );
        const common = {
          ...env,
          receiptEpoch: (yield* service.listSpaces(env)).mutationAdmission.epoch,
        };
        const placement = { pageId, parentId: null, beforeBlockId: null };
        const childPlan = yield* service.inspectStructure({
          ...env,
          target: { kind: "blocks", pageId, blockIds: [] },
          destination: { kind: "child", placement },
        });
        const child = yield* service.createChildPage({
          ...common,
          mutationId: "opaque-child",
          title: "Child",
          placement,
          guards: childPlan.guards,
        });
        if (child.status !== "saved") return yield* Effect.die("Expected child");
        const payload = JSON.stringify({
          ...media("a", asset.assetId),
          version: 2,
          futureEnvelope: { keep: ["界", 7] },
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${Buffer.byteLength(payload)}-(SELECT logical_bytes FROM spaces_blocks WHERE block_id='a') WHERE page_id=${pageId}`;
          yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${Buffer.byteLength(payload)} WHERE block_id='a'`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const destination = { pageId: child.page.id, parentId: null, beforeBlockId: null };
        const blockIds = [C.SpaceBlockId.make("a")];
        const plan = yield* service.inspectStructure({
          ...env,
          target: { kind: "blocks", pageId, blockIds },
          destination: { kind: "child", placement: destination },
        });
        expect(
          (yield* service.moveBlocks({
            ...common,
            mutationId: "opaque-move",
            sourcePageId: pageId,
            blockIds,
            destination,
            guards: plan.guards,
          })).status,
        ).toBe("saved");
        const moved = yield* inspect(config);
        const movedPayload = JSON.parse(
          String(moved.blocks.find((row) => row.block_id === "a")?.payload),
        );
        expect({ ...movedPayload, order: JSON.parse(payload).order }).toEqual(JSON.parse(payload));
        expect(moved.current).toEqual([{ block_id: "a", asset_id: asset.assetId }]);
        const issues = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly kind: string;
            readonly entity: string;
            readonly reason: string;
          }>`SELECT * FROM spaces_asset_reconciliation_issues ORDER BY kind,entity`;
        }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
        );
        expect(yield* issues).toContainEqual({
          kind: "block",
          entity: "a",
          reason: "unknown_payload",
        });
        for (const _pass of Array.from({ length: 10 }, (_, i) => i)) yield* service.maintainAssets;
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          unresolved: true,
          gcEnabled: false,
        });
        yield* service.trashPage(yield* recoveryInput(child.page.id, "trash", "opaque-trash"));
        const purge = yield* recoveryInput(child.page.id, "permanentlyDelete", "opaque-purge");
        const before = yield* inspect(config),
          beforeIssues = yield* issues;
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_purge BEFORE DELETE ON spaces_pages BEGIN SELECT RAISE(ABORT,'purge interrupted'); END`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        expect(yield* service.permanentlyDeletePage(purge).pipe(Effect.flip)).toMatchObject({
          _tag: "SpacesUnavailableError",
        });
        expect(yield* inspect(config)).toEqual(before);
        expect(yield* issues).toEqual(beforeIssues);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TRIGGER refuse_purge`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        expect((yield* service.permanentlyDeletePage(purge)).status).toBe("saved");
        const retained = yield* issues;
        expect(retained.length).toBeGreaterThan(0);
        expect(
          retained.every((row) => row.kind === "history" && JSON.parse(row.entity)[0] === pageId),
        ).toBe(true);
        expect((yield* inspect(config)).history.map((row) => row.asset_id)).toContain(
          asset.assetId,
        );
        expect(yield* service.getAssetMetadata({ ...env, assetId: asset.assetId })).toEqual(asset);
        yield* TestClock.adjust("8 days");
        yield* service.getPage({ ...env, pageId });
        expect(yield* issues).toEqual([]);
        expect((yield* inspect(config)).history).toEqual([]);
        expect((yield* service.getCapability(environmentId))?.assetReconciliation).toMatchObject({
          unresolved: false,
          gcEnabled: false,
        });
      }).pipe(Effect.provide(live())),
    ),
);

it.effect(
  "bounds already-acquired physical reclaim to64 steps without touching retained media, history or receipts",
  () =>
    fixture(({ config, live }) =>
      Effect.gen(function* () {
        const { service, pageId, request } = yield* boot();
        const a = yield* upload("reclaim-a"),
          b = yield* upload("reclaim-b");
        yield* service.applyBlockBatch(
          request("reclaim-insert", 0, [{ kind: "insert", block: media("a", a.assetId) }]),
        );
        yield* service.applyBlockBatch(
          request("reclaim-replace", 1, [{ kind: "replace", block: media("a", b.assetId) }]),
        );
        yield* service.createAssetUpload(
          {
            ...env,
            requestId: "reclaim-reserved",
            expectedBytes: pdf.length,
            mimeType: "application/pdf",
            mediaKind: "pdf",
            name: "pending.pdf",
          },
          "owner",
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE reclaim_churn(value BLOB)`;
          yield* sql`INSERT INTO reclaim_churn VALUES (zeroblob(1048576))`;
          yield* sql`DROP TABLE reclaim_churn`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath })));
        const physical = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            free: (yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`)[0]!
              .freelist_count,
            size: (yield* sql<{ readonly page_size: number }>`PRAGMA page_size`)[0]!.page_size,
          };
        }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: config.spacesDbPath, readonly: true })),
        );
        const before = yield* inspect(config),
          initial = yield* physical;
        expect(initial.free).toBeGreaterThan(128);
        yield* TestClock.adjust("8 days");
        const steps: string[] = [];
        const observe: Statement.Transformer = (statement) => {
          const [query] = statement.compile();
          steps.push(query);
          return Effect.succeed(statement);
        };
        yield* service.reclaimExistingStorage.pipe(
          Effect.provideService(Statement.CurrentTransformer, observe),
          Effect.withTracer(Tracer.nativeTracer),
        );
        expect(steps.filter((query) => query === "PRAGMA incremental_vacuum(1)")).toHaveLength(64);
        expect(steps.some((query) => /^(?:VACUUM|DELETE|UPDATE|INSERT|CREATE)/i.test(query))).toBe(
          false,
        );
        const after = yield* physical;
        expect(initial.free - after.free).toBe(64);
        expect(yield* inspect(config)).toEqual(before);
        yield* service.reclaimExistingStorage;
        expect(after.free - (yield* physical).free).toBe(64);
        expect(yield* inspect(config)).toEqual(before);
        const fs = yield* FileSystem.FileSystem;
        expect(new Uint8Array(yield* fs.readFile(`${config.spacesAssetsDir}/${a.digest}`))).toEqual(
          pdf,
        );
        const report = yield* service.maintainAssets;
        const measured = yield* physical;
        expect(report).toMatchObject({
          reclaimableBytes: measured.free * measured.size,
          incrementalVacuumEnabled: true,
          registeredAssetBytes: pdf.length,
          reconciliation: { gcEnabled: false },
        });
        expect((yield* service.getPage({ ...env, pageId })).page.revision).toBe(2);
      }).pipe(Effect.provide(live())),
    ),
);
