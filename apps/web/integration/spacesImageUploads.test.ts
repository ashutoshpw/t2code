import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, expect } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import { imageAssetId } from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { TextSelection } from "@tiptap/pm/state";
import { SpaceDocumentController } from "../src/spaces/documentController.ts";
import { spaceDocumentBlocks } from "../src/spaces/document.ts";
import { environmentId, fixture, savedParagraph, savedView } from "./spacesEditorBridge.support.ts";
import { rootReorderFixture } from "./spacesServiceFixtures.support.ts";
import { imageBytes, imageWorkflowFixture } from "./spacesImageFixtures.support.ts";

it.effect(
  "streams an actual image, binds one durable insertion across two PM views, saves pins and retains newer drafts before releasing its original",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            try {
              const record = await h.images.add(h.key, h.file(), "image.png");
              assert.equal(h.counts().mintCalls, 0);
              await h.images.upload(record.id);
              const ready = h.images.getSnapshot().records[0]!;
              assert.equal(ready.phase, "ready");
              assert.deepEqual(ready.ready?.imageDimensions, { width: 1, height: 1 });
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              const binding = h.images.getSnapshot().records[0]!;
              assert.equal(binding.phase, "drafted");
              assert.deepEqual(
                spaceDocumentBlocks(peer.state.doc),
                controller.session.getSnapshot().blocks,
              );
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.equal(
                controller.session.getSnapshot().blocks[0]!.id,
                binding.placement!.block.id,
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.deepEqual(h.documentRequests[0]!.mutations, [
                { kind: "insert", block: binding.placement!.block },
              ]);
              assert.deepEqual(binding.placement!.block.content, {
                assetId: ready.handle!.assetId,
              });
              assert.isFalse(
                peer.bridge.adapter.remove(binding.placement!.block.id)(peer.state, peer.dispatch),
              );
              assert.isFalse(controller.session.getSnapshot().dirty);
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.deepEqual(
                  sql
                    .prepare("SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=?")
                    .all(binding.placement!.block.id)
                    .map((r) => r.asset_id),
                  [ready.handle!.assetId],
                );
              } finally {
                sql.close();
              }
              await expect(h.images.insert(record.id, port)).rejects.toThrow("already bound");
              h.control.holdPhase = "release";
              const releasing = h.images.release(record.id, port);
              await h.control.entered.promise;
              try {
                assert.isFalse(peer.bridge.adapter.append()(peer.state, peer.dispatch));
                await expect(controller.save()).rejects.toThrow("retained image");
              } finally {
                h.control.release.resolve();
              }
              await releasing;
              assert.isTrue(peer.bridge.adapter.append()(peer.state));
              assert.equal((await h.originals.load()).length, 0);
              assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["original", "minting", "upload"] as const)(
  "persists image %s before the next network boundary and retains exact replay identity after a failed write",
  (phase) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            h.control.failPhase = phase;
            if (phase === "original") {
              await expect(h.images.add(h.key, h.file(), "image.png")).rejects.toThrow(
                "persistence failed",
              );
              assert.equal((await h.originals.load()).length, 0);
              assert.deepEqual(h.counts(), { mintCalls: 0, posts: 0 });
            } else {
              const record = await h.images.add(h.key, h.file(), "image.png");
              await expect(h.images.upload(record.id)).rejects.toThrow("persistence failed");
              assert.equal(h.counts().posts, 0);
              assert.equal(h.counts().mintCalls, phase === "minting" ? 0 : 1);
              const retained = (await h.originals.load())[0]!;
              assert.equal(retained.id, record.id);
              assert.deepEqual(new Uint8Array(await retained.original.arrayBuffer()), imageBytes);
              await h.images.upload(record.id);
              const ready = h.images.getSnapshot().records[0]!;
              assert.equal(ready.phase, "ready");
              assert.equal(ready.intent.requestId, record.id);
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare(
                      "SELECT COUNT(*) AS count FROM spaces_asset_uploads WHERE request_id=?",
                    )
                    .get(record.id)!.count,
                  1,
                );
              } finally {
                sql.close();
              }
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "recovers lost POST replies with the same ready handle and refuses a lost mint after caller replacement/reload",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const first = await h.images.add(h.key, h.file(), "image.png");
            h.control.losePost = true;
            await expect(h.images.upload(first.id)).rejects.toThrow("Lost byte POST");
            const handle = (await h.originals.load())[0]!.handle;
            h.control.session = {};
            h.control.caller = "b";
            await h.images.upload(first.id);
            assert.deepEqual(h.images.getSnapshot().records[0]!.handle, handle);
            assert.equal(h.counts().posts, 1);
            const second = await h.images.add(h.key, h.file(), "again.png");
            h.control.loseMint = true;
            await expect(h.images.upload(second.id)).rejects.toThrow("Lost mint");
            const calls = h.counts().mintCalls;
            h.control.session = {};
            h.control.caller = "a";
            h.reload();
            await expect(h.images.upload(second.id)).rejects.toThrow("Mint outcome unresolved");
            assert.equal(h.counts().mintCalls, calls);
            assert.equal((await h.originals.load()).length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["page-draft", "binding"] as const)(
  "recovers the %s insertion crash interval from actual encoded draft/original files without duplicate image IDs",
  (failure) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            let controller = h.createController();
            await controller.open();
            let view = savedView(controller);
            try {
              const original = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(original.id);
              if (failure === "page-draft") h.control.failDraft = true;
              else h.control.failPhase = "drafted";
              await expect(
                h.images.insert(
                  original.id,
                  view.bridge.imageInsertion(() => view.state, view.dispatch),
                ),
              ).rejects.toThrow();
              const pending = (await h.originals.load())[0]!;
              assert.equal(pending.phase, "preparing");
              await expect(controller.save()).rejects.toThrow("retained image");
              view.stop();
              h.control.failDraft = false;
              h.reload();
              controller = h.createController();
              await controller.open();
              view = savedView(controller);
              await h.images.insert(
                original.id,
                view.bridge.imageInsertion(() => view.state, view.dispatch),
              );
              assert.equal(controller.session.getSnapshot().blocks.length, 1);
              assert.equal(
                controller.session.getSnapshot().blocks[0]!.id,
                pending.placement!.block.id,
              );
              await controller.save();
              const now = await h.ports.getPage(h.key);
              const blocks = (
                await h.run(service.readBlocks({ ...h.key, revision: now.page.revision }))
              ).blocks;
              assert.equal(blocks.length, 1);
              assert.equal(blocks[0]!.id, pending.placement!.block.id);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([false, true])(
  "refuses a GC-retired ready asset before a NEW page intent without silently replacing its original (already drafted: %s)",
  (alreadyDrafted) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          const record = yield* Effect.promise(async () => {
            const value = await h.images.add(h.key, h.file(), "image.png");
            await h.images.upload(value.id);
            return h.images.getSnapshot().records[0]!;
          });
          let opened: {
            controller: SpaceDocumentController;
            view: ReturnType<typeof savedView>;
          } | null = null;
          if (alreadyDrafted)
            opened = yield* Effect.promise(async () => {
              const controller = h.createController();
              await controller.open();
              const view = savedView(controller);
              await h.images.insert(
                record.id,
                view.bridge.imageInsertion(() => view.state, view.dispatch),
              );
              return { controller, view };
            });
          for (const _step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) yield* service.maintainAssets;
          const observed = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
          try {
            assert.equal(
              observed
                .prepare("SELECT unreferenced_at_ms FROM spaces_asset_blobs WHERE digest=?")
                .get(record.ready!.digest)!.unreferenced_at_ms,
              0,
            );
          } finally {
            observed.close();
          }
          yield* TestClock.adjust("24 hours");
          yield* service.maintainAssets;
          yield* Effect.promise(async () => {
            await expect(
              h.metadata({ environmentId, assetId: record.handle!.assetId }),
            ).rejects.toThrow();
            const controller = opened?.controller ?? h.createController();
            if (!opened) await controller.open();
            const view = opened?.view ?? savedView(controller);
            try {
              if (opened) {
                const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
                await expect(controller.save()).rejects.toThrow(
                  "Image is unavailable for a new save",
                );
                assert.isNull(controller.session.getSnapshot().pending);
                assert.isNull(controller.getSnapshot().error);
                assert.isNotNull(controller.getSnapshot().imageAdmissionError);
                assert.equal(h.documentRequests.length, 0);
                const bound = h.images.getSnapshot().records[0]!;
                const replacement = await h.images.newAttempt(record.id, port);
                assert.isTrue(
                  view.bridge.adapter.remove(bound.placement!.block.id)(view.state, view.dispatch),
                );
                await h.images.release(record.id, port);
                await h.images.upload(replacement.id);
                assert.notEqual(
                  h.images.getSnapshot().records[0]!.handle!.assetId,
                  record.handle!.assetId,
                );
                await h.images.insert(replacement.id, port);
                await controller.save();
                assert.equal(h.documentRequests.length, 1);
                await h.images.release(replacement.id, port);
                assert.equal((await h.originals.load()).length, 0);
                return;
              }
              await expect(
                h.images.insert(
                  record.id,
                  view.bridge.imageInsertion(() => view.state, view.dispatch),
                ),
              ).rejects.toThrow();
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              assert.isNull(controller.session.getSnapshot().pending);
              assert.equal(
                h.images.getSnapshot().records[0]!.handle!.assetId,
                record.handle!.assetId,
              );
              assert.equal(h.counts().mintCalls, 1);
              assert.equal((await h.originals.load()).length, 1);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps an uncertain image request exact through lookup and a newer local suffix, then releases only after the newer save",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("before");
              const original = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(original.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(original.id, port);
              h.control.holdDocument = true;
              h.control.loseDocument = true;
              const saving = controller.save();
              const rejected = expect(saving).rejects.toThrow("Lost image document");
              await h.control.committed.promise;
              const pending = controller.session.getSnapshot().pending!;
              const beforeUndo = view.state.doc;
              assert.isFalse(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.isTrue(view.state.doc.eq(beforeUndo));
              let position = -1;
              view.state.doc.descendants((node, pos) => {
                if (node.isTextblock && node.attrs.block?.type === "paragraph") position = pos + 1;
              });
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, position)),
              );
              view.edit("newer-");
              assert.strictEqual(controller.session.getSnapshot().pending, pending);
              h.control.documentReply.resolve();
              await rejected;
              await expect(h.images.newAttempt(original.id, port)).rejects.toThrow(
                "Resolve the original",
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.isTrue(controller.session.getSnapshot().dirty);
              await expect(h.images.release(original.id, port)).rejects.toThrow(
                "newer image drafts",
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 2);
              assert.equal(h.documentRequests[0]!.mutationId, pending.mutationId);
              assert.equal(h.documentRequests[0]!.receiptEpoch, pending.receiptEpoch);
              assert.isTrue(
                h.documentRequests[1]!.mutations.every(
                  (m) => m.kind === "replace" && m.block.type === "paragraph",
                ),
              );
              const image = controller.session.getSnapshot().blocks.find((b) => imageAssetId(b))!;
              assert.isFalse(peer.bridge.adapter.remove(image.id)(peer.state, peer.dispatch));
              await h.images.release(original.id, port);
              assert.equal((await h.originals.load()).length, 0);
            } finally {
              h.control.documentReply.resolve();
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains a closed-view preparing intent and only reselects a proven unused placement explicitly",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            let current = true;
            const port = view.bridge.imageInsertion(
              () => view.state,
              view.dispatch,
              () => current,
            );
            try {
              const record = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(record.id);
              h.control.holdPhase = "preparing";
              const inserting = h.images.insert(record.id, port);
              await h.control.entered.promise;
              await expect(controller.save()).rejects.toThrow("retained image insertion");
              assert.isFalse(view.bridge.adapter.append()(view.state, view.dispatch));
              assert.equal(h.documentRequests.length, 0);
              current = false;
              h.control.release.resolve();
              await expect(inserting).rejects.toThrow("no longer current");
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              await expect(h.images.reselectPlacement(record.id, port)).rejects.toThrow(
                "No current",
              );
              current = true;
              const previous = h.images.getSnapshot().records[0]!.placement!.block.id;
              await h.images.reselectPlacement(record.id, port);
              await h.images.insert(record.id, port);
              assert.notEqual(controller.session.getSnapshot().blocks[0]!.id, previous);
              assert.equal(h.counts().posts, 1);
            } finally {
              h.control.release.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "guards hidden retained originals, one active operation, local limits and destination permission without writing the backend",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const record = await h.images.add(h.key, h.file(), "image.png");
            const hidden = h.reload();
            const release = hidden.reserve(environmentId, [h.key.pageId]);
            try {
              await expect(hidden.checkPages(environmentId, [h.key.pageId])).rejects.toThrow(
                "retained image originals",
              );
              await expect(hidden.add(h.key, h.file(), "another.png")).rejects.toThrow(
                "placement is reserved",
              );
            } finally {
              release();
            }
            await hidden.add(h.key, h.file(), "second.png");
            await expect(hidden.add(h.key, h.file(), "third.png")).rejects.toThrow(
              "Two image originals",
            );
            h.control.operate = false;
            await expect(hidden.upload(record.id)).rejects.toThrow("permission withdrawn");
            h.control.operate = true;
            h.control.holdPhase = "minting";
            const upload = hidden.upload(record.id);
            await h.control.entered.promise;
            await expect(hidden.upload(record.id)).rejects.toThrow("already active");
            assert.throws(
              () => hidden.reserve(environmentId, [h.key.pageId]),
              "active image operation",
            );
            h.control.release.resolve();
            await upload;
            assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["edit", "permission", "connection"] as const)(
  "refuses stale asynchronous image admission without trapping the unsent draft (%s)",
  (change) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              const record = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(record.id);
              await h.images.insert(
                record.id,
                view.bridge.imageInsertion(() => view.state, view.dispatch),
              );
              h.control.holdMetadata = true;
              const saving = controller.save();
              const rejected = expect(saving).rejects.toThrow();
              await h.control.metadataEntered.promise;
              if (change === "edit") {
                view.dispatch(view.state.tr.insertText("newer", 1));
              } else if (change === "permission") h.control.operate = false;
              else h.control.session = {};
              h.control.metadataReply.resolve();
              await rejected;
              assert.equal(h.documentRequests.length, 0);
              assert.isNull(controller.session.getSnapshot().pending);
              assert.isNull(controller.getSnapshot().error);
              assert.isNotNull(controller.getSnapshot().imageAdmissionError);
              h.control.operate = true;
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.equal(controller.session.getSnapshot().dirty, false);
              if (change === "edit")
                assert.include(JSON.stringify(controller.session.getSnapshot().blocks), "newer");
            } finally {
              h.control.metadataReply.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "recovers a lost finalize reply after reload, then retains the exact image draft and original on a real revision conflict",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const record = await h.images.add(h.key, h.file(), "image.png");
            h.control.loseFinalize = true;
            await expect(h.images.upload(record.id)).rejects.toThrow("Lost finalize");
            const handle = (await h.originals.load())[0]!.handle;
            h.reload();
            await h.images.upload(record.id);
            assert.deepEqual(h.images.getSnapshot().records[0]!.handle, handle);
            assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              await h.images.insert(record.id, port);
              const attempted = controller.session.getSnapshot().blocks;
              const page = await h.ports.getPage(h.key);
              const external = await h.ports.applyBlockBatch({
                ...h.key,
                mutationId: C.SpaceMutationId.make("external-image-conflict"),
                receiptEpoch: page.mutationAdmission.epoch,
                baseRevision: page.page.revision,
                generation: 1,
                mutations: [{ kind: "insert", block: savedParagraph("external", "remote") }],
              });
              assert.equal(external.status, "saved");
              await controller.save();
              assert.equal(controller.session.getSnapshot().status, "conflict");
              assert.deepEqual(controller.session.getSnapshot().blocks, attempted);
              assert.equal(controller.session.getSnapshot().baseRevision, page.page.revision);
              assert.deepEqual((await h.originals.load())[0]!.handle, handle);
              await expect(h.images.release(record.id, port)).rejects.toThrow();
              assert.equal(h.documentRequests.length, 1);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses a real page move with a hidden durable image original before acquiring a write identity",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const pages = yield* rootReorderFixture(service);
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const record = await h.images.add(h.key, h.file(), "image.png");
            const hidden = h.reload();
            const owner = pages.make(() => {}, hidden);
            await owner.browse(pages.spaceId, h.key.pageId);
            await expect(owner.move(h.key.pageId, pages.spaceId, null)).rejects.toThrow(
              "retained image originals",
            );
            assert.equal(pages.requests.length, 0);
            assert.equal(pages.counts().admissions, 0);
            assert.deepEqual(await pages.order(), pages.pages);
            await hidden.release(record.id);
            await owner.move(h.key.pageId, pages.spaceId, null);
            assert.equal(pages.requests.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["save-prior-text", "discard-conflict"] as const)(
  "releases a cancelled image after %s advances the authoritative page revision",
  (mode) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("prior-text");
              const record = await h.images.add(h.key, h.file(), "cancelled.png");
              await h.images.upload(record.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              const bound = h.images.getSnapshot().records[0]!;
              if (mode === "save-prior-text") {
                assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
                assert.isFalse(
                  controller.session.getSnapshot().blocks.some((b) => imageAssetId(b)),
                );
                await controller.save();
              } else {
                const page = await h.ports.getPage(h.key);
                const external = await h.ports.applyBlockBatch({
                  ...h.key,
                  mutationId: C.SpaceMutationId.make("cancel-external"),
                  receiptEpoch: page.mutationAdmission.epoch,
                  baseRevision: page.page.revision,
                  generation: 1,
                  mutations: [{ kind: "insert", block: savedParagraph("external", "remote") }],
                });
                assert.equal(external.status, "saved");
                await controller.save();
                assert.equal(controller.session.getSnapshot().status, "conflict");
                await expect(h.images.release(record.id, port)).rejects.toThrow();
                assert.equal((await h.originals.load()).length, 1);
                await controller.discard();
              }
              const state = controller.session.getSnapshot();
              assert.isFalse(state.dirty);
              assert.isNull(state.pending);
              assert.isNull(state.persistenceError);
              assert.isTrue(controller.getSnapshot().completeWindow);
              assert.isAbove(state.baseRevision!, bound.placement!.revision);
              assert.isFalse(state.blocks.some((b) => imageAssetId(b)));
              h.reload();
              if (mode === "save-prior-text") {
                const partial = h.createController(1);
                await partial.open();
                const partialView = savedView(partial);
                try {
                  assert.isFalse(partial.getSnapshot().completeWindow);
                  assert.isFalse(partial.session.getSnapshot().dirty);
                  await expect(
                    h.images.release(
                      record.id,
                      partialView.bridge.imageInsertion(
                        () => partialView.state,
                        partialView.dispatch,
                      ),
                    ),
                  ).rejects.toThrow();
                  assert.equal((await h.originals.load()).length, 1);
                } finally {
                  partialView.stop();
                }
              }
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                let current = false;
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                  () => current,
                );
                await expect(h.images.release(record.id, restoredPort)).rejects.toThrow();
                assert.equal((await h.originals.load()).length, 1);
                current = true;
                restoredView.edit("unsaved-newer-");
                assert.isTrue(restored.session.getSnapshot().dirty);
                await expect(h.images.release(record.id, restoredPort)).rejects.toThrow();
                assert.equal((await h.originals.load()).length, 1);
                await restored.discard();
                await h.images.release(record.id, restoredPort);
                assert.equal((await h.originals.load()).length, 0);
                await h.images.checkPages(environmentId, [h.key.pageId]);
                assert.equal((await h.images.add(h.key, h.file(), "next.png")).slot, record.slot);
              } finally {
                restoredView.stop();
              }
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([false, true])(
  "retains an original and exact uncertain receipt across release and reload (image cancelled: %s)",
  (cancelled) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("remaining-text");
              const record = await h.images.add(h.key, h.file(), "uncertain.png");
              await h.images.upload(record.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              if (cancelled)
                assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              h.control.loseDocument = true;
              await expect(controller.save()).rejects.toThrow("Lost image document");
              const pending = controller.session.getSnapshot().pending!;
              assert.isNotNull(pending);
              const original = (await h.originals.load())[0]!;
              await expect(h.images.release(record.id, port)).rejects.toThrow(
                "pending document receipt",
              );
              assert.strictEqual(controller.session.getSnapshot().pending, pending);
              assert.deepEqual((await h.originals.load())[0], original);
              h.reload();
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                );
                await expect(h.images.release(record.id, restoredPort)).rejects.toThrow(
                  "pending document receipt",
                );
                assert.deepEqual(restored.session.getSnapshot().pending, pending);
                assert.deepEqual((await h.originals.load())[0], original);
                assert.equal(h.documentRequests.length, 1);
                await restored.save();
                assert.isNull(restored.session.getSnapshot().pending);
                await h.images.release(record.id, restoredPort);
                assert.equal((await h.originals.load()).length, 0);
                assert.equal(h.documentRequests.length, 1);
              } finally {
                restoredView.stop();
              }
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
