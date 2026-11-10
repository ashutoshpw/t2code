import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, expect } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import { readSpacePageLocation } from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { environmentId, fixture, savedParagraph, savedView } from "./spacesEditorBridge.support.ts";
import {
  rootReorderFixture,
  nestedMoveFixture,
  blockMoveFixture,
} from "./spacesServiceFixtures.support.ts";

it.effect(
  "moves a real opaque page subtree across root spaces and compensates exact placement without changing page or block IDs",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const opaque = {
            id: C.SpaceBlockId.make("opaque-descendant"),
            parentId: null,
            order: "40000000000000000000000000000000",
            type: "future_widget",
            version: 7,
            content: { vendor: [1, { value: "unchanged" }] },
            future: { marks: [{ type: "future_mark", version: 2 }] },
          };
          const payload = JSON.stringify(opaque),
            bytes = Buffer.byteLength(payload);
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            sql.prepare("INSERT INTO spaces_ids(id,kind) VALUES (?,'block')").run(opaque.id);
            sql
              .prepare(
                "INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes,deleted) VALUES (?,?,NULL,?,?,?,0)",
              )
              .run(opaque.id, h.descendant.page.id, opaque.order, payload, bytes);
            sql
              .prepare(
                "UPDATE spaces_pages SET block_count=block_count+1,block_bytes=block_bytes+? WHERE page_id=?",
              )
              .run(bytes, h.descendant.page.id);
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.browse(h.other, h.pages[0]!);
            await owner.move(h.pages[0]!, h.other, h.otherRoot);
            for (const pageId of [h.pages[0]!, h.a.page.id, h.descendant.page.id])
              assert.equal(
                (await h.ports.getPage({ environmentId, pageId })).page.spaceId,
                h.other,
              );
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
            await owner.compensate("undo");
            assert.deepEqual(await h.order(), h.pages);
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.descendant.page.id })).page.spaceId,
              h.spaceId,
            );
            await owner.compensate("redo");
            const descendant = await h.ports.getPage({
              environmentId,
              pageId: h.descendant.page.id,
            });
            assert.equal(descendant.page.spaceId, h.other);
            assert.deepEqual(
              (
                await h.run(
                  service.readBlocks({
                    environmentId,
                    pageId: descendant.page.id,
                    revision: descendant.page.revision,
                  }),
                )
              ).blocks,
              [opaque],
            );
            assert.equal(new Set(h.requests.map((r) => r.mutationId)).size, 3);
            assert.equal(h.requests[0]!.guards.roots.length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "moves child ownership between pages and known lists with the same marker and guarded inverse order",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const parent = yield* service.getPage({ environmentId, pageId: h.otherRoot });
          const list = { ...savedParagraph("placement-list", "List"), type: "bulleted_item" };
          yield* service.applyBlockBatch({
            environmentId,
            pageId: parent.page.id,
            mutationId: "seed-placement-list",
            receiptEpoch: parent.mutationAdmission.epoch,
            baseRevision: parent.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: list }],
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(parent.page.id);
            await owner.moveTo(h.a.page.id, {
              kind: "child",
              placement: { pageId: parent.page.id, parentId: list.id, beforeBlockId: null },
            });
            const moved = (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page;
            assert.deepEqual(moved.location, {
              kind: "child",
              spaceId: h.other,
              parentPageId: parent.page.id,
              ownerBlockId: h.a.ownerBlockId,
            });
            const body = await h.run(
              service.readBlocks({
                environmentId,
                pageId: parent.page.id,
                revision: (await h.ports.getPage({ environmentId, pageId: parent.page.id })).page
                  .revision,
              }),
            );
            assert.equal(body.blocks.find((b) => b.id === h.a.ownerBlockId)?.parentId, list.id);
            await owner.compensate("undo");
            assert.deepEqual(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location,
              h.a.page.location,
            );
            await owner.compensate("redo");
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "child",
            );
            assert.isTrue(h.requests.every((r) => r.destination.kind === "child"));
            assert.isTrue(h.requests.every((r) => r.guards.roots.length === 0));
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "promotes and renests a child with guarded logical undo and a fresh marker rather than resurrecting its retired ID",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            let owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.browse(h.other, h.a.page.id);
            h.network.lose = "after";
            await expect(owner.move(h.a.page.id, h.other, null)).rejects.toThrow(
              "Lost committed response",
            );
            const retained = owner.getSnapshot().journal.pending!;
            owner = h.reload();
            await owner.recover();
            assert.deepEqual(h.lookups[0], { request: retained.request });
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "root",
            );
            assert.include(owner.getSnapshot().notice!, "not retired owner-marker");
            await owner.compensate("undo");
            const restored = (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page
              .location;
            assert.equal(restored?.kind, "child");
            if (restored?.kind !== "child") throw new Error("Expected child ownership");
            assert.notEqual(restored.ownerBlockId, h.a.ownerBlockId);
            assert.equal(restored.parentPageId, h.pages[0]);
            assert.equal(restored.spaceId, h.spaceId);
            const retired = await h.run(
              service
                .applyBlockBatch({
                  environmentId,
                  pageId: h.pages[0]!,
                  mutationId: "retired-owner-resurrection",
                  receiptEpoch: (await h.ports.getPage(h.key)).mutationAdmission.epoch,
                  baseRevision: (await h.ports.getPage(h.key)).page.revision,
                  generation: 1,
                  mutations: [
                    {
                      kind: "insert",
                      block: savedParagraph(h.a.ownerBlockId, "illegal resurrection"),
                    },
                  ],
                })
                .pipe(Effect.flip),
            );
            assert.equal(retired._tag, "SpaceValidationError");
            await owner.compensate("redo");
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "root",
            );
            assert.equal(h.requests.length, 3);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "nests a root across spaces, preserves stable document ownership, and compensates parent order with exact pending identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            try {
              const owner = h.make();
              await owner.browse(h.spaceId, h.pages[0]!);
              await owner.loadBody(h.otherRoot);
              h.disk.fail = true;
              const destination = {
                kind: "child" as const,
                placement: { pageId: h.otherRoot, parentId: null, beforeBlockId: null },
              };
              await expect(owner.moveTo(h.pages[0]!, destination)).rejects.toThrow("abort");
              const pending = owner.getSnapshot().journal.pending!;
              assert.equal(pending.request.operation, "movePage");
              if (pending.request.operation !== "movePage") throw new Error("Expected page move");
              assert.deepEqual(pending.request.input.destination, destination);
              assert.equal(h.requests.length, 0);
              assert.isTrue(doc.structureBlocked());
              h.disk.fail = false;
              h.network.lose = "after";
              await expect(owner.recover()).rejects.toThrow("Lost committed response");
              await owner.recover();
              assert.deepEqual(h.requests[0], pending.request.input);
              assert.deepEqual(h.lookups[0], { request: pending.request });
              assert.equal(h.requests.length, 1);
              assert.isFalse(doc.structureBlocked());
              assert.equal(doc.session.key.pageId, h.pages[0]);
              assert.equal(doc.getSnapshot().metadata?.page.spaceId, h.other);
              assert.equal(doc.getSnapshot().metadata?.page.location?.kind, "child");
              const live = await h.run(
                readSpacePageLocation({ pageId: h.pages[0]!, version: 2 }, (pageId) =>
                  service.getPage({ environmentId, pageId }),
                ),
              );
              assert.deepEqual(
                live.ancestors.map((p) => p.id),
                [h.otherRoot],
              );
              assert.equal(live.page.spaceId, h.other);
              const peer = h.documents.open(h.key);
              assert.equal(await peer.ready, doc);
              peer.release();
              await owner.compensate("undo");
              assert.deepEqual(await h.order(), h.pages);
              await owner.compensate("redo");
              const location = (await h.ports.getPage(h.key)).page.location;
              assert.equal(location?.kind, "child");
              const first = pending.sourceLocation;
              assert.equal(first?.kind, "root");
              assert.equal(h.requests.length, 3);
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
  "blocks a hidden child-parent draft and retains a stale child-neighbor inverse conflict without moving or renewing it",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const parentKey = { environmentId, pageId: h.pages[1]! };
            const view = h.documents.open(parentKey),
              parent = await view.ready;
            parent.session.apply([
              { kind: "insert", block: savedParagraph("hidden-parent-draft", "unsaved") },
            ]);
            await parent.session.persistDraft();
            view.release();
            const owner = h.reload();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(parentKey.pageId);
            const destination = {
              kind: "child" as const,
              placement: {
                pageId: parentKey.pageId,
                parentId: null,
                beforeBlockId: h.b.ownerBlockId,
              },
            };
            await expect(owner.moveTo(h.a.page.id, destination)).rejects.toThrow("retained draft");
            assert.equal(h.requests.length, 0);
            await parent.discard();
            await owner.moveTo(h.a.page.id, destination);
            const expected = owner.getSnapshot().journal.history!.guards;
            const oldParent = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                environmentId,
                pageId: oldParent.page.id,
                mutationId: "stale-child-inverse-parent",
                receiptEpoch: oldParent.mutationAdmission.epoch,
                baseRevision: oldParent.page.revision,
                title: "Changed original parent",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.requests[1]!.guards, expected);
            const current = (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page
              .location;
            assert.equal(current?.kind === "child" ? current.parentPageId : null, parentKey.pageId);
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses partial source and destination bodies instead of inferring complete parent lists",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const metadata = yield* service.getPage(h.key);
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "partial-parent-body",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: metadata.page.revision,
            generation: 1,
            mutations: Array.from({ length: 100 }, (_, i) => ({
              kind: "insert" as const,
              block: savedParagraph(
                `partial-${i}`,
                "row",
                (BigInt(i + 1) * ((1n << 128n) / 200n)).toString(16).padStart(32, "0"),
              ),
            })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await expect(owner.loadSource(h.a.page.id)).rejects.toThrow(
              "source parent body is partial",
            );
            assert.isNull(owner.getSnapshot().position);
            await owner.loadSource(h.b.page.id);
            await owner.loadBody(h.pages[0]!);
            assert.isNotNull(owner.getSnapshot().body?.nextCursor);
            await expect(
              owner.moveTo(h.b.page.id, {
                kind: "child",
                placement: { pageId: h.pages[0]!, parentId: null, beforeBlockId: null },
              }),
            ).rejects.toThrow("complete bounded destination body");
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses cycles and excessive depth through real inspection before journaling a page move",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.loadBody(h.descendant.page.id);
            await expect(
              owner.moveTo(h.pages[0]!, {
                kind: "child",
                placement: { pageId: h.descendant.page.id, parentId: null, beforeBlockId: null },
              }),
            ).rejects.toMatchObject({ _tag: "SpaceValidationError", reason: "cycle" });
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
          let parent = h.descendant.page.id;
          for (let i = 3; i < 16; i++) parent = (yield* h.child(parent)).page.id;
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[2]!);
            await owner.loadBody(parent);
            await expect(
              owner.moveTo(h.pages[2]!, {
                kind: "child",
                placement: { pageId: parent, parentId: null, beforeBlockId: null },
              }),
            ).rejects.toThrow("maxDepth");
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses a retired child inverse anchor explicitly without renewing guards or creating an unreplayable compensating intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const parent = yield* service.getPage(h.key);
          const anchor = savedParagraph(
            "retained-inverse-anchor",
            "After child",
            "fffffffffffffffffffffffffffffffe",
          );
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "add-inverse-anchor",
            receiptEpoch: parent.mutationAdmission.epoch,
            baseRevision: parent.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: anchor }],
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(h.pages[1]!);
            await owner.moveTo(h.a.page.id, {
              kind: "child",
              placement: { pageId: h.pages[1]!, parentId: null, beforeBlockId: null },
            });
            const retained = owner.getSnapshot().journal.history;
            const current = await h.ports.getPage(h.key);
            await h.run(
              service.applyBlockBatch({
                ...h.key,
                mutationId: "retire-inverse-anchor",
                receiptEpoch: current.mutationAdmission.epoch,
                baseRevision: current.page.revision,
                generation: 2,
                mutations: [{ kind: "delete", blockId: anchor.id }],
              }),
            );
            await expect(owner.compensate("undo")).rejects.toThrow(
              "inverse placement is unavailable",
            );
            assert.deepEqual(owner.getSnapshot().journal.history, retained);
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.equal(h.requests.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses non-container and stale child destination proofs before capturing a mutation identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const target = { environmentId, pageId: h.pages[1]! };
          const parent = yield* service.getPage(target);
          const leaf = savedParagraph("not-a-list-parent", "Leaf");
          yield* service.applyBlockBatch({
            ...target,
            mutationId: "seed-leaf-destination",
            receiptEpoch: parent.mutationAdmission.epoch,
            baseRevision: parent.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: leaf }],
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(target.pageId);
            await expect(
              owner.moveTo(h.a.page.id, {
                kind: "child",
                placement: { pageId: target.pageId, parentId: leaf.id, beforeBlockId: null },
              }),
            ).rejects.toThrow("known list placement");
            const latest = await h.ports.getPage(target);
            await h.run(
              service.applyBlockBatch({
                ...target,
                mutationId: "change-destination-after-window",
                receiptEpoch: latest.mutationAdmission.epoch,
                baseRevision: latest.page.revision,
                generation: 2,
                mutations: [
                  { kind: "replace", block: savedParagraph(leaf.id, "Changed after read") },
                ],
              }),
            );
            await expect(
              owner.moveTo(h.a.page.id, {
                kind: "child",
                placement: {
                  pageId: target.pageId,
                  parentId: null,
                  beforeBlockId: h.b.ownerBlockId,
                },
              }),
            ).rejects.toThrow("placement changed");
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "moves actual PM-selected roots with nested content across pages and guards inverse/redo order and current search ownership",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          const building = yield* service
            .search({ environmentId, query: "MoveUniqueNeedle" })
            .pipe(Effect.flip);
          assert.equal(building._tag, "SpaceSearchUnavailableError");
          if (building._tag === "SpaceSearchUnavailableError")
            assert.equal(building.reason, "building");
          const initial = yield* service.search({ environmentId, query: "MoveUniqueNeedle" });
          assert.isTrue(
            initial.items.some(
              (item) => item.blockId === h.blocks[1]!.id && item.page.id === h.key.pageId,
            ),
          );

          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            const view = savedView(doc);
            try {
              const state = view.state.apply(
                view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)),
              );
              const selected = view.bridge.blockMoveSelection(state);
              assert.deepEqual(selected.blockIds, [h.blocks[0]!.id]);
              const owner = h.make(),
                proof = await owner.selectBlocks(
                  h.key.pageId,
                  selected.revision,
                  selected.blockIds,
                );
              assert.deepEqual(proof.selectedIds, [h.blocks[0]!.id, h.blocks[1]!.id]);
              await owner.loadBody(h.pages[1]!);
              await owner.moveSelectedBlocks(proof, {
                pageId: h.pages[1]!,
                parentId: null,
                beforeBlockId: null,
              });
              assert.deepEqual(h.blockRequests[0]!.blockIds, selected.blockIds);
              assert.deepEqual(
                (await h.read(h.key.pageId)).blocks.map((b) => b.id),
                [h.blocks[2]!.id, h.blocks[3]!.id],
              );
              assert.deepEqual(
                (await h.read(h.pages[1]!)).blocks.map((b) => b.id),
                [h.blocks[0]!.id, h.blocks[1]!.id],
              );
              const resolved = await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "block", blockId: h.blocks[1]!.id },
                  pageIdHint: h.key.pageId,
                }),
              );
              assert.equal(resolved.status === "resolved" ? resolved.page.id : null, h.pages[1]);
              const searched = await h.run(
                service.search({ environmentId, query: "MoveUniqueNeedle" }),
              );
              assert.isTrue(
                searched.items.some(
                  (item) => item.blockId === h.blocks[1]!.id && item.page.id === h.pages[1],
                ),
              );
              await owner.compensate("undo");
              assert.deepEqual(
                (await h.read(h.key.pageId)).blocks.map((b) => b.id),
                h.blocks.map((b) => b.id),
              );
              await owner.compensate("redo");
              assert.equal(new Set(h.blockRequests.map((r) => r.mutationId)).size, 3);
              assert.isTrue(
                h.blockRequests.every(
                  (r) => r.blockIds.length === 1 && r.blockIds[0] === h.blocks[0]!.id,
                ),
              );
              assert.equal(h.requests.length, 0);
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
  "preserves contiguous selected-root order for same-page moves and executes indent/outdent through guarded block service requests",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            let source = await h.read(h.key.pageId);
            const roots = [h.blocks[2]!.id, h.blocks[3]!.id];
            let from = 0,
              to = 0;
            view.state.doc.descendants((node, pos) => {
              if (node.attrs.block?.id === roots[0]) from = pos + 1;
              if (node.attrs.block?.id === roots[1]) to = pos + node.nodeSize - 1;
            });
            const selected = view.bridge.blockMoveSelection(
              view.state.apply(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
              ),
            );
            assert.deepEqual(selected.blockIds, roots);
            view.stop();
            opened.release();
            let proof = await owner.selectBlocks(h.key.pageId, source.revision, roots);
            assert.deepEqual(proof.indent, {
              pageId: h.key.pageId,
              parentId: h.blocks[0]!.id,
              beforeBlockId: null,
            });
            await owner.moveSelectedBlocks(proof, proof.indent!);
            let current = await h.read(h.key.pageId);
            assert.isTrue(
              current.blocks
                .filter((b) => roots.includes(b.id))
                .every((b) => b.parentId === h.blocks[0]!.id),
            );
            proof = await owner.selectBlocks(h.key.pageId, current.revision, roots);
            assert.isNotNull(proof.outdent);
            await owner.moveSelectedBlocks(proof, proof.outdent!);
            current = await h.read(h.key.pageId);
            assert.deepEqual(
              current.blocks.map((b) => b.id),
              h.blocks.map((b) => b.id),
            );
            await owner.compensate("undo");
            assert.isTrue(
              (await h.read(h.key.pageId)).blocks
                .filter((b) => roots.includes(b.id))
                .every((b) => b.parentId === h.blocks[0]!.id),
            );
            await owner.compensate("redo");
            source = await h.read(h.key.pageId);
            proof = await owner.selectBlocks(h.key.pageId, source.revision, roots);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: h.blocks[0]!.id,
            });
            assert.deepEqual(
              (await h.read(h.key.pageId)).blocks.map((b) => b.id),
              [h.blocks[2]!.id, h.blocks[3]!.id, h.blocks[0]!.id, h.blocks[1]!.id],
            );
            assert.isTrue(
              h.blockRequests.every((r) => JSON.stringify(r.blockIds) === JSON.stringify(roots)),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "persists block-move intent before sending and recovers an exact committed receipt after reload without renewing identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            let owner = h.make();
            const source = await h.read(h.key.pageId);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[2]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            h.disk.fail = true;
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.pages[1]!,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.blockRequests.length, 0);
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            h.disk.fail = false;
            h.network.lose = "after";
            await expect(owner.recover()).rejects.toThrow("Lost committed response");
            assert.deepEqual(h.blockRequests[0], pending.request.input);
            h.setWritable(false);
            owner = h.reload();
            await owner.recover();
            assert.deepEqual(h.lookups[0], { request: pending.request });
            assert.equal(h.blockRequests.length, 1);
            assert.isNull(owner.getSnapshot().journal.pending);
            h.setWritable(true);
            await owner.compensate("undo");
            assert.deepEqual(
              (await h.read(h.key.pageId)).blocks.map((b) => b.id),
              h.blocks.map((b) => b.id),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses missing block feature, dirty PM source, partial windows and subtree cycles without mutation",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId);
            h.setBlockFeature(false);
            await expect(
              owner.selectBlocks(h.key.pageId, source.revision, [h.blocks[0]!.id]),
            ).rejects.toThrow("does not advertise");
            assert.isNull(owner.getSnapshot().blockSelection);
            h.setBlockFeature(true);
            const separate = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[0]!.id,
              h.blocks[3]!.id,
            ]);
            assert.isNull(separate.inverse);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[0]!.id,
            ]);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.key.pageId,
                parentId: h.blocks[0]!.id,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("selected subtree");
            h.setWritable(false);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.key.pageId,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("Operate revoked");
            h.setWritable(true);
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            try {
              doc.session.apply([
                { kind: "replace", block: savedParagraph(h.blocks[2]!.id, "unsaved") },
              ]);
              await doc.session.persistDraft();
              assert.throws(
                () => view.bridge.blockMoveSelection(view.state),
                "clean, current and complete",
              );
              await owner.loadBody(h.pages[1]!);
              await expect(
                owner.moveSelectedBlocks(proof, {
                  pageId: h.pages[1]!,
                  parentId: null,
                  beforeBlockId: null,
                }),
              ).rejects.toThrow("affected document");
              const reload = h.reload();
              const restoredProof = await reload.selectBlocks(h.key.pageId, source.revision, [
                h.blocks[0]!.id,
              ]);
              await reload.loadBody(h.pages[1]!);
              await expect(
                reload.moveSelectedBlocks(restoredProof, {
                  pageId: h.pages[1]!,
                  parentId: null,
                  beforeBlockId: null,
                }),
              ).rejects.toThrow("retained draft");
            } finally {
              view.stop();
              opened.release();
            }
            assert.equal(h.blockRequests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
          const current = yield* service.getPage(h.key);
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "partial-block-window",
            receiptEpoch: current.mutationAdmission.epoch,
            baseRevision: current.page.revision,
            generation: 3,
            mutations: Array.from({ length: 97 }, (_, i) => ({
              kind: "insert" as const,
              block: savedParagraph(
                `partial-move-${i}`,
                "row",
                (BigInt(i + 1) * 1000n).toString(16).padStart(32, "0"),
              ),
            })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            const page = await h.ports.getPage(h.key);
            await expect(
              owner.selectBlocks(h.key.pageId, page.page.revision, [h.blocks[0]!.id]),
            ).rejects.toThrow("complete source window");
            assert.equal(h.blockRequests.length, 0);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "moves an opaque/media/owned-page subtree without changing payloads, marker IDs or current asset pins",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const source = yield* service.getPage(h.key);
          const list = {
            ...savedParagraph(
              "opaque-move-list",
              "Opaque container",
              "10000000000000000000000000000000",
            ),
            type: "bulleted_item",
          };
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "seed-opaque-move-list",
            receiptEpoch: source.mutationAdmission.epoch,
            baseRevision: source.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: list }],
          });
          const opaque: C.SpaceBlock = {
            id: C.SpaceBlockId.make("moving-future"),
            parentId: list.id,
            order: "90000000000000000000000000000000",
            type: "future_widget",
            version: 9,
            content: { nested: [{ exact: true }] },
            future: ["opaque", 23],
          };
          const media: C.SpaceBlock = {
            id: C.SpaceBlockId.make("moving-existing-image"),
            parentId: list.id,
            order: "a0000000000000000000000000000000",
            type: "image",
            version: 1,
            content: {
              assetId: "existing-asset",
              caption: [{ text: "existing caption", marks: [] }],
            },
          };
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            const row = sql
              .prepare("SELECT payload,logical_bytes FROM spaces_blocks WHERE block_id=?")
              .get(h.a.ownerBlockId)!;
            const owner = { ...JSON.parse(String(row.payload)), parentId: list.id };
            const payload = JSON.stringify(owner),
              bytes = Buffer.byteLength(payload);
            sql
              .prepare(
                "UPDATE spaces_blocks SET parent_id=?,payload=?,logical_bytes=? WHERE block_id=?",
              )
              .run(list.id, payload, bytes, h.a.ownerBlockId);
            sql
              .prepare("UPDATE spaces_pages SET block_bytes=block_bytes+? WHERE page_id=?")
              .run(bytes - Number(row.logical_bytes), h.key.pageId);
            for (const block of [opaque, media]) {
              const json = JSON.stringify(block),
                size = Buffer.byteLength(json);
              sql.prepare("INSERT INTO spaces_ids(id,kind) VALUES (?,'block')").run(block.id);
              sql
                .prepare(
                  "INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes,deleted) VALUES (?,?,?,?,?,?,0)",
                )
                .run(block.id, h.key.pageId, block.parentId, block.order, json, size);
              sql
                .prepare(
                  "UPDATE spaces_pages SET block_count=block_count+1,block_bytes=block_bytes+? WHERE page_id=?",
                )
                .run(size, h.key.pageId);
            }
            sql
              .prepare("INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (?,?)")
              .run(media.id, "existing-asset");
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            try {
              for (const id of [opaque.id, media.id]) {
                let position = -1;
                view.state.doc.descendants((node, pos) => {
                  if (node.attrs.block?.id === id) position = pos;
                });
                const atom = view.state.apply(
                  view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)),
                );
                assert.deepEqual(view.bridge.blockMoveSelection(atom).blockIds, [id]);
              }
              const state = view.state.apply(
                view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)),
              );
              const selected = view.bridge.blockMoveSelection(state);
              assert.deepEqual(selected.blockIds, [list.id]);
              const owner = h.make(),
                proof = await owner.selectBlocks(
                  h.key.pageId,
                  selected.revision,
                  selected.blockIds,
                );
              assert.isTrue(
                proof.selectedIds.includes(opaque.id) &&
                  proof.selectedIds.includes(media.id) &&
                  proof.selectedIds.includes(h.a.ownerBlockId),
              );
              await owner.loadBody(h.otherRoot);
              await owner.moveSelectedBlocks(proof, {
                pageId: h.otherRoot,
                parentId: null,
                beforeBlockId: null,
              });
              const parent = await h.ports.getPage({ environmentId, pageId: h.otherRoot });
              const body = await h.run(
                service.readBlocks({
                  environmentId,
                  pageId: h.otherRoot,
                  revision: parent.page.revision,
                }),
              );
              assert.deepEqual(
                body.blocks.find((b) => b.id === opaque.id),
                opaque,
              );
              assert.deepEqual(
                body.blocks.find((b) => b.id === media.id),
                media,
              );
              const child = await h.ports.getPage({ environmentId, pageId: h.a.page.id });
              assert.deepEqual(child.page.location, {
                kind: "child",
                spaceId: h.other,
                parentPageId: h.otherRoot,
                ownerBlockId: h.a.ownerBlockId,
              });
              assert.equal(
                (await h.ports.getPage({ environmentId, pageId: h.descendant.page.id })).page
                  .spaceId,
                h.other,
              );
              const pins = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.deepEqual(
                  pins
                    .prepare("SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=?")
                    .all(media.id)
                    .map((r) => r.asset_id),
                  ["existing-asset"],
                );
              } finally {
                pins.close();
              }
              await owner.compensate("undo");
              const restored = await h.ports.getPage({ environmentId, pageId: h.a.page.id });
              assert.deepEqual(restored.page.location, h.a.page.location);
              let position = -1;
              view.state.doc.descendants((node, pos) => {
                if (node.attrs.block?.id === media.id) position = pos;
              });
              const atom = view.state.apply(
                view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)),
              );
              const selectedAtom = view.bridge.blockMoveSelection(atom);
              const mediaProof = await owner.selectBlocks(
                h.key.pageId,
                selectedAtom.revision,
                selectedAtom.blockIds,
              );
              await owner.loadBody(h.otherRoot);
              await owner.moveSelectedBlocks(mediaProof, {
                pageId: h.otherRoot,
                parentId: null,
                beforeBlockId: null,
              });
              const dest = await h.ports.getPage({ environmentId, pageId: h.otherRoot });
              const movedMedia = (
                await h.run(
                  service.readBlocks({
                    environmentId,
                    pageId: h.otherRoot,
                    revision: dest.page.revision,
                  }),
                )
              ).blocks[0]!;
              assert.equal(movedMedia.id, media.id);
              assert.deepEqual(movedMedia.content, media.content);
              await owner.compensate("undo");
              assert.equal(h.blockRequests.length, 4);
            } finally {
              view.stop();
              opened.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps attempted block inverse on a revision conflict and refuses obsolete sibling anchors without guard renewal",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[2]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            const frozen = owner.getSnapshot().journal.history!.guards;
            const parent = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                ...h.key,
                mutationId: "concurrent-block-inverse-parent",
                receiptEpoch: parent.mutationAdmission.epoch,
                baseRevision: parent.page.revision,
                title: "Newer parent",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.blockRequests[1]!.guards, frozen);
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
            await owner.reinspect();
            const current = await h.read(h.pages[1]!);
            const back = await owner.selectBlocks(h.pages[1]!, current.revision, [h.blocks[2]!.id]);
            await owner.loadBody(h.key.pageId);
            await owner.moveSelectedBlocks(back, {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: h.blocks[3]!.id,
            });
            const restored = await h.read(h.key.pageId);
            const forward = await owner.selectBlocks(h.key.pageId, restored.revision, [
              h.blocks[2]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(forward, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            const history = owner.getSnapshot().journal.history;
            const target = await h.ports.getPage(h.key);
            await h.run(
              service.applyBlockBatch({
                ...h.key,
                mutationId: "retire-block-inverse-anchor",
                receiptEpoch: target.mutationAdmission.epoch,
                baseRevision: target.page.revision,
                generation: 3,
                mutations: [{ kind: "delete", blockId: h.blocks[3]!.id }],
              }),
            );
            await expect(owner.compensate("undo")).rejects.toThrow(
              "inverse placement is unavailable",
            );
            assert.deepEqual(owner.getSnapshot().journal.history, history);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses a complete selection whose actual inspection work exceeds the server node bound without chunking or persisting intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const source = yield* service.getPage(h.key);
          const blocks = Array.from({ length: 100 }, (_, i) =>
            savedParagraph(
              `node-budget-${i}`,
              "row",
              (BigInt(i + 1) * 10000n).toString(16).padStart(32, "0"),
            ),
          );
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "seed-node-budget",
            receiptEpoch: source.mutationAdmission.epoch,
            baseRevision: source.page.revision,
            generation: 1,
            mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make(),
              page = await h.ports.getPage(h.key);
            const proof = await owner.selectBlocks(
              h.key.pageId,
              page.page.revision,
              blocks.slice(0, 99).map((b) => b.id),
            );
            await owner.loadBody(h.pages[1]!);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.pages[1]!,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("maxMutationNodes");
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.equal(h.blockRequests.length, 0);
            assert.equal((await h.ports.getPage(h.key)).page.revision, page.page.revision);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses block list depth17 whole but permits a revision-guarded move at16 and its inverse",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          const page = yield* service.getPage(h.key);
          const chain = Array.from({ length: 16 }, (_, i) => ({
            ...savedParagraph(
              `block-depth-${i}`,
              "List",
              (BigInt(i + 1) * 1000n).toString(16).padStart(32, "0"),
            ),
            type: "bulleted_item",
            parentId: i === 0 ? null : C.SpaceBlockId.make(`block-depth-${i - 1}`),
          }));
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "seed-block-depth",
            receiptEpoch: page.mutationAdmission.epoch,
            baseRevision: page.page.revision,
            generation: 2,
            mutations: chain.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[2]!.id,
            ]);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.key.pageId,
                parentId: chain[15]!.id,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("maxDepth");
            assert.equal(h.blockRequests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.key.pageId,
              parentId: chain[14]!.id,
              beforeBlockId: null,
            });
            assert.equal(
              (await h.read(h.key.pageId)).blocks.find((b) => b.id === h.blocks[2]!.id)?.parentId,
              chain[14]!.id,
            );
            await owner.compensate("undo");
            assert.isNull(
              (await h.read(h.key.pageId)).blocks.find((b) => b.id === h.blocks[2]!.id)?.parentId,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "moves complete roots from separate original placements in source order while honestly refusing an unsupported inverse",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId),
              roots = [h.blocks[0]!.id, h.blocks[3]!.id];
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, roots);
            assert.isNull(proof.inverse);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            assert.deepEqual(h.blockRequests[0]!.blockIds, roots);
            assert.deepEqual(
              (await h.read(h.pages[1]!)).blocks.map((b) => b.id),
              [h.blocks[0]!.id, h.blocks[1]!.id, h.blocks[3]!.id],
            );
            assert.isNull(owner.getSnapshot().journal.history);
            assert.include(owner.getSnapshot().notice!, "Undo is unavailable");
            await expect(owner.compensate("undo")).rejects.toThrow("No guarded placement");
            assert.equal(h.blockRequests.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
