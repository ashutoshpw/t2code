import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, expect } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import { decodeSpaceStructureJournal } from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { environmentId, fixture, savedParagraph, savedView } from "./spacesEditorBridge.support.ts";
import {
  rootReorderFixture,
  nestedMoveFixture,
  blockMoveFixture,
} from "./spacesServiceFixtures.support.ts";

it.effect("announces a structural change only after the affected pages are released", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        const reservedAtChange: boolean[] = [];
        const owner = h.make(() => {
          try {
            h.documents.reserve(environmentId, [h.pages[0]!])();
            reservedAtChange.push(false);
          } catch {
            reservedAtChange.push(true);
          }
        });
        yield* Effect.promise(async () => {
          await owner.loadBody(h.pages[0]!);
          const created = await owner.createChild("New child", {
            pageId: h.pages[0]!,
            parentId: null,
            beforeBlockId: null,
          });
          assert.deepEqual(reservedAtChange, [false]);
          const children = await h.run(
            service.listPages({
              environmentId,
              spaceId: h.spaceId,
              parentPageId: h.pages[0]!,
            }),
          );
          assert.deepEqual(
            children.items.map((page) => page.id),
            [created],
          );
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("creates a child once across a lost reply and reload through the durable journal", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        const owner = h.make();
        yield* Effect.promise(async () => {
          await owner.loadBody(h.pages[0]!);
          h.network.lose = "after";
          await expect(
            owner.createChild("New child", {
              pageId: h.pages[0]!,
              parentId: null,
              beforeBlockId: null,
            }),
          ).rejects.toThrow(/Lost committed/);
          const pending = owner.getSnapshot().journal.pending!;
          assert.equal(pending.request.operation, "createChildPage");
          const recovered = h.reload();
          h.setWritable(false);
          await recovered.recover();
          assert.equal(recovered.getSnapshot().journal.pending, null);
          assert.equal(h.childRequests.length, 1);
          assert.deepEqual(h.lookups[0]!.request, pending.request);
          const children = await h.run(
            service.listPages({ environmentId, spaceId: h.spaceId, parentPageId: h.pages[0]! }),
          );
          assert.equal(children.items.length, 1);
          const child = children.items[0]!;
          assert.equal(child.title, "New child");
          assert.equal(child.location?.kind, "child");
          const body = await h.run(
            service.readBlocks({
              environmentId,
              pageId: h.pages[0]!,
              revision: (await h.run(service.getPage({ environmentId, pageId: h.pages[0]! }))).page
                .revision,
            }),
          );
          assert.equal(body.blocks.filter((b) => b.type === "child_page").length, 1);
          assert.include(recovered.getSnapshot().notice!, "guarded recovery");
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "previews and recovers the exact trash/restore closure without reading trashed bodies",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const owner = h.make();
          yield* Effect.promise(async () => {
            await owner.loadBody(h.pages[0]!);
            await owner.createChild("Nested", {
              pageId: h.pages[0]!,
              parentId: null,
              beforeBlockId: null,
            });
            const child = (
              await h.run(
                service.listPages({ environmentId, spaceId: h.spaceId, parentPageId: h.pages[0]! }),
              )
            ).items[0]!;
            await owner.previewRecovery(h.pages[0]!, "trash");
            assert.deepEqual(
              new Set(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds),
              new Set([h.pages[0], child.id]),
            );
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.browseTrash();
            assert.deepEqual(
              owner.getSnapshot().trash!.items.map((p) => p.pageId),
              [h.pages[0]],
            );
            await owner.previewRecovery(h.pages[0]!, "restore");
            h.network.lose = "after";
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!),
            ).rejects.toThrow(/Lost committed/);
            const pending = owner.getSnapshot().journal.pending!;
            const recovered = h.reload();
            h.setWritable(false);
            h.setBlockFeature(false);
            await recovered.recover();
            assert.equal(recovered.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 2);
            assert.equal(
              (await h.run(service.getPage({ environmentId, pageId: child.id }))).page.trash,
              undefined,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("persists child intent before send and preserves exact identity on an unsent retry", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* blockMoveFixture(service);
        yield* Effect.promise(async () => {
          const route = h.documents.open(h.key),
            panel = h.documents.open(h.key);
          const doc = await route.ready;
          assert.equal(await panel.ready, doc);
          const owner = h.make();
          try {
            await owner.loadBody(h.key.pageId);
            await expect(
              owner.createChild("x".repeat(h.capability.limits.maxTitleBytes), {
                pageId: h.key.pageId,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow();
            assert.equal(h.childRequests.length, 0);
            assert.equal(owner.getSnapshot().journal.pending, null);
            h.disk.fail = true;
            await expect(
              owner.createChild("In list", {
                pageId: h.key.pageId,
                parentId: h.blocks[0]!.id,
                beforeBlockId: h.blocks[1]!.id,
              }),
            ).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.childRequests.length, 0);
            assert.isTrue(doc.structureBlocked());
            assert.throws(
              () =>
                doc.session.apply([
                  { kind: "insert", block: savedParagraph("blocked-create", "not applied") },
                ]),
              "reserved",
            );
            assert.throws(() =>
              decodeSpaceStructureJournal(
                {
                  ...owner.getSnapshot().journal,
                  pending: { ...pending, knownBlockIds: undefined },
                },
                environmentId,
              ),
            );
            h.disk.fail = false;
            await owner.recover();
            assert.deepEqual(h.childRequests[0], pending.request.input);
            assert.isFalse(doc.structureBlocked());
            assert.equal(
              doc.session.getSnapshot().baseRevision,
              (await h.ports.getPage(h.key)).page.revision,
            );
            const body = await h.read(h.key.pageId);
            const marker = body.blocks.find((b) => b.type === "child_page")!;
            assert.equal(marker.parentId, h.blocks[0]!.id);
            const siblings = body.blocks.filter((b) => b.parentId === h.blocks[0]!.id);
            assert.equal(siblings[0]!.id, marker.id);
            assert.equal(siblings[1]!.id, h.blocks[1]!.id);
            assert.deepEqual(
              body.blocks.filter((b) => b.type !== "child_page"),
              h.blocks,
            );
          } finally {
            route.release();
            panel.release();
          }
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains a frozen recovery conflict and refuses hidden drafts, read-only writes and missing recovery support",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            const preview = owner.getSnapshot().recoveryPreview!;
            const hidden = h.documents.open({ environmentId, pageId: h.a.page.id });
            const doc = await hidden.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("hidden-before-trash", "retained") },
            ]);
            await doc.session.persistDraft();
            hidden.release();
            await expect(owner.confirmRecovery(preview)).rejects.toThrow(/Resolve|draft/);
            assert.equal(h.recoveryRequests.length, 0);
            await doc.discard();
            h.setWritable(false);
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("Operate revoked");
            h.setWritable(true);
            h.setBlockFeature(false);
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("unsupported");
            h.setBlockFeature(true);
            const current = await h.ports.getPage({ environmentId, pageId: h.descendant.page.id });
            await h.run(
              service.updatePage({
                environmentId,
                pageId: current.page.id,
                mutationId: "concurrent-recovery-title",
                receiptEpoch: current.mutationAdmission.epoch,
                baseRevision: current.page.revision,
                title: "Concurrent title",
              }),
            );
            await owner.confirmRecovery(preview);
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            if (pending.request.operation !== "trashPage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(pending.request.input.guards, preview.inspection.guards);
            assert.equal(h.recoveryRequests.length, 1);
            assert.equal((await h.ports.getPage(h.key)).page.trash, undefined);
            await expect(owner.recover()).rejects.toThrow("No uncertain");
            await owner.reinspect();
            assert.equal(owner.getSnapshot().journal.pending, null);
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("Inspect");
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps trash receipts exact through storage failure, reload and read-only recovery, gating both resident consumers",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            await owner.previewRecovery(h.key.pageId, "trash");
            h.disk.fail = true;
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!),
            ).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.recoveryRequests.length, 0);
            assert.isTrue(doc.structureBlocked());
            h.disk.fail = false;
            h.network.lose = "after";
            await expect(owner.recover()).rejects.toThrow("Lost committed response");
            h.setWritable(false);
            // The definite receipt is persisted before every resident refresh is attempted; a trashed page has nothing to refresh.
            await owner.recover();
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 1);
            assert.isNotNull(doc.getSnapshot().error);
            assert.isFalse(doc.structureBlocked());
            h.setWritable(true);
            await owner.previewRecovery(h.key.pageId, "restore");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            assert.equal((await h.ports.getPage(h.key)).page.trash, undefined);
            route.release();
            panel.release();
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "previews fallback restore while retaining independent batches and current moved-out ownership",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.descendant.page.id, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "trash");
            assert.deepEqual(
              new Set(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds),
              new Set([h.pages[0], h.a.page.id]),
            );
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const placement = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.a.page.id },
                destination: placement,
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.movePage({
                environmentId,
                pageId: h.a.page.id,
                destination: placement,
                guards: inspected.guards,
                mutationId: "detach-hidden-child",
                receiptEpoch: admission.mutationAdmission.epoch,
              }),
            );
            await owner.previewRecovery(h.pages[0]!, "restore");
            assert.deepEqual(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds, [
              h.pages[0]!,
            ]);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.browseTrash();
            const moved = owner.getSnapshot().trash!.items.find((p) => p.pageId === h.a.page.id)!;
            assert.equal(moved.trash.originalRootPageId, h.pages[0]);
            await owner.previewRecovery(h.a.page.id, "restore");
            assert.deepEqual(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds, [
              h.a.page.id,
            ]);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "root",
            );
            await owner.previewRecovery(h.pages[1]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.b.page.id, "restore");
            assert.match(
              owner.getSnapshot().recoveryPreview!.placement,
              /original surviving space root/,
            );
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const restored = await h.ports.getPage({ environmentId, pageId: h.b.page.id });
            assert.equal(restored.page.location?.kind, "root");
            assert.equal(restored.page.id, h.b.page.id);
            const ref = await h.run(
              service.resolveReference({
                environmentId,
                target: { kind: "block", blockId: h.b.ownerBlockId },
              }),
            );
            assert.equal(ref.status, "deleted");
            await owner.browseTrash();
            assert.isTrue(
              owner.getSnapshot().trash!.items.some((p) => p.pageId === h.descendant.page.id),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps empty continuing trash windows pageable and never reads their content bodies",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            h.setRows(1);
            await owner.browseTrash();
            const windows = [owner.getSnapshot().trash!];
            await owner.browseTrash(true);
            windows.push(owner.getSnapshot().trash!);
            await owner.browseTrash(true);
            windows.push(owner.getSnapshot().trash!);
            assert.isTrue(windows.some((w) => w.items.length === 0 && w.nextCursor !== null));
            assert.equal(windows[2]!.nextCursor, null);
            assert.deepEqual(
              windows.flatMap((w) => w.items.map((p) => p.pageId)),
              [h.pages[0]],
            );
            assert.deepEqual(h.documentReads.attempted, []);
            assert.deepEqual(h.structureBodyReads, []);
            await expect(owner.browseTrash(true)).rejects.toThrow("No next");
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses a partial creation parent and over-eight-page recovery closure before journaling or sending",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          for (const _ of [1, 2, 3, 4, 5]) yield* h.child(h.pages[0]!);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            assert.equal(owner.getSnapshot().recoveryPreview!.inspection.guards.pages.length, 8);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "restore");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await h.run(h.child(h.pages[0]!));
            await expect(owner.previewRecovery(h.pages[0]!, "trash")).rejects.toThrow("eight-page");
            assert.equal(h.recoveryRequests.length, 2);
            assert.equal(owner.getSnapshot().journal.pending, null);
            const current = await h.ports.getPage({ environmentId, pageId: h.pages[2]! });
            await h.run(
              service.applyBlockBatch({
                environmentId,
                pageId: current.page.id,
                baseRevision: current.page.revision,
                generation: 1,
                mutationId: "creation-window-100",
                receiptEpoch: current.mutationAdmission.epoch,
                mutations: Array.from({ length: 100 }, (_, i) => ({
                  kind: "insert" as const,
                  block: savedParagraph(
                    `creation-${i}`,
                    "text",
                    BigInt(i + 1)
                      .toString(16)
                      .padStart(32, "0"),
                  ),
                })),
              }),
            );
            const more = await h.ports.getPage({ environmentId, pageId: h.pages[2]! });
            await h.run(
              service.applyBlockBatch({
                environmentId,
                pageId: more.page.id,
                baseRevision: more.page.revision,
                generation: 2,
                mutationId: "creation-window-101",
                receiptEpoch: more.mutationAdmission.epoch,
                mutations: [
                  {
                    kind: "insert",
                    block: savedParagraph(
                      "creation-100",
                      "text",
                      "80000000000000000000000000000000",
                    ),
                  },
                ],
              }),
            );
            await owner.loadBody(more.page.id);
            assert.isNotNull(owner.getSnapshot().body!.nextCursor);
            await expect(
              owner.createChild("Refused", {
                pageId: more.page.id,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("complete parent");
            assert.equal(h.childRequests.length, 0);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["id", "epoch", "new-page-revision", "existing-owner", "missing-parent"] as const)(
  "retains a real committed child intent when its wire acknowledgement has corrupt %s, then recovers the original receipt",
  (kind) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            h.network.rewriteChildReply = (reply) => {
              if (reply.status !== "saved") throw new Error("Expected a real child commit");
              switch (kind) {
                case "id":
                  return { ...reply, mutationId: C.SpaceMutationId.make("wrong-id") };
                case "epoch":
                  return { ...reply, receiptEpoch: C.SpaceReceiptEpoch.make("wrong-epoch") };
                case "new-page-revision":
                  return { ...reply, page: { ...reply.page, revision: 1 } };
                case "existing-owner":
                  return {
                    ...reply,
                    ownerBlockId: h.blocks[0]!.id,
                    page: {
                      ...reply.page,
                      location: {
                        kind: "child",
                        spaceId: h.spaceId,
                        parentPageId: h.key.pageId,
                        ownerBlockId: h.blocks[0]!.id,
                      },
                    },
                  };
                case "missing-parent":
                  return {
                    ...reply,
                    changed: {
                      ...reply.changed,
                      pages: reply.changed.pages.filter((p) => p.pageId !== h.key.pageId),
                    },
                  };
              }
            };
            await expect(
              owner.createChild("Verified child", {
                pageId: h.key.pageId,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow(/Mismatched/);
            const pending = owner.getSnapshot().journal.pending!;
            assert.isNotNull(pending);
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            await owner.recover();
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups[0]!.request, pending.request);
            assert.equal(h.childRequests.length, 1);
            const children = await h.run(
              service.listPages({ environmentId, spaceId: h.spaceId, parentPageId: h.key.pageId }),
            );
            assert.equal(children.items.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains the exact attempted child creation on a real parent-revision conflict without generating another child",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            h.disk.hold = true;
            const creating = owner.createChild("Conflicted child", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            await h.disk.started.promise;
            const pending = owner.getSnapshot().journal.pending!;
            const current = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                ...h.key,
                mutationId: "child-race",
                receiptEpoch: current.mutationAdmission.epoch,
                baseRevision: current.page.revision,
                title: "Peer title",
              }),
            );
            h.disk.release.resolve();
            await creating;
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(owner.getSnapshot().journal.pending!.request, pending.request);
            assert.equal(h.childRequests.length, 1);
            assert.equal(
              (
                await h.run(
                  service.listPages({
                    environmentId,
                    spaceId: h.spaceId,
                    parentPageId: h.key.pageId,
                  }),
                )
              ).items.length,
              0,
            );
            await owner.reinspect();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Explicit new intent", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            assert.notEqual(h.childRequests[1]!.mutationId, h.childRequests[0]!.mutationId);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "compensates an acknowledged child creation with guarded trash and restore redo preserving its allocated marker",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Undo created child", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            const child = (
              await h.run(
                service.listPages({
                  environmentId,
                  spaceId: h.spaceId,
                  parentPageId: h.key.pageId,
                }),
              )
            ).items[0]!;
            await owner.compensate("undo");
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: child.id },
                }),
              ),
              { status: "trashed", pageId: child.id },
            );
            await owner.compensate("redo");
            const restored = (await h.ports.getPage({ environmentId, pageId: child.id })).page;
            assert.deepEqual(restored.location, child.location);
            assert.equal(h.childRequests.length, 1);
            assert.deepEqual(
              h.recoveryRequests.map((r) => r.operation),
              ["trashPage", "restorePage"],
            );
            assert.equal(new Set(h.recoveryRequests.map((r) => r.input.mutationId)).size, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "requires explicit bounded purge confirmation and retires the inspected current trash root",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            const preview = owner.getSnapshot().recoveryPreview!;
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("confirmation");
            const root = await h.ports.getPage({ environmentId, pageId: h.pages[2]! });
            await h.run(
              service.createPage({
                environmentId,
                spaceId: h.spaceId,
                title: "Concurrent root",
                mutationId: "purge-root-race",
                receiptEpoch: root.mutationAdmission.epoch,
                baseRootOrderRevision: root.space.rootOrderRevision,
              }),
            );
            await owner.confirmRecovery(preview, true);
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.equal(owner.getSnapshot().journal.pending!.rejection, undefined);
            const retainedPurge = owner.getSnapshot().journal.pending!.request;
            if (retainedPurge.operation !== "permanentlyDeletePage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(retainedPurge.input.guards, preview.inspection.guards);
            await owner.reinspect();
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true);
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.pages[0]! },
                }),
              ),
              { status: "deleted" },
            );
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.descendant.page.id },
                }),
              ),
              { status: "deleted" },
            );
            assert.equal(owner.getSnapshot().journal.history, null);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "undoes and redoes only the selected recovery batch while independently trashed descendants remain hidden",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.descendant.page.id, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "trash");
            const independent = owner
              .getSnapshot()
              .recoveryPreview!.inspection.pages.find((p) => p.id === h.descendant.page.id)!.trash!;
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.compensate("undo");
            assert.equal((await h.ports.getPage(h.key)).page.trash, undefined);
            const hidden = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.descendant.page.id },
                recovery: "restore",
              }),
            );
            assert.deepEqual(
              hidden.pages.find((p) => p.id === h.descendant.page.id)!.trash,
              independent,
            );
            await owner.compensate("redo");
            const root = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.pages[0]! },
                recovery: "restore",
              }),
            );
            assert.deepEqual(new Set(root.recovery!.pageIds), new Set([h.pages[0]!, h.a.page.id]));
            assert.deepEqual(
              root.pages.find((p) => p.id === h.descendant.page.id)!.trash,
              independent,
            );
            await owner.compensate("undo");
            assert.deepEqual(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location,
              h.a.page.location,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses moved-out recovery closure and fallback-restore inverse without resurrecting owner markers",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const history = owner.getSnapshot().journal.history;
            const destination = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspect = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.a.page.id },
                destination,
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.movePage({
                environmentId,
                pageId: h.a.page.id,
                mutationId: "move-out-before-undo",
                receiptEpoch: admission.mutationAdmission.epoch,
                destination,
                guards: inspect.guards,
              }),
            );
            await expect(owner.compensate("undo")).rejects.toThrow(/closure|unavailable/);
            assert.deepEqual(owner.getSnapshot().journal.history, history);
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.equal(h.recoveryRequests.length, 1);
            await owner.previewRecovery(h.pages[1]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.b.page.id, "restore");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.b.page.id })).page.location?.kind,
              "root",
            );
            assert.equal(owner.getSnapshot().journal.history, null);
            assert.include(owner.getSnapshot().notice!, "changed placement");
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "block", blockId: h.b.ownerBlockId },
                }),
              ),
              { status: "deleted" },
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps a conflicting recovery undo draft with frozen guards instead of renewing them",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.a.page.id, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const history = owner.getSnapshot().journal.history!;
            const parent = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                ...h.key,
                mutationId: "parent-after-trash",
                receiptEpoch: parent.mutationAdmission.epoch,
                baseRevision: parent.page.revision,
                title: "Do not overwrite",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            const retainedRestore = owner.getSnapshot().journal.pending!.request;
            if (retainedRestore.operation !== "restorePage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(retainedRestore.input.guards, history.guards);
            assert.deepEqual(owner.getSnapshot().journal.history, history);
            assert.equal(owner.getSnapshot().journal.pending!.direction, "undo");
            assert.equal((await h.ports.getPage(h.key)).page.title, "Do not overwrite");
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses create undo history if the allocated child changes before its acknowledgement is processed",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            h.network.after = async () => {
              const child = (
                await h.run(
                  service.listPages({
                    environmentId,
                    spaceId: h.spaceId,
                    parentPageId: h.key.pageId,
                  }),
                )
              ).items[0]!;
              const admission = await h.ports.getPage({ environmentId, pageId: child.id });
              await h.run(
                service.applyBlockBatch({
                  environmentId,
                  pageId: child.id,
                  mutationId: "newer-created-child",
                  receiptEpoch: admission.mutationAdmission.epoch,
                  baseRevision: child.revision,
                  generation: 1,
                  mutations: [
                    {
                      kind: "insert",
                      block: savedParagraph("newer-child-body", "Keep newer child"),
                    },
                  ],
                }),
              );
            };
            await owner.createChild("Already changed", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            assert.equal(owner.getSnapshot().journal.history, null);
            assert.include(owner.getSnapshot().notice!, "inverse guards");
            await expect(owner.compensate("undo")).rejects.toThrow("No guarded");
            assert.equal(h.recoveryRequests.length, 0);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "recovers a lost purge reply after reload with the original request and no restoration or Undo",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            h.network.lose = "after";
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true),
            ).rejects.toThrow("Lost committed response");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(pending.request.operation, "permanentlyDeletePage");
            const recovered = h.reload();
            h.setWritable(false);
            h.setBlockFeature(false);
            await recovered.recover();
            assert.equal(recovered.getSnapshot().journal.pending, null);
            assert.equal(recovered.getSnapshot().journal.history, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 2);
            for (const id of [h.pages[0]!, h.a.page.id, h.descendant.page.id])
              assert.deepEqual(
                await h.run(
                  service.resolveReference({ environmentId, target: { kind: "page", pageId: id } }),
                ),
                { status: "deleted" },
              );
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "block", blockId: h.a.ownerBlockId },
                }),
              ),
              { status: "deleted" },
            );
            await expect(recovered.compensate("undo")).rejects.toThrow();
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "never deletes a changed purge selection and refuses non-root trash before creating an intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            let owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await expect(owner.previewRecovery(h.a.page.id, "permanentlyDelete")).rejects.toThrow();
            assert.equal(owner.getSnapshot().journal.pending, null);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            const preview = owner.getSnapshot().recoveryPreview!;
            const destination = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.a.page.id },
                destination,
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.movePage({
                environmentId,
                pageId: h.a.page.id,
                mutationId: "move-after-purge-preview",
                receiptEpoch: admission.mutationAdmission.epoch,
                destination,
                guards: inspected.guards,
              }),
            );
            await owner.confirmRecovery(preview, true);
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.equal(owner.getSnapshot().journal.pending!.rejection, "invalid_input");
            assert.deepEqual(
              owner.getSnapshot().journal.pending!.recoveryPageIds,
              preview.inspection.recovery!.pageIds,
            );
            const retainedRejectedPurge = owner.getSnapshot().journal.pending!.request;
            if (retainedRejectedPurge.operation !== "permanentlyDeletePage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(retainedRejectedPurge.input.guards, preview.inspection.guards);
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.pages[0]! },
                }),
              ),
              { status: "trashed", pageId: h.pages[0]! },
            );
            const rejected = owner.getSnapshot().journal.pending!;
            owner = h.reload();
            await owner.hydrate();
            assert.deepEqual(owner.getSnapshot().journal.pending, rejected);
            await owner.reinspect();
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("Inspect");
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            assert.deepEqual(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds, [
              h.pages[0]!,
            ]);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true);
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.a.page.id },
                }),
              ),
              { status: "trashed", pageId: h.a.page.id },
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "persists purge before sending, interlocks two actual editors and gates the purged resident even when changed.pages is empty",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            const view = savedView(doc);
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.key.pageId },
                recovery: "trash",
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.trashPage({
                ...h.key,
                mutationId: "external-trash-before-purge",
                receiptEpoch: admission.mutationAdmission.epoch,
                guards: inspected.guards,
              }),
            );
            const owner = h.make();
            try {
              await owner.previewRecovery(h.key.pageId, "permanentlyDelete");
              h.disk.fail = true;
              await expect(
                owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true),
              ).rejects.toThrow("abort");
              const pending = owner.getSnapshot().journal.pending!;
              assert.equal(h.recoveryRequests.length, 0);
              assert.isTrue(doc.structureBlocked());
              assert.isFalse(view.bridge.adapter.append()(view.state, view.dispatch));
              h.disk.fail = false;
              h.network.lose = "after";
              await expect(owner.recover()).rejects.toThrow("Lost committed response");
              h.setWritable(false);
              await expect(owner.recover()).rejects.toThrow("could not refresh");
              assert.equal(owner.getSnapshot().journal.pending, null);
              assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
              assert.equal(h.recoveryRequests.length, 1);
              assert.isFalse(doc.structureBlocked());
              assert.isNotNull(doc.getSnapshot().error);
              assert.isFalse(view.bridge.adapter.append()(view.state, view.dispatch));
              assert.isFalse(doc.session.getSnapshot().dirty);
            } finally {
              view.stop();
              route.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses hidden durable drafts and live permission or feature withdrawal before permanent deletion",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const held = h.documents.open({ environmentId, pageId: h.a.page.id });
            const doc = await held.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("keep-hidden-purge-draft", "unsaved") },
            ]);
            await doc.session.persistDraft();
            held.release();
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.pages[0]! },
                recovery: "trash",
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.trashPage({
                environmentId,
                pageId: h.pages[0]!,
                mutationId: "external-hidden-trash",
                receiptEpoch: admission.mutationAdmission.epoch,
                guards: inspected.guards,
              }),
            );
            const owner = h.reload();
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            const preview = owner.getSnapshot().recoveryPreview!;
            h.setWritable(false);
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("Operate revoked");
            h.setWritable(true);
            h.setBlockFeature(false);
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("unsupported");
            h.setBlockFeature(true);
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("retained draft");
            assert.equal(h.recoveryRequests.length, 0);
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.isTrue(h.draftRecords.has(h.a.page.id));
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each([5, 6])(
  "purges the complete eight-page boundary and refuses a ninth page without chunking (%s extra children)",
  (extra) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          for (const _ of Array.from({ length: extra })) yield* h.child(h.pages[0]!);
          const inspection = yield* service.inspectStructure({
            environmentId,
            target: { kind: "page", pageId: h.pages[0]! },
            recovery: "trash",
          });
          const admission = yield* service.listSpaces({ environmentId, limit: 1 });
          yield* service.trashPage({
            environmentId,
            pageId: h.pages[0]!,
            mutationId: "external-large-trash",
            receiptEpoch: admission.mutationAdmission.epoch,
            guards: inspection.guards,
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            if (extra === 6) {
              await expect(owner.previewRecovery(h.pages[0]!, "permanentlyDelete")).rejects.toThrow(
                "eight-page",
              );
              assert.equal(owner.getSnapshot().journal.pending, null);
              assert.equal(h.recoveryRequests.length, 0);
            } else {
              await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
              assert.equal(
                owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds.length,
                8,
              );
              await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true);
              assert.equal(h.recoveryRequests.length, 1);
              assert.equal(owner.getSnapshot().journal.history, null);
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "preserves the recovery compensation prefix through codec write failure and exact lost-reply reload",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Recover undo", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            const created = (
              await h.run(
                service.listPages({
                  environmentId,
                  spaceId: h.spaceId,
                  parentPageId: h.key.pageId,
                }),
              )
            ).items[0]!;
            h.disk.fail = true;
            await expect(owner.compensate("undo")).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.recoveryRequests.length, 0);
            assert.equal(pending.direction, "undo");
            h.disk.fail = false;
            h.network.lose = "after";
            await expect(owner.recover()).rejects.toThrow("Lost committed response");
            const recovered = h.reload();
            h.setWritable(false);
            await recovered.recover();
            assert.equal(h.recoveryRequests.length, 1);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(recovered.getSnapshot().journal.history?.direction, "redo");
            h.setWritable(true);
            await recovered.compensate("redo");
            assert.deepEqual(
              (await h.ports.getPage({ environmentId, pageId: created.id })).page.location,
              created.location,
            );
            assert.equal(h.recoveryRequests.length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains a purge intent on a truncated deleted-ID acknowledgement and recovers only the authoritative receipt",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            h.network.rewritePurgeReply = (result) =>
              result.status === "saved"
                ? { ...result, deletedPageIds: result.deletedPageIds.slice(0, 1) }
                : result;
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true),
            ).rejects.toThrow("Mismatched permanent");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(pending.conflict, false);
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            await owner.recover();
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.equal(owner.getSnapshot().journal.history, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 2);
            assert.deepEqual(h.structureBodyReads, []);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "creates the first root page in an empty actual default space and recovers its lost reply without allocating twice",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.createSpace("New library");
            const created = owner.getSnapshot().libraryResult!.space!;
            const previous = (await h.ports.getPage(h.key)).space;
            await owner.setDefaultSpace(created, previous);
            const empty = await h.run(service.listPages({ environmentId, spaceId: created.id }));
            assert.equal(empty.items.length, 0);
            assert.isTrue(empty.space.isDefault);
            h.network.lose = "after";
            await expect(owner.createRootPage(empty.space, "First page")).rejects.toThrow(
              "Lost committed response",
            );
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(pending.request.operation, "createPage");
            const restored = h.reload();
            h.setWritable(false);
            await restored.recover();
            assert.equal(restored.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.libraryRequests.filter((r) => r.operation === "createPage").length, 1);
            const pages = await h.run(service.listPages({ environmentId, spaceId: created.id }));
            assert.equal(pages.items.length, 1);
            assert.equal(pages.items[0]!.title, "First page");
            assert.equal(restored.getSnapshot().libraryResult!.page!.id, pages.items[0]!.id);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
