import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, expect } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import { mediaAssetId } from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { TextSelection } from "@tiptap/pm/state";
import { SpaceMentionController } from "../src/spaces/mentions.ts";
import { spaceDocumentBlocks } from "../src/spaces/document.ts";
import {
  environmentId,
  fixture,
  signal,
  savedParagraph,
  savedUndoFixture,
  savedView,
} from "./spacesEditorBridge.support.ts";
import { sourceFixture } from "./spacesServiceFixtures.support.ts";
import { pdfBytes, videoBytes, imageWorkflowFixture } from "./spacesImageFixtures.support.ts";

it.effect.each(["pdf", "video"] as const)(
  "uploads a durable %s through real HTTP, recovers finalize, inserts once with local Undo and saves current/history pins",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            let controller = h.createController();
            await controller.open();
            let view = savedView(controller);
            let peer = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("prior-text");
              const record = await h.images.add(
                h.key,
                h.file(kind),
                `document.${kind === "pdf" ? "pdf" : "mp4"}`,
              );
              assert.equal(record.version, 2);
              assert.equal(record.intent.mediaKind, kind);
              assert.equal(h.counts().mintCalls, 0);
              h.control.loseFinalize = true;
              await expect(h.images.upload(record.id)).rejects.toThrow("Lost finalize");
              const handle = (await h.originals.load())[0]!.handle;
              h.reload();
              await h.images.upload(record.id);
              assert.deepEqual(h.images.getSnapshot().records[0]!.handle, handle);
              assert.deepEqual(
                new Uint8Array(await h.images.getSnapshot().records[0]!.original.arrayBuffer()),
                kind === "pdf" ? pdfBytes : videoBytes,
              );
              assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
              let port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              const binding = h.images.getSnapshot().records[0]!;
              const block = binding.placement!.block;
              assert.equal(block.type, kind);
              assert.deepEqual(
                spaceDocumentBlocks(peer.state.doc),
                controller.session.getSnapshot().blocks,
              );
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks.length, 1);
              assert.include(view.state.doc.textContent, "prior-text");
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks[1]!.id, block.id);
              h.control.holdDocument = true;
              h.control.loseDocument = true;
              const saving = controller.save();
              const lost = expect(saving).rejects.toThrow("Lost image document");
              await h.control.committed.promise;
              const pending = controller.session.getSnapshot().pending!;
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              view.edit("next-");
              assert.strictEqual(controller.session.getSnapshot().pending, pending);
              h.control.documentReply.resolve();
              await lost;
              await controller.session.persistDraft();
              view.stop();
              peer.stop();
              h.reload();
              controller = h.createController();
              await controller.open();
              view = savedView(controller);
              peer = savedView(controller);
              port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              assert.deepEqual(controller.session.getSnapshot().pending, pending);
              await expect(h.images.release(record.id, port)).rejects.toThrow(
                "pending document receipt",
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.isTrue(controller.session.getSnapshot().dirty);
              assert.include(view.state.doc.textContent, "next-");
              await expect(h.images.release(record.id, port)).rejects.toThrow("newer image drafts");
              assert.isFalse(peer.bridge.adapter.remove(block.id)(peer.state, peer.dispatch));
              await controller.save();
              assert.equal(h.documentRequests.length, 2);
              assert.deepEqual(
                h.documentRequests[0]!.mutations.find(
                  (m) => m.kind === "insert" && m.block.type === kind,
                ),
                { kind: "insert", block },
              );
              assert.isTrue(
                h.documentRequests[1]!.mutations.every(
                  (m) => m.kind === "replace" && m.block.type === "paragraph",
                ),
              );
              const current = await h.ports.getPage(h.key);
              const captioned: C.SpaceBlock = {
                ...block,
                content: {
                  assetId: handle!.assetId,
                  caption: [
                    {
                      text: "retained caption",
                      marks: [
                        { type: "bold", version: 1 },
                        { type: "italic", version: 1 },
                      ],
                    },
                  ],
                },
              };
              const updated = await h.ports.applyBlockBatch({
                ...h.key,
                baseRevision: current.page.revision,
                receiptEpoch: current.mutationAdmission.epoch,
                mutationId: C.SpaceMutationId.make("caption-pin-fixture"),
                generation: 1,
                mutations: [{ kind: "replace", block: captioned }],
              });
              assert.equal(updated.status, "saved");
              await controller.refresh();
              assert.deepEqual(
                controller.session.getSnapshot().blocks.find((b) => b.id === block.id),
                captioned,
              );
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare(
                      "SELECT COUNT(*) AS n FROM spaces_block_asset_refs WHERE block_id=? AND asset_id=?",
                    )
                    .get(block.id, handle!.assetId)!.n,
                  1,
                );
                assert.isAtLeast(
                  Number(
                    sql
                      .prepare(
                        "SELECT COUNT(*) AS n FROM spaces_revision_asset_refs WHERE asset_id=?",
                      )
                      .get(handle!.assetId)!.n,
                  ),
                  1,
                );
              } finally {
                sql.close();
              }
              await h.images.release(record.id, port);
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
  "admits two shared originals up to 75 MiB and refuses oversized/new originals without evicting or minting",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const original = await h.images.add(h.key, h.file(), "kept.png");
            for (const [mime, cap] of [
              ["application/pdf", 25],
              ["video/mp4", 50],
            ] as const) {
              await expect(
                h.images.add(
                  h.key,
                  new Blob([new Uint8Array(cap * 1024 * 1024 + 1)], { type: mime }),
                  "too-big",
                ),
              ).rejects.toThrow("byte policy");
              assert.equal((await h.originals.load())[0]!.id, original.id);
              assert.equal((await h.originals.load()).length, 1);
            }
            await h.images.release(original.id);
            const full = await h.images.add(
              h.key,
              new Blob([new Uint8Array(50 * 1024 * 1024)], { type: "video/mp4" }),
              "full.mp4",
            );
            await expect(h.images.add(h.key, full.original, "second.mp4")).rejects.toThrow(
              "75 MiB",
            );
            assert.equal((await h.originals.load()).length, 1);
            await h.images.add(
              h.key,
              new Blob([new Uint8Array(25 * 1024 * 1024)], { type: "application/pdf" }),
              "full.pdf",
            );
            const stored = await h.originals.load();
            assert.equal(stored.length, 2);
            assert.equal(
              stored.reduce((n, r) => n + r.original.size, 0),
              75 * 1024 * 1024,
            );
            await expect(h.images.add(h.key, h.file(), "third.png")).rejects.toThrow();
            assert.deepEqual(h.counts(), { mintCalls: 0, posts: 0 });
            assert.equal((await h.originals.load())[0]!.id, full.id);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["pdf", "video"] as const)(
  "releases a cancelled %s after saving other text, without replaying its unsent insertion",
  (kind) =>
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
              view.edit("keep-text");
              const original = await h.images.add(h.key, h.file(kind), `cancel.${kind}`);
              await h.images.upload(original.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(original.id, port);
              const placementRevision = h.images.getSnapshot().records[0]!.placement!.revision;
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              await controller.save();
              assert.isTrue(
                h.documentRequests[0]!.mutations.every(
                  (m) => m.kind === "insert" && m.block.type === "paragraph",
                ),
              );
              assert.isAbove(controller.session.getSnapshot().baseRevision!, placementRevision);
              assert.isTrue(controller.getSnapshot().completeWindow);
              h.reload();
              await h.images.release(original.id, port);
              assert.equal((await h.originals.load()).length, 0);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["pdf", "video"] as const)(
  "retains the exact %s pending intent and original when GC wins after readiness preflight",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          const controller = h.createController();
          yield* Effect.promise(() => controller.open());
          const view = savedView(controller);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              h.control.metadataReply.resolve();
              view.stop();
            }),
          );
          const original = yield* Effect.promise(async () => {
            const r = await h.images.add(h.key, h.file(kind), `retained.${kind}`);
            await h.images.upload(r.id);
            await h.images.insert(
              r.id,
              view.bridge.imageInsertion(() => view.state, view.dispatch),
            );
            return h.images.getSnapshot().records[0]!;
          });
          h.control.holdMetadata = true;
          const saving = controller.save().then(
            () => null,
            (error) => error,
          );
          yield* Effect.promise(() =>
            Promise.race([
              h.control.metadataEntered.promise,
              saving.then((error) => {
                throw error ?? new Error("Save completed before held metadata");
              }),
            ]),
          );
          for (const _step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) yield* service.maintainAssets;
          yield* TestClock.adjust("24 hours");
          yield* service.maintainAssets;
          h.control.metadataReply.resolve();
          const error = yield* Effect.promise(() => saving);
          assert.isNotNull(error);
          const pending = controller.session.getSnapshot().pending!;
          assert.isNotNull(pending);
          yield* Effect.promise(async () => {
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            await expect(h.images.newAttempt(original.id, port)).rejects.toThrow(
              "Resolve the original",
            );
            await expect(h.images.release(original.id, port)).rejects.toThrow(
              "pending document receipt",
            );
            await controller.save();
            assert.deepEqual(controller.session.getSnapshot().pending, pending);
            assert.equal(h.documentRequests.length, 1);
            assert.equal(h.documentRequests[0]!.mutationId, pending.mutationId);
            assert.equal(h.documentRequests[0]!.receiptEpoch, pending.receiptEpoch);
            assert.deepEqual((await h.originals.load())[0]!.handle, original.handle);
            assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["image", "pdf", "video"] as const)(
  "edits rich %s captions in the shared PM/session and explicitly removes media with local history",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const original = await h.images.add(h.key, h.file(kind), `caption.${kind}`);
            await h.images.upload(original.id);
            const assetId = h.images.getSnapshot().records[0]!.handle!.assetId;
            const page = await h.ports.getPage(h.key);
            const block: C.SpaceBlock = {
              id: C.SpaceBlockId.make("caption-media"),
              parentId: null,
              order: "8".padEnd(32, "0"),
              type: kind,
              version: 1,
              content: {
                assetId,
                caption: [
                  {
                    text: "A😀B",
                    marks: [
                      { type: "bold", version: 1 },
                      { type: "italic", version: 1 },
                    ],
                  },
                  { text: " page", marks: [{ type: "page_mention", version: 1, target: h.key }] },
                ],
              },
            };
            const seed = await h.ports.applyBlockBatch({
              ...h.key,
              mutationId: C.SpaceMutationId.make("seed-caption"),
              receiptEpoch: page.mutationAdmission.epoch,
              baseRevision: page.page.revision,
              generation: 1,
              mutations: [{ kind: "insert", block }],
            });
            assert.equal(seed.status, "saved");
            await h.images.release(original.id);
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            try {
              assert.isTrue(view.state.doc.firstChild!.isTextblock);
              const before = controller.session.getSnapshot();
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)));
              view.bridge.setWritable(true, false);
              assert.isFalse(view.bridge.adapter.mark("bold")(view.state, view.dispatch));
              view.dispatch(view.state.tr.insertText("permission denied", 1));
              assert.strictEqual(controller.session.getSnapshot(), before);
              view.bridge.setWritable(true);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 3)));
              assert.isFalse(
                view.bridge.adapter.setLink("https://example.test")(view.state, view.dispatch),
              );
              assert.strictEqual(controller.session.getSnapshot(), before);
              const captionDoc = view.state.doc;
              view.dispatch(view.state.tr.insertText("broken", 3));
              assert.strictEqual(view.state.doc, captionDoc);
              assert.strictEqual(controller.session.getSnapshot(), before);
              assert.isFalse(view.bridge.adapter.mark("strike")(view.state, view.dispatch));
              assert.strictEqual(controller.session.getSnapshot(), before);
              assert.isFalse(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              view.edit("caption-");
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 9)));
              assert.isTrue(
                view.bridge.adapter.setLink("https://example.test")(view.state, view.dispatch),
              );
              assert.include(
                JSON.stringify(controller.session.getSnapshot().blocks[0]!.content),
                "https://example.test",
              );
              assert.isTrue(view.bridge.adapter.removeLink()(view.state, view.dispatch));
              const changed = controller.session.getSnapshot().blocks[0]!;
              assert.equal(mediaAssetId(changed), assetId);
              assert.include(JSON.stringify(changed.content), "page_mention");
              assert.include(JSON.stringify(changed.content), "italic");
              assert.deepEqual(
                spaceDocumentBlocks(peer.state.doc),
                controller.session.getSnapshot().blocks,
              );
              await controller.save();
              const savedCaption = controller.session.getSnapshot();
              view.bridge.setWritable(true, false);
              assert.isFalse(await view.bridge.compensate("undo"));
              assert.strictEqual(controller.session.getSnapshot(), savedCaption);
              view.bridge.setWritable(true);
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [block]);
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.include(view.state.doc.textContent, "caption-");
              assert.isTrue(view.bridge.adapter.removeMedia(block.id)(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks[0]!.id, block.id);
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              await controller.save();
              assert.isFalse(await view.bridge.compensate("undo"));
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare("SELECT COUNT(*) AS n FROM spaces_block_asset_refs WHERE block_id=?")
                    .get(block.id)!.n,
                  0,
                );
                assert.isAtLeast(
                  Number(
                    sql
                      .prepare(
                        "SELECT COUNT(*) AS n FROM spaces_revision_asset_refs WHERE asset_id=?",
                      )
                      .get(assetId)!.n,
                  ),
                  1,
                );
              } finally {
                sql.close();
              }
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["image", "pdf", "video"] as const)(
  "replaces a committed %s through the durable original authority, preserves identity/caption and server history pins",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(kind), `a.${kind}`);
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              view.edit("original caption");
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.include(
                JSON.stringify(controller.session.getSnapshot().blocks[0]!.content),
                "original caption",
              );
              view.dispatch(view.state.tr.delete(1, 1 + "original caption".length));
              assert.equal(view.state.doc.textContent, "");
              assert.equal(controller.session.getSnapshot().blocks.length, 1);
              view.edit("original caption");
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              const assetA = mediaAssetId(before)!;
              await h.images.release(a.id, port);
              const b = await h.images.addReplacement(port, before.id, h.file(kind), `b.${kind}`);
              assert.deepEqual(b.replacement!.before, before);
              await h.images.upload(b.id);
              await h.images.insert(b.id, port);
              const after = controller.session.getSnapshot().blocks[0]!;
              assert.equal(after.id, before.id);
              assert.notEqual(mediaAssetId(after), assetA);
              assert.deepEqual(spaceDocumentBlocks(peer.state.doc), [after]);
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().blocks, [before]);
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().blocks, [after]);
              await controller.save();
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare("SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=?")
                    .get(before.id)!.asset_id,
                  mediaAssetId(after),
                );
                assert.isAtLeast(
                  Number(
                    sql
                      .prepare(
                        "SELECT COUNT(*) AS n FROM spaces_revision_asset_refs WHERE asset_id=?",
                      )
                      .get(assetA)!.n,
                  ),
                  1,
                );
              } finally {
                sql.close();
              }
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [before]);
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [after]);
              await h.images.release(b.id, port);
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["late-caption", "lost-reply-reload"] as const)(
  "retains exact replacement intent and newer captions across %s",
  (mode) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(), "before.png");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              const b = await h.images.addReplacement(port, before.id, h.file("pdf"), "after.pdf");
              await h.images.upload(b.id);
              await h.images.insert(b.id, port);
              const replacement = controller.session.getSnapshot().blocks[0]!;
              if (mode === "late-caption") {
                h.control.holdDocument = true;
                const saving = controller.save();
                try {
                  await h.control.committed.promise;
                  view.dispatch(
                    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)),
                  );
                  view.edit("later caption");
                  const pending = controller.session.getSnapshot().pending;
                  await expect(h.images.release(b.id, port)).rejects.toThrow(
                    "pending document receipt",
                  );
                  assert.deepEqual(controller.session.getSnapshot().pending, pending);
                } finally {
                  h.control.documentReply.resolve();
                }
                await saving;
                const suffix = controller.session.getSnapshot();
                assert.isTrue(suffix.dirty);
                assert.isNull(suffix.pending);
                assert.equal(mediaAssetId(suffix.blocks[0]!), mediaAssetId(replacement));
                assert.include(JSON.stringify(suffix.blocks[0]!.content), "later caption");
                await controller.save();
                assert.equal(h.documentRequests.length, 3);
                assert.equal(h.documentRequests[2]!.mutations.length, 1);
                assert.equal(h.documentRequests[2]!.mutations[0]!.kind, "replace");
              } else {
                h.control.loseDocument = true;
                await expect(controller.save()).rejects.toThrow(
                  "Lost image document acknowledgement",
                );
                const pending = controller.session.getSnapshot().pending!;
                assert.isNotNull(pending);
                await expect(h.images.release(b.id, port)).rejects.toThrow(
                  "pending document receipt",
                );
                await expect(h.images.newAttempt(b.id, port)).rejects.toThrow(
                  "Resolve the original",
                );
                await h.images.hydrate();
                await h.reload().hydrate();
                const restored = h.createController();
                await restored.open();
                const restoredView = savedView(restored);
                try {
                  assert.deepEqual(restored.session.getSnapshot().pending, pending);
                  await restored.save();
                  assert.isNull(restored.session.getSnapshot().pending);
                  assert.deepEqual(restored.session.getSnapshot().blocks, [replacement]);
                  assert.equal(h.documentRequests.length, 2);
                  assert.deepEqual(h.documentRequests[1]!.mutations, pending.mutations);
                  assert.equal(h.documentRequests[1]!.mutationId, pending.mutationId);
                  assert.equal(h.documentRequests[1]!.receiptEpoch, pending.receiptEpoch);
                  await h.images.release(
                    b.id,
                    restoredView.bridge.imageInsertion(
                      () => restoredView.state,
                      restoredView.dispatch,
                    ),
                  );
                } finally {
                  restoredView.stop();
                }
              }
            } finally {
              h.control.documentReply.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["undo-save", "conflict-discard"] as const)(
  "releases a cancelled replacement after revision advances via %s without changing the original media",
  (mode) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file("video"), "before.mp4");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("text");
              await controller.save();
              const b = await h.images.addReplacement(port, before.id, h.file(), "after.png");
              await h.images.upload(b.id);
              await h.images.insert(b.id, port);
              if (mode === "undo-save") {
                assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
                assert.equal(
                  mediaAssetId(controller.session.getSnapshot().blocks[0]!),
                  mediaAssetId(before),
                );
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
                  ),
                );
                view.edit(" remains");
                await controller.save();
              } else {
                const remote = await h.ports.getPage(h.key);
                const text = controller.session.getSnapshot().blocks[1]!;
                const result = await h.ports.applyBlockBatch({
                  ...h.key,
                  mutationId: C.SpaceMutationId.make("replacement-conflict"),
                  receiptEpoch: remote.mutationAdmission.epoch,
                  baseRevision: remote.page.revision,
                  generation: 1,
                  mutations: [
                    {
                      kind: "replace",
                      block: { ...text, content: { runs: [{ text: "remote", marks: [] }] } },
                    },
                  ],
                });
                assert.equal(result.status, "saved");
                await controller.save();
                assert.equal(controller.session.getSnapshot().status, "conflict");
                await expect(h.images.release(b.id, port)).rejects.toThrow("Save or resolve");
                await controller.discard();
              }
              assert.isFalse(controller.session.getSnapshot().dirty);
              assert.deepEqual(controller.session.getSnapshot().blocks[0], before);
              await h.images.release(b.id, port);
              assert.equal((await h.originals.load()).length, 0);
              assert.deepEqual(
                (
                  await h.run(
                    service.readBlocks({
                      ...h.key,
                      revision: (await h.ports.getPage(h.key)).page.revision,
                      limit: 100,
                    }),
                  )
                ).blocks[0],
                before,
              );
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "fails replacement admission before network writes, retains changed targets, and reconciles a durable preparing replacement once after reload",
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
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(), "before.png");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              h.control.failPhase = "original";
              await expect(
                h.images.addReplacement(port, before.id, h.file(), "failed.png"),
              ).rejects.toThrow("persistence failed");
              assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
              assert.equal((await h.originals.load()).length, 0);
              const b = await h.images.addReplacement(port, before.id, h.file(), "after.png");
              await h.images.upload(b.id);
              h.control.holdMetadata = true;
              const applying = h.images.insert(b.id, port);
              try {
                await h.control.metadataEntered.promise;
                peer.dispatch(peer.state.tr.setSelection(TextSelection.create(peer.state.doc, 1)));
                peer.edit("target changed");
              } finally {
                h.control.metadataReply.resolve();
              }
              await expect(applying).rejects.toThrow("Replacement target changed");
              assert.equal(h.images.getSnapshot().records[0]!.phase, "ready");
              assert.equal(
                mediaAssetId(controller.session.getSnapshot().blocks[0]!),
                mediaAssetId(before),
              );
              await h.images.release(b.id, port);
              const c = await h.images.addReplacement(
                port,
                before.id,
                h.file("video"),
                "after.mp4",
              );
              await h.images.upload(c.id);
              h.control.failPhase = "drafted";
              await expect(h.images.insert(c.id, port)).rejects.toThrow("persistence failed");
              const desired = controller.session.getSnapshot().blocks[0]!;
              assert.equal(desired.type, "video");
              assert.include(JSON.stringify(desired.content), "target changed");
              assert.equal(h.images.getSnapshot().records[0]!.phase, "preparing");
              await expect(controller.save()).rejects.toThrow();
              await expect(h.images.release(c.id, port)).rejects.toThrow("unresolved");
              await h.reload().hydrate();
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                );
                await h.images.insert(c.id, restoredPort);
                assert.deepEqual(restored.session.getSnapshot().blocks, [desired]);
                await restored.save();
                await h.images.release(c.id, restoredPort);
                assert.equal(h.documentRequests.length, 2);
                assert.equal(h.documentRequests[1]!.mutations.length, 1);
                assert.equal(h.documentRequests[1]!.mutations[0]!.kind, "replace");
              } finally {
                restoredView.stop();
              }
            } finally {
              h.control.metadataReply.resolve();
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "cancels an unapplied preparing replacement after navigation and an authoritative revision change without releasing uncertain bindings",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(), "before.png");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              const b = await h.images.addReplacement(port, before.id, h.file("pdf"), "after.pdf");
              await h.images.upload(b.id);
              let current = true;
              const departing = view.bridge.imageInsertion(
                () => view.state,
                view.dispatch,
                () => current,
              );
              h.control.holdPhase = "preparing";
              const applying = h.images.insert(b.id, departing);
              try {
                await h.control.entered.promise;
                current = false;
              } finally {
                h.control.release.resolve();
              }
              await expect(applying).rejects.toThrow("no longer current");
              assert.deepEqual(controller.session.getSnapshot().blocks, [before]);
              await expect(h.images.release(b.id, port)).rejects.toThrow("unresolved");
              const page = await h.ports.getPage(h.key);
              const remote = {
                ...before,
                content: {
                  assetId: mediaAssetId(before)!,
                  caption: [{ text: "remote caption", marks: [] }],
                },
              };
              const result = await h.ports.applyBlockBatch({
                ...h.key,
                mutationId: C.SpaceMutationId.make("replacement-navigation-remote"),
                receiptEpoch: page.mutationAdmission.epoch,
                baseRevision: page.page.revision,
                generation: 1,
                mutations: [{ kind: "replace", block: remote }],
              });
              assert.equal(result.status, "saved");
              await h.reload().hydrate();
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                );
                assert.deepEqual(restored.session.getSnapshot().blocks, [remote]);
                await h.images.reselectPlacement(b.id, restoredPort);
                await h.images.release(b.id, restoredPort);
                assert.deepEqual(restored.session.getSnapshot().blocks, [remote]);
                assert.equal((await h.originals.load()).length, 0);
                assert.equal(h.documentRequests.length, 1);
              } finally {
                restoredView.stop();
              }
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
  "inserts canonical page and block mentions through the guarded chooser, preserves formatting and saves/reopens exact targets",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            const opened = h.documents.open(h.key),
              controller = await opened.ready;
            controller.session.apply([
              {
                kind: "insert",
                block: {
                  ...savedParagraph("mention-edit", "before 😀 after"),
                  content: {
                    runs: [
                      {
                        text: "before 😀 after",
                        marks: [
                          { type: "bold", version: 1 },
                          { type: "italic", version: 1 },
                        ],
                      },
                    ],
                  },
                },
              },
            ]);
            await controller.save();
            const view = savedView(controller);
            try {
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 7)));
              const selection = view.bridge.mentionInsertion(() => view.state, view.dispatch);
              view.dispatch(view.state.tr.setMeta("blur", { event: {} }));
              assert.isTrue(selection.current());
              const mentions = new SpaceMentionController(h.sources, environmentId, () => true);
              await mentions.search("Second");
              const window = await mentions.search("Second");
              if (window.status !== "ready") throw Error(window.status);
              assert.isTrue(await mentions.choose(window, 0, selection));
              const inserted = controller.session.getSnapshot().blocks[0]!;
              assert.include(JSON.stringify(inserted.content), '"type":"page_mention"');
              assert.include(JSON.stringify(inserted.content), '"type":"bold"');
              assert.include(JSON.stringify(inserted.content), '"type":"italic"');
              assert.include(view.state.doc.textContent, "Second 😀 after");
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(view.state.doc.textContent, "before 😀 after");
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              await controller.save();
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.equal(view.state.doc.textContent, "before 😀 after");
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [inserted]);
              const stored = await h.run(
                service.readBlocks({
                  ...h.key,
                  revision: controller.session.getSnapshot().baseRevision!,
                }),
              );
              assert.deepEqual(stored.blocks, [inserted]);
              const original = view.state.doc;
              view.dispatch(view.state.tr.insertText("bad", 3));
              assert.strictEqual(view.state.doc, original);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
              assert.isFalse(view.bridge.adapter.split()(view.state, view.dispatch));
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 7)));
              assert.isTrue(view.bridge.adapter.mark("strike")(view.state, view.dispatch));
              const withMention = controller.session.getSnapshot().blocks;
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              assert.isTrue(view.bridge.adapter.mentionBoundary(1)(view.state, view.dispatch));
              assert.equal(view.state.selection.from, 7);
              assert.isTrue(
                view.bridge.adapter.mentionBoundary(-1, true)(view.state, view.dispatch),
              );
              assert.notInclude(view.state.doc.textContent, "Second");
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().blocks, withMention);
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
                ),
              );
              const blockSelection = view.bridge.mentionInsertion(() => view.state, view.dispatch);
              const blockWindow = await mentions.search("after");
              if (blockWindow.status !== "ready") throw Error(blockWindow.status);
              const blockIndex = blockWindow.result.items.findIndex(
                (hit) => hit.blockId === C.SpaceBlockId.make("mention-edit"),
              );
              assert.isAtLeast(blockIndex, 0);
              assert.isTrue(await mentions.choose(blockWindow, blockIndex, blockSelection));
              assert.include(
                JSON.stringify(controller.session.getSnapshot().blocks),
                '"type":"block_mention"',
              );
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.notInclude(
                JSON.stringify(controller.session.getSnapshot().blocks),
                '"type":"block_mention"',
              );
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              await controller.save();
              const expected = controller.session.getSnapshot().blocks;
              controller.invalidate();
              await controller.open();
              assert.deepEqual(controller.session.getSnapshot().blocks, expected);
            } finally {
              view.stop();
              opened.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([
  "selection",
  "away-back",
  "text",
  "write",
  "read",
  "flag",
  "connection",
  "route",
] as const)("refuses mention insertion when %s changes during real source resolution", (mode) =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* sourceFixture(service);
        yield* Effect.promise(async () => {
          const opened = h.documents.open(h.key),
            controller = await opened.ready;
          controller.session.apply([
            { kind: "insert", block: savedParagraph("mention-stale", "retain 😀 text") },
          ]);
          await controller.save();
          const view = savedView(controller),
            peer = savedView(controller);
          const gate = { ...signal(), reply: signal() };
          let current = true;
          try {
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
            const selection = view.bridge.mentionInsertion(
              () => view.state,
              view.dispatch,
              () => current,
            );
            const mentions = new SpaceMentionController(h.sources, environmentId);
            await mentions.search("Second");
            const window = await mentions.search("Second");
            if (window.status !== "ready") throw Error(window.status);
            h.control.resolveGate = gate;
            const choosing = mentions.choose(window, 0, selection);
            try {
              await gate.promise;
              if (mode === "selection" || mode === "away-back") {
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
                if (mode === "away-back")
                  view.dispatch(
                    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)),
                  );
              } else if (mode === "text") {
                peer.dispatch(peer.state.tr.insertText("other view", 1));
              } else if (mode === "write") view.bridge.setWritable(false);
              else if (mode === "read") h.control.access = { ...h.control.access, canRead: false };
              else if (mode === "flag")
                h.control.access = {
                  ...h.control.access,
                  capability: {
                    version: 2,
                    limits: h.capability.limits,
                    features: { search: true },
                  },
                };
              else if (mode === "connection")
                h.control.access = { ...h.control.access, session: {} };
              else current = false;
            } finally {
              gate.reply.resolve();
            }
            const before = controller.session.getSnapshot(),
              doc = view.state.doc;
            assert.isFalse(await choosing);
            assert.strictEqual(controller.session.getSnapshot(), before);
            assert.strictEqual(view.state.doc, doc);
            assert.notInclude(JSON.stringify(before.blocks), '"page_mention"');
          } finally {
            gate.reply.resolve();
            view.stop();
            peer.stop();
            opened.release();
          }
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "authors atomic rich caption mentions through the shared media/session path without changing asset identity",
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
              const original = await h.images.add(h.key, h.file(), "caption-mention.png");
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.upload(original.id);
              await h.images.insert(original.id, port);
              await controller.save();
              await h.images.release(original.id, port);
              const before = controller.session.getSnapshot().blocks[0]!,
                assetId = mediaAssetId(before);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              view.edit("😀 tail");
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
              assert.throws(
                () => view.bridge.mentionInsertion(() => view.state, view.dispatch),
                "Select a supported",
              );
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
              const selection = view.bridge.mentionInsertion(() => view.state, view.dispatch);
              assert.isTrue(
                selection.insert(
                  { type: "page_mention", version: 1, target: h.key },
                  "Fallback 😀",
                ),
              );
              assert.equal(mediaAssetId(controller.session.getSnapshot().blocks[0]!), assetId);
              assert.deepEqual(
                spaceDocumentBlocks(peer.state.doc),
                controller.session.getSnapshot().blocks,
              );
              const doc = view.state.doc,
                snapshot = controller.session.getSnapshot();
              view.dispatch(view.state.tr.insertText("bad", 2));
              assert.strictEqual(view.state.doc, doc);
              assert.strictEqual(controller.session.getSnapshot(), snapshot);
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 10)),
              );
              assert.isFalse(view.bridge.adapter.mark("italic")(view.state, view.dispatch));
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, 1, 1 + "Fallback 😀".length),
                ),
              );
              assert.isTrue(view.bridge.adapter.mark("bold")(view.state, view.dispatch));
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              await controller.save();
              const expected = controller.session.getSnapshot().blocks;
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [before]);
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, expected);
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["page_mention", "block_mention"] as const)(
  "undoes adjacent equal-target %s insertion through earlier unrelated history while refusing authored partial-span edits",
  (type) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* savedUndoFixture(service, [
            savedParagraph("adjacent-mention-history", "prefix First"),
          ]);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const mark: import("../src/spaces/mentions.ts").SpaceMentionMark =
              type === "page_mention"
                ? { type, version: 1, target: h.key }
                : {
                    type,
                    version: 1,
                    target: { ...h.key, blockId: C.SpaceBlockId.make("adjacent-mention-history") },
                  };
            try {
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, 8, 13)),
              );
              assert.isTrue(
                view.bridge.mentionInsertion(() => view.state, view.dispatch).insert(mark, "First"),
              );
              await controller.save();
              const baseline = controller.session.getSnapshot().blocks;
              view.dispatch(view.state.tr.insertText("old-", 1));
              const earlier = controller.session.getSnapshot().blocks;
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
                ),
              );
              assert.isTrue(
                view.bridge
                  .mentionInsertion(() => view.state, view.dispatch)
                  .insert(mark, "Second"),
              );
              assert.equal(view.state.doc.textContent, "old-prefix FirstSecond");
              const inserted = controller.session.getSnapshot(),
                doc = view.state.doc,
                end = doc.content.size - 1;
              view.dispatch(view.state.tr.delete(end - "Second".length, end));
              assert.strictEqual(view.state.doc, doc);
              assert.strictEqual(controller.session.getSnapshot(), inserted);
              view.bridge.setWritable(false);
              assert.isFalse(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.strictEqual(controller.session.getSnapshot(), inserted);
              view.bridge.setWritable(true);
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(view.state.doc.textContent, "old-prefix First");
              assert.deepEqual(controller.session.getSnapshot().blocks, earlier);
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(view.state.doc.textContent, "prefix First");
              assert.deepEqual(controller.session.getSnapshot().blocks, baseline);
              assert.isFalse(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().blocks, earlier);
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().blocks, inserted.blocks);
              await controller.save();
              assert.deepEqual(
                (
                  await h.run(
                    service.readBlocks({
                      ...h.key,
                      revision: controller.session.getSnapshot().baseRevision!,
                    }),
                  )
                ).blocks,
                inserted.blocks,
              );
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
