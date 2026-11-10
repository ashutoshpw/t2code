import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, expect } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { environmentId, fixture, savedParagraph, savedView } from "./spacesEditorBridge.support.ts";
import { rootReorderFixture } from "./spacesServiceFixtures.support.ts";

it.effect(
  "reorders real roots and saves guarded inverse/redo with new identities and stable page IDs",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
            await owner.compensate("undo");
            assert.deepEqual(await h.order(), h.pages);
            assert.equal(owner.getSnapshot().journal.history?.direction, "redo");
            await owner.compensate("redo");
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
            assert.equal(new Set(h.requests.map((r) => r.mutationId)).size, 3);
            assert.equal(h.counts().admissions, 3);
            assert.equal(h.counts().refreshed, 3);
            assert.isTrue(
              h.requests.every(
                (r) => r.destination.kind === "root" && r.destination.spaceId === h.spaceId,
              ),
            );
            assert.isTrue(
              (await h.run(service.listPages({ environmentId, spaceId: h.spaceId }))).items.every(
                (p) => /^[0-9a-f]{32}$/.test(p.rootOrder!),
              ),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains a stale inverse conflict without renewing guards and requires explicit new-position intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            const expected = owner.getSnapshot().journal.history!.guards;
            const peer = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
            await h.run(
              service.updatePage({
                environmentId,
                pageId: peer.page.id,
                mutationId: "concurrent-title",
                receiptEpoch: peer.mutationAdmission.epoch,
                baseRevision: peer.page.revision,
                title: "Newer title",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.requests[1]!.guards, expected);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
            await expect(owner.compensate("undo")).rejects.toThrow("retained placement");
            await owner.reinspect();
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.isNull(owner.getSnapshot().journal.history);
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, h.pages[1]!);
            assert.deepEqual(await h.order(), h.pages);
            assert.notEqual(h.requests[1]!.mutationId, h.requests[2]!.mutationId);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "journals before sending and interlocks two real controllers through aborted persistence and exact unsent retry",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const first = h.documents.open(h.key),
              second = h.documents.open(h.key);
            const doc = await first.ready;
            assert.equal(await second.ready, doc);
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.disk.hold = true;
            h.disk.fail = true;
            const moving = owner.move(h.pages[0]!, h.spaceId, null);
            await h.disk.started.promise;
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.requests.length, 0);
            assert.isTrue(doc.structureBlocked());
            assert.throws(
              () =>
                doc.session.apply([{ kind: "insert", block: savedParagraph("blocked", "unsent") }]),
              "reserved",
            );
            await expect(doc.save()).rejects.toThrow("reserved");
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            first.release();
            h.disk.release.resolve();
            await expect(moving).rejects.toThrow("abort");
            assert.equal(h.requests.length, 0);
            assert.deepEqual(owner.getSnapshot().journal.pending, pending);
            h.disk.hold = false;
            h.disk.fail = false;
            await owner.recover();
            assert.deepEqual(h.requests[0], pending.request.input);
            assert.equal(h.lookups.length, 0);
            assert.isFalse(doc.structureBlocked());
            assert.equal(
              doc.session.getSnapshot().baseRevision,
              (await h.ports.getPage(h.key)).page.revision,
            );
            assert.equal(h.counts().refreshed, 1);
            second.release();
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "recovers a lost committed response after reload using exact receipt in read-only mode without another write",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "after";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow(
              "Lost committed",
            );
            const pending = h.stored()!.pending!;
            const revision = (await h.ports.getPage(h.key)).page.revision;
            const restored = h.reload();
            h.setWritable(false);
            await restored.hydrate();
            await restored.recover();
            assert.deepEqual(h.lookups[0], { request: pending.request });
            assert.equal(h.requests.length, 1);
            assert.equal(h.counts().admissions, 1);
            assert.isNull(h.stored()!.pending);
            assert.equal((await h.ports.getPage(h.key)).page.revision, revision);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "replays an absent receipt only with operate permission and the original guards, ID and epoch",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "before";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow("Lost before");
            const original = h.stored()!.pending!.request.input;
            const restored = h.reload();
            h.setWritable(false);
            await expect(restored.recover()).rejects.toThrow("Operate revoked");
            assert.equal(h.requests.length, 1);
            h.setWritable(true);
            h.setMaxBytes(1);
            await restored.recover();
            assert.deepEqual(h.requests, [original, original]);
            assert.equal(h.counts().admissions, 1);
            assert.equal(h.lookups.length, 2);
            assert.isNull(restored.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses hidden durable dirty drafts and resident dirty state without publishing a pending structural intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const hidden = h.documents.open({ environmentId, pageId: h.pages[1]! });
            const doc = await hidden.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("hidden-dirty", "retained") },
            ]);
            await doc.session.persistDraft();
            hidden.release();
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await expect(owner.move(h.pages[0]!, h.spaceId, h.pages[1]!)).rejects.toThrow(
              "affected document",
            );
            const restored = h.reload();
            await restored.browse(h.spaceId, h.pages[0]!);
            await expect(restored.move(h.pages[0]!, h.spaceId, h.pages[1]!)).rejects.toThrow(
              "retained draft",
            );
            assert.equal(h.requests.length, 0);
            assert.isNull(restored.getSnapshot().journal.pending);
            assert.isNotNull(h.draftRecords.get(h.pages[1]!)?.mutations.length);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "does not infer a successor at a partial window and learns it only through explicit next pagination",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            h.setRows(1);
            await owner.browse(h.spaceId, h.pages[0]!);
            assert.isNull(owner.getSnapshot().position);
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow(
              "proven destination",
            );
            await owner.browse(h.spaceId, h.pages[0]!, true);
            assert.equal(owner.getSnapshot().position?.beforePageId, h.pages[1]);
            assert.equal(owner.getSnapshot().window!.items.length, 1);
            await owner.move(h.pages[0]!, h.spaceId, h.pages[1]!);
            assert.deepEqual(await h.order(), h.pages);
            assert.isNull(owner.getSnapshot().journal.history);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps an expired absent root receipt unresolved rather than capturing a new epoch or identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "before";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow("Lost before");
            const original = h.stored()!.pending!;
            await h.run(TestClock.adjust(86_400_001));
            const restored = h.reload();
            await restored.recover();
            assert.include(restored.getSnapshot().notice!, "unknown");
            assert.deepEqual(h.stored()!.pending, original);
            assert.equal(h.requests.length, 1);
            assert.equal(h.counts().admissions, 1);
            await expect(restored.reinspect()).rejects.toThrow("definite conflict");
            assert.deepEqual(await h.order(), h.pages);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps saved content compensation on its old revision after clean structural refresh",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const opened = h.documents.open(h.key);
            const doc = await opened.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("initial-content", "initial") },
            ]);
            await doc.save();
            doc.session.apply([
              { kind: "replace", block: savedParagraph("initial-content", "saved edit") },
            ]);
            await doc.save();
            assert.isNull(doc.session.compensationAvailability("undo"));
            const history = doc.session.getSnapshot().history.undo;
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.deepEqual(doc.session.getSnapshot().history.undo, history);
            assert.isNotNull(doc.session.compensationAvailability("undo"));
            opened.release();
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refuses a changed inverse context after a definite commit rather than admitting refreshed compensation guards",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.after = async () => {
              const peer = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
              await h.run(
                service.updatePage({
                  environmentId,
                  pageId: peer.page.id,
                  mutationId: "late-inverse-peer",
                  receiptEpoch: peer.mutationAdmission.epoch,
                  baseRevision: peer.page.revision,
                  title: "Newer inverse anchor",
                }),
              );
            };
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.isNull(owner.getSnapshot().journal.history);
            assert.include(owner.getSnapshot().notice!, "inverse placement changed");
            await expect(owner.compensate("undo")).rejects.toThrow("No guarded placement");
            assert.equal(h.requests.length, 1);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "admits an eight-page observed root closure and refuses nine before durable intent or network mutation",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const placement = { pageId: h.pages[0]!, parentId: null, beforeBlockId: null };
          const addChild = (index: number) =>
            Effect.gen(function* () {
              const inspected = yield* service.inspectStructure({
                environmentId,
                target: { kind: "blocks", pageId: placement.pageId, blockIds: [] },
                destination: { kind: "child", placement },
              });
              const page = yield* service.getPage(h.key);
              const child = yield* service.createChildPage({
                environmentId,
                mutationId: C.SpaceMutationId.make(`budget-child-${index}`),
                receiptEpoch: page.mutationAdmission.epoch,
                title: "Child",
                placement,
                guards: inspected.guards,
              });
              if (child.status !== "saved") throw new Error("Unexpected child fixture conflict");
            });
          for (let i = 0; i < 5; i++) yield* addChild(i);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.equal(owner.getSnapshot().journal.history?.observed.pages.length, 8);
            await owner.compensate("undo");
            assert.deepEqual(await h.order(), h.pages);
          });
          yield* addChild(5);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            const writes = h.requests.length;
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow("eight-page");
            assert.equal(h.requests.length, writes);
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.deepEqual(await h.order(), h.pages);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("does not replace the saved inverse on a definite no-op root placement", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        yield* Effect.promise(async () => {
          const owner = h.make();
          await owner.browse(h.spaceId, h.pages[0]!);
          await owner.move(h.pages[0]!, h.spaceId, null);
          const history = owner.getSnapshot().journal.history;
          await owner.browse(h.spaceId, h.pages[0]!);
          await owner.move(h.pages[0]!, h.spaceId, null);
          assert.deepEqual(owner.getSnapshot().journal.history, history);
          assert.include(owner.getSnapshot().notice!, "already");
          await owner.compensate("undo");
          assert.deepEqual(await h.order(), h.pages);
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains the attempted original move when a real remote root/anchor change occurs during journal persistence",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.disk.hold = true;
            const moving = owner.move(h.pages[0]!, h.spaceId, h.pages[2]!);
            await h.disk.started.promise;
            const original = owner.getSnapshot().journal.pending!;
            const peer = h.pages[2]!;
            const destination = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: peer },
                destination,
              }),
            );
            const admission = await h.ports.getPage({ environmentId, pageId: peer });
            await h.run(
              service.movePage({
                environmentId,
                pageId: peer,
                destination,
                guards: inspected.guards,
                mutationId: "remote-anchor-move",
                receiptEpoch: admission.mutationAdmission.epoch,
              }),
            );
            h.disk.release.resolve();
            await moving;
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.requests[0], original.request.input);
            assert.deepEqual(await h.order(), [h.pages[0], h.pages[1], h.pages[3], h.pages[2]]);
            assert.isNull(owner.getSnapshot().journal.history);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "blocks actual PM commands in two views and retains their shared editor when root metadata refreshes",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const controller = await route.ready;
            assert.equal(await panel.ready, controller);
            const a = savedView(controller),
              b = savedView(controller);
            try {
              const owner = h.make();
              await owner.browse(h.spaceId, h.pages[0]!);
              h.disk.hold = true;
              const moving = owner.move(h.pages[0]!, h.spaceId, null);
              await h.disk.started.promise;
              const beforeA = a.state.doc.toJSON(),
                beforeB = b.state.doc.toJSON();
              assert.isFalse(a.bridge.adapter.append()(a.state, a.dispatch));
              assert.isFalse(b.bridge.adapter.append()(b.state, b.dispatch));
              assert.deepEqual(a.state.doc.toJSON(), beforeA);
              assert.deepEqual(b.state.doc.toJSON(), beforeB);
              h.disk.release.resolve();
              await moving;
              assert.isTrue(a.bridge.adapter.append()(a.state, a.dispatch));
              assert.deepEqual(a.state.doc.toJSON(), b.state.doc.toJSON());
              assert.isTrue(controller.session.getSnapshot().dirty);
              const third = h.documents.open(h.key);
              assert.equal(await third.ready, controller);
              third.release();
              assert.isTrue(controller.session.getSnapshot().dirty);
            } finally {
              a.stop();
              b.stop();
              route.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "refreshes every changed resident after real root rebalance when the first refresh fails before reservation release",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          // Seed adjacent valid ranks so the actual service must rebalance multiple roots.
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            for (const [index, value] of [16, 32, 33, 64].entries())
              sql
                .prepare("UPDATE spaces_pages SET root_order = ? WHERE page_id = ?")
                .run(value.toString(16).padStart(32, "0"), h.pages[index]!);
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const views = h.pages.map((pageId) => h.documents.open({ environmentId, pageId }));
            const documents = await Promise.all(views.map((view) => view.ready));
            const bridges = documents.map((doc) => savedView(doc));
            try {
              const owner = h.make();
              await owner.browse(h.spaceId, h.pages[0]!);
              h.documentReads.attempted.length = 0;
              h.documentReads.failNext = true;
              await expect(owner.move(h.pages[0]!, h.spaceId, h.pages[2]!)).rejects.toThrow();
              const receipt = await h.ports.lookupMutationReceipt({
                request: { operation: "movePage", input: h.requests[0]! },
              });
              if (
                receipt.status !== "found" ||
                receipt.receipt.operation !== "movePage" ||
                receipt.receipt.result.status !== "saved"
              )
                throw new Error("Expected actual rebalance receipt");
              const changed = receipt.receipt.result.changed.pages;
              assert.isAtLeast(changed.length, 2);
              assert.deepEqual(
                h.documentReads.attempted,
                changed.map((row) => row.pageId),
              );
              const failedId = changed[0]!.pageId;
              for (const row of changed) {
                const index = h.pages.indexOf(row.pageId),
                  doc = documents[index]!;
                assert.isFalse(doc.structureBlocked());
                if (row.pageId === failedId) {
                  assert.isNotNull(doc.getSnapshot().error);
                  assert.isFalse(bridges[index]!.bridge.canEdit());
                } else {
                  assert.isNull(doc.getSnapshot().error);
                  assert.equal(doc.session.getSnapshot().baseRevision, row.revision);
                  assert.isTrue(bridges[index]!.bridge.canEdit());
                }
              }
              assert.isNull(owner.getSnapshot().journal.pending);
              assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
              assert.equal(h.requests.length, 1);
              const failed = documents[h.pages.indexOf(failedId)]!;
              await failed.refresh();
              assert.isNull(failed.getSnapshot().error);
              assert.equal(failed.session.getSnapshot().baseRevision, changed[0]!.revision);
            } finally {
              bridges.forEach((view) => view.stop());
              views.forEach((view) => view.release());
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "reacquires an affected page after exact uncertain-placement recovery without remounting its failed owner",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "after";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow(
              "Lost committed response",
            );
            const pending = owner.getSnapshot().journal.pending!;
            const target = { environmentId, pageId: h.pages[1]! };
            const blocked = h.documents.open(target);
            await expect(blocked.ready).rejects.toThrow("reserved");
            await owner.recover();
            assert.deepEqual(h.lookups[0], { request: pending.request });
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.equal(h.requests.length, 1);
            const retried = h.documents.open(target),
              doc = await retried.ready;
            blocked.release();
            const panel = h.documents.open(target);
            try {
              assert.equal(await panel.ready, doc);
              assert.isNull(doc.getSnapshot().error);
              assert.equal(
                doc.session.getSnapshot().baseRevision,
                (await h.ports.getPage(target)).page.revision,
              );
            } finally {
              retried.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
