import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import {
  SpaceReferenceController,
  createSpaceServiceSessionAdapter,
} from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Layer from "effect/Layer";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { SpaceDocumentController } from "../src/spaces/documentController.ts";
import { SpaceMentionController } from "../src/spaces/mentions.ts";
import { spaceDocumentBlocks } from "../src/spaces/document.ts";
import {
  environmentId,
  fixture,
  boot,
  queryRuntime,
  signal,
  savedParagraph,
  savedView,
} from "./spacesEditorBridge.support.ts";
import { sourceFixture } from "./spacesServiceFixtures.support.ts";

it.effect(
  "opens current moved and merged search identities through the real resolver instead of stale page hints",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          const metadata = yield* service.getPage(h.key);
          const blocks = [
            savedParagraph("source-a", "SourceNeedle first", "20000000000000000000000000000000"),
            savedParagraph("source-b", "SourceNeedle second", "40000000000000000000000000000000"),
            savedParagraph("source-c", "SourceNeedle last", "80000000000000000000000000000000"),
          ];
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "source-seed",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: metadata.page.revision,
            generation: 1,
            mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("SourceNeedle")).status, "building");
            const window = await h.sources.search("SourceNeedle");
            if (window.status !== "ready") throw Error(window.status);
            const index = window.result.items.findIndex((hit) => hit.blockId === blocks[1]!.id),
              target = window.target(index)!;
            assert.equal(window.result.items[index]!.page.id, h.key.pageId);
            const owner = h.make(),
              page = await h.ports.getPage(h.key);
            const proof = await owner.selectBlocks(h.key.pageId, page.page.revision, [
              blocks[0]!.id,
              blocks[1]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            const moved = await h.sources.resolve(target);
            assert.deepEqual(moved?.current(), {
              environmentId,
              spaceId: h.spaceId,
              pageId: h.pages[1]!,
              blockId: blocks[1]!.id,
            });
            const opened = h.documents.open({ environmentId, pageId: h.pages[1]! }),
              doc = await opened.ready,
              view = savedView(doc);
            const referenceOpen = h.documents.open({ environmentId, pageId: h.pages[3]! }),
              referenceDoc = await referenceOpen.ready,
              referenceView = savedView(referenceDoc);
            const reference: import("../src/spaces/mentions.ts").SpaceMentionMark = {
              type: "block_mention",
              version: 1,
              target: { ...h.key, blockId: blocks[1]!.id },
            };
            const mentions = new SpaceMentionController(h.sources, environmentId);
            try {
              assert.isTrue(
                referenceView.bridge.adapter.append()(referenceView.state, referenceView.dispatch),
              );
              assert.isTrue(
                referenceView.bridge
                  .mentionInsertion(() => referenceView.state, referenceView.dispatch)
                  .insert(reference, "Original fallback"),
              );
              await referenceDoc.save();
              const canonical = referenceDoc.session.getSnapshot();
              assert.equal((await mentions.activate(reference))?.pageId, h.pages[1]!);
              assert.strictEqual(referenceDoc.session.getSnapshot(), canonical);
              let pos = -1;
              view.state.doc.descendants((node, p) => {
                if (node.attrs.block?.id === blocks[1]!.id) pos = p + 1;
              });
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
              assert.isTrue(view.bridge.adapter.joinBackward()(view.state, view.dispatch));
              await doc.save();
              const merged = await h.sources.resolve(target);
              assert.equal(merged?.status, "merged");
              assert.deepEqual(merged?.current(), {
                environmentId,
                spaceId: h.spaceId,
                pageId: h.pages[1]!,
                blockId: blocks[0]!.id,
              });
              assert.equal((await mentions.activate(reference))?.blockId, blocks[0]!.id);
              assert.strictEqual(referenceDoc.session.getSnapshot(), canonical);
              const now = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
              await owner.renamePage(now.page, "Current renamed destination");
              const renamed = await h.sources.resolve(target);
              assert.equal(renamed?.page.title, "Current renamed destination");
              assert.deepEqual(renamed?.current(), {
                environmentId,
                spaceId: h.spaceId,
                pageId: h.pages[1]!,
                blockId: blocks[0]!.id,
              });
              assert.equal((await mentions.activate(reference))?.blockId, blocks[0]!.id);
              assert.deepEqual(mentions.presentation(reference), {
                status: "resolved",
                title: "Current renamed destination",
              });
              assert.strictEqual(referenceDoc.session.getSnapshot(), canonical);
              assert.isTrue(view.bridge.adapter.remove(blocks[0]!.id)(view.state, view.dispatch));
              await doc.save();
              assert.isNull(await mentions.activate(reference));
              assert.deepEqual(mentions.presentation(reference), { status: "unavailable" });
              assert.strictEqual(referenceDoc.session.getSnapshot(), canonical);
              assert.equal(referenceView.state.doc.textContent, "Original fallback");
              assert.isNull(moved?.current());
              h.control.access = { ...h.control.access, canRead: false };
              assert.isNull(renamed?.current());
              const reads = h.resolves.length;
              assert.isNull(await h.sources.resolve(target));
              assert.equal(h.resolves.length, reads);
            } finally {
              referenceView.stop();
              referenceOpen.release();
              view.stop();
              opened.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "cancels obsolete queued search work and stale connection replies against actual encoded service reads",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("Second")).status, "building");
            const gate = { ...signal(), reply: signal() };
            h.control.searchGate = gate;
            const old = h.sources.search("Second");
            await gate.promise;
            const skipped = h.sources.search("Third"),
              latest = h.sources.search("Fourth");
            gate.reply.resolve();
            assert.equal((await old).status, "unavailable");
            assert.equal((await skipped).status, "unavailable");
            const result = await latest;
            if (result.status !== "ready") throw Error(result.status);
            assert.equal(result.result.items[0]!.page.title, "Fourth");
            assert.deepEqual(
              h.searches.map((input) => input.query),
              ["Second", "Second", "Fourth"],
            );
            const sourceTarget = result.target(0)!;
            const resolving = { ...signal(), reply: signal() };
            h.control.resolveGate = resolving;
            const pending = h.sources.resolve(sourceTarget);
            await resolving.promise;
            h.control.access = { ...h.control.access, session: {} };
            resolving.reply.resolve();
            assert.isNull(await pending);
            assert.isFalse(result.current());
            assert.isNull(result.target(0));
            assert.equal((await result.next()).status, "unavailable");
            const calls = h.searches.length;
            assert.equal((await h.sources.search("Second")).status, "unsupported");
            assert.equal(h.searches.length, calls);
            const fresh = h.makeSources();
            const again = await fresh.search("Second");
            assert.equal(again.status, "ready");
            const held = { ...signal(), reply: signal() };
            h.control.searchGate = held;
            const withdrawn = fresh.search("Fourth");
            await held.promise;
            h.control.access = {
              ...h.control.access,
              capability: { version: 2, limits: h.capability.limits },
            };
            held.reply.resolve();
            assert.equal((await withdrawn).status, "unavailable");
            const reads = h.resolves.length;
            assert.isNull(await fresh.resolve(sourceTarget));
            assert.equal(h.resolves.length, reads);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["search", "resolve"] as const)(
  "settles superseded %s reads before held transport replies with one active and one latest pending request",
  (method) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          const deferredSignal = Effect.gen(function* () {
            const done = yield* Deferred.make<void>();
            const observed = signal();
            yield* Deferred.await(done).pipe(
              Effect.tap(() => Effect.sync(observed.resolve)),
              Effect.forkScoped,
            );
            return {
              promise: observed.promise,
              resolve: () => {
                Deferred.doneUnsafe(done, Effect.void);
              },
            };
          });
          const firstGate = { ...(yield* deferredSignal), reply: yield* deferredSignal };
          const latestGate =
            method === "resolve"
              ? { ...(yield* deferredSignal), reply: yield* deferredSignal }
              : null;
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("Second")).status, "building");
            {
              const owner = h.makeSources();
              const gate = firstGate;
              const calls = () => (method === "search" ? h.searches.length : h.resolves.length);
              const start = calls();
              const request = () =>
                method === "search"
                  ? owner.search("Second").then((result) => result.status)
                  : owner.resolve({ kind: "page", pageId: h.pages[1]! });
              if (method === "search") h.control.searchGate = gate;
              else h.control.resolveGate = gate;
              const active = request();
              await gate.promise;
              let settled = 0;
              const replaced = Array.from({ length: 10000 }, () =>
                request().then((result) => {
                  settled++;
                  assert.equal(result, method === "search" ? "unavailable" : null);
                }),
              );
              try {
                // An independent authoritative read completes while the original reply remains held.
                await h.ports.getPage(h.key);
                assert.equal(
                  settled,
                  9999,
                  `${method}: superseded callers settle before transport`,
                );
                assert.equal(calls(), start + 1);
                owner.invalidate();
                await Promise.all(replaced);
                assert.equal(settled, 10000);
                let canceled = false;
                const pending = request().then((result) => {
                  canceled = true;
                  assert.equal(result, method === "search" ? "unavailable" : null);
                });
                owner.dispose();
                await pending;
                assert.isTrue(canceled);
                assert.isFalse(owner.current());
                const after = await request();
                assert.equal(after, method === "search" ? "unsupported" : null);
                assert.equal(calls(), start + 1);
              } finally {
                owner.invalidate();
                gate.reply.resolve();
                await active;
                await Promise.all(replaced);
              }
              await h.ports.getPage(h.key);
              assert.equal(calls(), start + 1, `${method}: no late revival or queued transport`);
            }
            if (!latestGate) return;
            const owner = h.makeSources();
            const gate = latestGate;
            h.control.resolveGate = gate;
            const active = owner.resolve({ kind: "page", pageId: h.pages[1]! });
            await gate.promise;
            const obsolete = owner.resolve({ kind: "page", pageId: h.pages[2]! });
            const latest = owner.resolve({ kind: "page", pageId: h.pages[3]! });
            await h.ports.getPage(h.key);
            assert.isNull(await obsolete);
            gate.reply.resolve();
            assert.isNull(await active);
            assert.equal((await latest)?.current()?.pageId, h.pages[3]!);
            assert.deepEqual(
              h.resolves.slice(-2).map((input) => input.target),
              [
                { kind: "page", pageId: h.pages[1]! },
                { kind: "page", pageId: h.pages[3]! },
              ],
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retires source ownership on actual local catalog changes without replacing a shared dirty document",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            h.control.access = {
              ...h.control.access,
              capability: {
                ...h.capability,
                limits: {
                  ...h.capability.limits,
                  search: {
                    ...h.capability.limits.search!,
                    maxRows: 1,
                  },
                },
              },
            };
            for (const [index, pageId] of h.pages.entries()) {
              const page = await h.ports.getPage({ environmentId, pageId });
              await h.make().renamePage(page.page, `Source ${index}`);
            }
            assert.equal((await h.sources.search("Source")).status, "building");
            const window = await h.sources.search("Source");
            if (window.status !== "ready") throw Error(window.status);
            assert.isNotNull(window.result.nextCursor);
            const beforeCatalog = window.result.catalogRevision;
            const target = { kind: "page" as const, pageId: h.pages[1]! };
            const resolved = await h.sources.resolve(target);
            assert.isNotNull(resolved?.current());
            const acquired = h.documents.open(h.key);
            const doc = await acquired.ready;
            const view = savedView(doc);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.dispatch(view.state.tr.insertText("unsaved local content"));
              const draft = doc.session.getSnapshot();
              const searchGate = { ...signal(), reply: signal() };
              const resolveGate = { ...signal(), reply: signal() };
              const inFlight = h.makeSources();
              h.control.searchGate = searchGate;
              h.control.resolveGate = resolveGate;
              const oldSearch = inFlight.search("Source"),
                oldResolve = inFlight.resolve(target);
              await Promise.all([searchGate.promise, resolveGate.promise]);
              try {
                const page = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
                await h.make(h.changed).renamePage(page.page, "Source renamed current");
                assert.isFalse(window.current());
                assert.isNull(window.target(0));
                assert.isNull(resolved?.current());
                const calls = h.searches.length;
                assert.equal((await window.next()).status, "unavailable");
                assert.equal(h.searches.length, calls);
              } finally {
                searchGate.reply.resolve();
                resolveGate.reply.resolve();
              }
              assert.equal((await oldSearch).status, "unavailable");
              assert.isNull(await oldResolve);
              const fresh = h.makeSources();
              const current = await fresh.search("Renamed");
              if (current.status !== "ready") throw Error(current.status);
              assert.equal(current.result.items[0]!.page.title, "Source renamed current");
              assert.isAtLeast(current.result.catalogRevision, beforeCatalog);
              const peer = h.documents.open(h.key);
              try {
                assert.strictEqual(await peer.ready, doc);
                assert.strictEqual(doc.session.getSnapshot(), draft);
                assert.isTrue(draft.dirty);
              } finally {
                peer.release();
              }
            } finally {
              view.stop();
              acquired.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps user selection after a saved edit and actual rename replace the source owner for an unchanged linked target",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          const metadata = yield* service.getPage(h.key);
          const a = savedParagraph("navigation-a", "First", "20000000000000000000000000000000"),
            b = savedParagraph("navigation-b", "Second", "80000000000000000000000000000000");
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "navigation-seed",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: 0,
            generation: 1,
            mutations: [a, b].map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const acquired = h.documents.open(h.key),
              doc = await acquired.ready,
              view = savedView(doc);
            const mounted = {},
              target = { ...h.key, blockId: a.id };
            const reveal = (source: SpaceReferenceController) => {
              const result = view.bridge.revealNavigation(
                mounted,
                view.state,
                target,
                source,
                () => true,
              );
              if (result?.transaction) view.dispatch(result.transaction);
              return result;
            };
            try {
              assert.equal(reveal(h.sources)?.status, "loaded");
              assert.equal((view.state.selection as NodeSelection).node.attrs.block.id, a.id);
              let position = -1;
              view.state.doc.descendants((node, pos) => {
                if (node.attrs.block?.id === b.id) position = pos + 1;
              });
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, position)),
              );
              view.edit("local-");
              const dirty = doc.session.getSnapshot(),
                caret = view.state.selection.toJSON();
              const afterEdit = reveal(h.sources);
              assert.deepEqual(view.state.selection.toJSON(), caret);
              assert.isUndefined(afterEdit?.transaction);
              assert.strictEqual(doc.session.getSnapshot(), dirty);
              await doc.save();
              const current = await h.ports.getPage(h.key);
              await h
                .make(h.changed)
                .renamePage(current.page, "Renamed while editing the linked page");
              assert.isFalse(h.sources.current());
              const saved = doc.session.getSnapshot(),
                before = view.state;
              const afterSave = reveal(h.makeSources());
              assert.deepEqual(view.state.selection.toJSON(), caret);
              assert.isUndefined(afterSave?.transaction);
              assert.strictEqual(view.state, before);
              assert.strictEqual(doc.session.getSnapshot(), saved);
              assert.isFalse(saved.dirty);
              assert.equal(
                (await h.run(service.getPage(h.key))).page.title,
                "Renamed while editing the linked page",
              );
              const peer = h.documents.open(h.key);
              try {
                assert.strictEqual(await peer.ready, doc);
              } finally {
                peer.release();
              }
            } finally {
              view.stop();
              acquired.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps actual unloaded targets explicit and preserves a shared dirty draft until a deliberate bounded window advance",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service),
            metadata = yield* service.getPage(h.key);
          const blocks = [
            savedParagraph("reveal-a", "First", "20000000000000000000000000000000"),
            savedParagraph("reveal-b", "Target", "40000000000000000000000000000000"),
            savedParagraph("reveal-c", "Unloaded", "80000000000000000000000000000000"),
          ];
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "reveal-seed",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: 0,
            generation: 1,
            mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const reads: C.SpaceReadBlocksInput[] = [];
            const doc = new SpaceDocumentController(
              h.key,
              {
                adapter: createSpaceServiceSessionAdapter(h.key, h.ports),
                drafts: h.drafts,
                createMutationId: () => "reveal-save",
                maxLoadedBlocks: 100,
                maxMutations: 100,
              },
              {
                getPage: () => h.ports.getPage(h.key),
                windowLimit: () => 1,
                readBlocks: (input) => {
                  reads.push(input);
                  return h.run(service.readBlocks(input));
                },
              },
            );
            await doc.open();
            const route = savedView(doc),
              panel = savedView(doc);
            try {
              route.edit("dirty-");
              const before = doc.session.getSnapshot(),
                count = reads.length;
              const missing = route.bridge.revealBlock(
                route.state,
                { ...h.key, blockId: blocks[1]!.id },
                () => true,
              );
              assert.equal(missing.status, "not-loaded");
              assert.equal(reads.length, count);
              assert.equal(doc.session.getSnapshot(), before);
              assert.throws(() => doc.next(), "Resolve the draft");
              route.bridge.setWritable(false);
              const loaded = route.bridge.revealBlock(
                route.state,
                { ...h.key, blockId: blocks[0]!.id },
                () => true,
              );
              assert.equal(loaded.status, "loaded");
              if (loaded.transaction) route.dispatch(loaded.transaction);
              assert.equal(doc.session.getSnapshot(), before);
              assert.deepEqual(spaceDocumentBlocks(panel.state.doc), before.blocks);
              route.bridge.setWritable(true);
              await doc.save();
              const afterSave = reads.length;
              await doc.next();
              assert.equal(reads.length, afterSave + 1);
              const revealed = route.bridge.revealBlock(
                route.state,
                { ...h.key, blockId: blocks[1]!.id },
                () => true,
              );
              assert.equal(revealed.status, "loaded");
              if (revealed.transaction) route.dispatch(revealed.transaction);
              assert.equal(
                (route.state.selection as NodeSelection).node.attrs.block.id,
                blocks[1]!.id,
              );
              const all = await h.run(service.readBlocks({ ...h.key, revision: 2 }));
              assert.equal(
                (all.blocks[0]!.content as { runs: { text: string }[] }).runs[0]!.text,
                "dirty-First",
              );
              assert.deepEqual(all.blocks.slice(1), blocks.slice(1));
            } finally {
              route.stop();
              panel.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "resolves actual child marker identity and its current title without editing the marker",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Child title", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            const actual = await h.ports.getPage(h.key),
              body = await h.run(service.readBlocks({ ...h.key, revision: actual.page.revision }));
            const marker = body.blocks.find((block) => block.type === "child_page")!;
            if (marker.type !== "child_page") throw Error("No actual marker");
            const childId = C.SpacePageId.make(
              String((marker.content as { pageId: string }).pageId),
            );
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            try {
              const before = doc.session.getSnapshot();
              assert.equal(view.bridge.childPageTarget(marker.id), childId);
              const target = { kind: "page" as const, pageId: childId };
              const current = await h.sources.resolve(target);
              assert.equal(current?.page.title, "Child title");
              const child = await h.ports.getPage({ environmentId, pageId: childId });
              await owner.renamePage(child.page, "Renamed child");
              const renamed = await h.sources.resolve(target);
              assert.equal(renamed?.page.title, "Renamed child");
              assert.equal(renamed?.current()?.pageId, childId);
              assert.equal(view.bridge.childPageTarget(marker.id), childId);
              assert.deepEqual(doc.session.getSnapshot().blocks, before.blocks);
              assert.isFalse(
                view.bridge.adapter.convert(marker.id, "paragraph")(view.state, view.dispatch),
              );
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
  "keeps a real empty continuing search window until explicit Next without fetching content bodies",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("EmptyWindowNeedle")).status, "building");
            assert.equal((await h.sources.search("EmptyWindowNeedle")).status, "ready");
            const admission = await h.ports.getPage(h.key);
            for (let offset = 0; offset < 500; offset += 100) {
              await h.run(
                service.applyBlockBatch({
                  ...h.key,
                  mutationId: C.SpaceMutationId.make(`source-hidden-${offset}`),
                  receiptEpoch: admission.mutationAdmission.epoch,
                  baseRevision: offset / 100,
                  generation: offset / 100 + 1,
                  mutations: Array.from({ length: 100 }, (_, i) => ({
                    kind: "insert" as const,
                    block: savedParagraph(
                      `source-hidden-${offset + i}`,
                      "EmptyWindowNeedle",
                      (BigInt(offset + i) + 1n).toString(16).padStart(32, "0"),
                    ),
                  })),
                }),
              );
            }
            const visible = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
            await h.run(
              service.applyBlockBatch({
                environmentId,
                pageId: visible.page.id,
                mutationId: "source-visible",
                receiptEpoch: visible.mutationAdmission.epoch,
                baseRevision: 0,
                generation: 1,
                mutations: [
                  {
                    kind: "insert",
                    block: savedParagraph("source-visible-block", "EmptyWindowNeedle"),
                  },
                ],
              }),
            );
            const owner = h.make();
            await owner.previewRecovery(h.key.pageId, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const before = h.searches.length,
              bodyReads = h.structureBodyReads.length;
            const first = await h.sources.search("EmptyWindowNeedle");
            if (first.status !== "ready") throw Error(first.status);
            assert.deepEqual(first.result.items, []);
            assert.isNotNull(first.result.nextCursor);
            assert.equal(h.searches.length, before + 1);
            const next = await first.next();
            if (next.status !== "ready") throw Error(next.status);
            assert.deepEqual(
              next.result.items.map((hit) => hit.blockId),
              [C.SpaceBlockId.make("source-visible-block")],
            );
            assert.isFalse(first.current());
            assert.equal(h.searches.length, before + 2);
            assert.equal(h.searches.at(-1)!.cursor, first.result.nextCursor);
            assert.equal(h.structureBodyReads.length, bodyReads);
            assert.isNull(await h.sources.resolve({ kind: "page", pageId: h.key.pageId }));
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "surfaces actual search building, unsupported and storage states and applies client query/feature limits before transport",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            for (const query of ["", "word ".repeat(9), "界".repeat(100)])
              await h.sources.search(query);
            assert.equal(h.searches.length, 0);
            assert.equal((await h.sources.search("Second")).status, "building");
            assert.equal((await h.sources.search("Second")).status, "ready");
            const sql = new NodeSqlite.DatabaseSync(databasePath);
            try {
              sql
                .prepare("UPDATE spaces_search_build SET phase='unsupported' WHERE singleton=1")
                .run();
              assert.equal((await h.sources.search("Second")).status, "unsupported");
              sql
                .prepare("UPDATE spaces_search_build SET phase='invalid-phase' WHERE singleton=1")
                .run();
              assert.equal((await h.sources.search("Second")).status, "error");
            } finally {
              sql.close();
            }
            const calls = h.searches.length;
            for (const capability of [
              { version: 1, limits: h.capability.limits },
              { version: 2, limits: h.capability.limits },
              { ...h.capability, version: 3 },
            ]) {
              h.control.access = { ...h.control.access, capability };
              assert.equal((await h.sources.search("Second")).status, "unsupported");
            }
            assert.equal(h.searches.length, calls);
            h.control.access = { ...h.control.access, capability: h.capability, canRead: false };
            assert.equal((await h.sources.search("Second")).status, "unsupported");
            assert.equal(h.searches.length, calls);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "captures the actual source command session and invalidates it on transport replacement",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* boot(service),
            q = yield* queryRuntime(h.ports, (input) => h.run(service.readBlocks(input)));
          const captured = yield* Effect.promise(() =>
            q.queries.captureSession.run(q.registry, { environmentId, input: undefined }),
          );
          if (captured._tag !== "Success") throw Error("Session capture failed");
          assert.isNotNull(captured.value());
          yield* SubscriptionRef.set(q.sessions, Option.some(q.makeSession()));
          assert.isNull(captured.value());
          yield* SubscriptionRef.set(q.sessions, Option.none());
          const missing = yield* Effect.promise(() =>
            q.queries.captureSession.run(q.registry, { environmentId, input: undefined }),
          );
          if (missing._tag !== "Success") throw Error("Session capture failed");
          assert.isNull(missing.value());
          yield* SubscriptionRef.set(q.sessions, Option.some(q.makeSession()));
          const retried = yield* Effect.promise(() =>
            q.queries.captureSession.run(q.registry, { environmentId, input: undefined }),
          );
          if (retried._tag !== "Success") throw Error("Session retry failed");
          assert.isNotNull(retried.value());
          assert.isNull(missing.value());
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
