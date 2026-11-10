import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, expect } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EditorState, TextSelection, type Command } from "@tiptap/pm/state";
import { spaceDocumentBlocks } from "../src/spaces/document.ts";
import {
  environmentId,
  fixture,
  savedParagraph,
  savedUndoFixture,
  savedView,
} from "./spacesEditorBridge.support.ts";
import { rootReorderFixture } from "./spacesServiceFixtures.support.ts";

it.effect("sets and clears a page icon through the library receipt without extra revisions", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        yield* Effect.promise(async () => {
          const owner = h.make();
          const selected = await h.ports.getPage(h.key);
          await owner.setPageIcon(selected.page, "🚀");
          const set = owner.getSnapshot().libraryResult!.page!;
          assert.equal(set.icon, "🚀");
          assert.equal(set.revision, selected.page.revision + 1);

          await owner.setPageIcon(set, "🚀");
          assert.equal(owner.getSnapshot().libraryResult!.page!.revision, set.revision);

          await owner.setPageIcon(set, null);
          const cleared = owner.getSnapshot().libraryResult!.page!;
          assert.isFalse("icon" in cleared);
          assert.equal(cleared.revision, set.revision + 1);

          await expect(owner.setPageIcon(cleared, "hello")).rejects.toThrow("Invalid page icon");
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("saves a page rename over a peer title change instead of conflicting", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        yield* Effect.promise(async () => {
          const selected = await h.ports.getPage(h.key);
          await h.run(
            service.updatePage({
              ...h.key,
              mutationId: "peer-title-before-rename",
              receiptEpoch: selected.mutationAdmission.epoch,
              baseRevision: selected.page.revision,
              title: "Peer title",
            }),
          );
          const owner = h.make();
          await owner.renamePage(selected.page, "My attempted title");
          assert.isNull(owner.getSnapshot().journal.pending);
          assert.equal((await h.ports.getPage(h.key)).page.title, "My attempted title");
          assert.equal(h.libraryRequests.length, 1);
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["createSpace", "renameSpace", "setDefaultSpace", "updatePage"] as const)(
  "recovers the original %s receipt after reload with operate withdrawn",
  (operation) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const selected = await h.ports.getPage(h.key);
            let candidate = selected.space;
            if (operation === "setDefaultSpace") {
              await owner.createSpace("Candidate");
              candidate = owner.getSnapshot().libraryResult!.space!;
            }
            const before = h.libraryRequests.length;
            h.network.lose = "after";
            const work =
              operation === "createSpace"
                ? owner.createSpace("Lost new space")
                : operation === "renameSpace"
                  ? owner.renameSpace(candidate, "Lost rename")
                  : operation === "setDefaultSpace"
                    ? owner.setDefaultSpace(candidate, selected.space)
                    : owner.renamePage(selected.page, "Lost page title");
            await expect(work).rejects.toThrow("Lost committed response");
            const original = h.stored()!.pending!;
            h.setWritable(false);
            const restored = h.reload();
            await restored.recover();
            assert.equal(h.libraryRequests.length, before + 1);
            assert.deepEqual(h.lookups.at(-1), { request: original.request });
            assert.isNull(restored.getSnapshot().journal.pending);
            assert.equal(restored.getSnapshot().libraryResult!.operation, operation);
            if (operation === "createSpace") {
              const spaces = await h.run(service.listSpaces({ environmentId }));
              assert.equal(spaces.items.filter((s) => s.title === "Lost new space").length, 1);
            } else if (operation === "renameSpace") {
              assert.equal(
                (await h.run(service.listPages({ environmentId, spaceId: candidate.id }))).space
                  .revision,
                candidate.revision + 1,
              );
            } else if (operation === "setDefaultSpace") {
              const spaces = await h.run(service.listSpaces({ environmentId }));
              assert.equal(spaces.defaultSpaceId, candidate.id);
              assert.isFalse(spaces.items.find((s) => s.id === selected.space.id)!.isDefault);
            } else {
              assert.equal(
                (await h.ports.getPage(h.key)).page.revision,
                selected.page.revision + 1,
              );
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "interlocks two rename consumers before strict-codec persistence and retries the identical unsent intent after storage failure",
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
            const selected = await h.ports.getPage(h.key);
            const owner = h.make();
            h.disk.hold = true;
            h.disk.fail = true;
            const renaming = owner.renamePage(selected.page, "Durable title");
            await h.disk.started.promise;
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.libraryRequests.length, 0);
            assert.throws(
              () =>
                doc.session.apply([
                  { kind: "insert", block: savedParagraph("blocked-rename", "keep") },
                ]),
              "reserved",
            );
            await expect(doc.save()).rejects.toThrow("reserved");
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            await expect(owner.createSpace("Overlapping action")).rejects.toThrow("in progress");
            h.disk.release.resolve();
            await expect(renaming).rejects.toThrow("abort");
            assert.equal(h.libraryRequests.length, 0);
            assert.deepEqual(owner.getSnapshot().journal.pending, pending);
            h.disk.hold = false;
            h.disk.fail = false;
            await owner.recover();
            assert.deepEqual(h.libraryRequests, [pending.request]);
            assert.equal(h.lookups.length, 0);
            assert.isFalse(doc.structureBlocked());
            assert.equal(doc.session.getSnapshot().baseRevision, selected.page.revision + 1);
            assert.equal(h.counts().refreshed, 1);
            first.release();
            second.release();
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect("refuses a hidden page draft on rename while library-only metadata preserves it", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        yield* Effect.promise(async () => {
          const opened = h.documents.open(h.key),
            doc = await opened.ready;
          doc.session.apply([
            { kind: "insert", block: savedParagraph("library-hidden-draft", "Do not replace") },
          ]);
          await doc.session.persistDraft();
          opened.release();
          const draft = h.draftRecords.get(h.key.pageId)!;
          const selected = await h.ports.getPage(h.key);
          const owner = h.reload();
          await expect(owner.renamePage(selected.page, "Blocked title")).rejects.toThrow(
            "retained draft",
          );
          assert.equal(h.libraryRequests.length, 0);
          assert.isNull(owner.getSnapshot().journal.pending);
          await owner.renameSpace(selected.space, "Metadata only");
          assert.deepEqual(h.draftRecords.get(h.key.pageId), draft);
          assert.equal((await h.ports.getPage(h.key)).page.revision, selected.page.revision);
        });
      }),
    ),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains a root creation conflict rather than advancing the selected root-order revision",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const selected = await h.ports.getPage(h.key);
            await h.run(
              service.createPage({
                environmentId,
                spaceId: h.spaceId,
                title: "Peer root",
                baseRootOrderRevision: selected.space.rootOrderRevision,
                mutationId: "peer-root-before-create",
                receiptEpoch: selected.mutationAdmission.epoch,
              }),
            );
            const owner = h.make();
            await owner.createRootPage(selected.space, "Attempted root");
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            assert.equal(pending.request.operation, "createPage");
            if (pending.request.operation !== "createPage") throw new Error("Wrong request");
            assert.equal(
              pending.request.input.baseRootOrderRevision,
              selected.space.rootOrderRevision,
            );
            assert.equal((await h.order()).length, 5);
            await expect(owner.createSpace("Blocked by conflict")).rejects.toThrow("Resolve");
            await owner.reinspect();
            assert.isNull(owner.getSnapshot().journal.pending);
            const current = await h.ports.getPage(h.key);
            await owner.createRootPage(current.space, "Explicit new root");
            assert.equal((await h.order()).length, 6);
            assert.notEqual(
              h.libraryRequests[0]!.input.mutationId,
              h.libraryRequests[1]!.input.mutationId,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps an unsent library intent when operate is withdrawn during durable persistence",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            h.disk.hold = true;
            const work = owner.createSpace("Wait for permission");
            await h.disk.started.promise;
            const original = owner.getSnapshot().journal.pending!;
            h.setWritable(false);
            h.disk.release.resolve();
            await expect(work).rejects.toThrow("revoked");
            assert.equal(h.libraryRequests.length, 0);
            assert.deepEqual(h.stored()!.pending, original);
            h.disk.hold = false;
            h.setWritable(true);
            await owner.recover();
            assert.deepEqual(h.libraryRequests, [original.request]);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect.each(["renameSpace", "setDefaultSpace"] as const)(
  "preserves the selected space metadata guards through a %s race",
  (operation) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const previous = (await h.ports.getPage(h.key)).space;
            await owner.createSpace("Candidate");
            const candidate = owner.getSnapshot().libraryResult!.space!;
            const changed = operation === "renameSpace" ? candidate : previous;
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.renameSpace({
                environmentId,
                spaceId: changed.id,
                baseRevision: changed.revision,
                title: "Peer name",
                mutationId: `peer-library-${operation}`,
                receiptEpoch: admission.mutationAdmission.epoch,
              }),
            );
            if (operation === "renameSpace") await owner.renameSpace(candidate, "Attempted name");
            else await owner.setDefaultSpace(candidate, previous);
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            const request = pending.request;
            if (request.operation !== "renameSpace" && request.operation !== "setDefaultSpace")
              throw new Error("Wrong metadata operation");
            assert.equal(request.input.baseRevision, candidate.revision);
            if (request.operation === "setDefaultSpace") {
              assert.equal(request.input.baseDefaultRevision, previous.revision);
              assert.equal(request.input.defaultSpaceId, previous.id);
            }
            const catalog = await h.run(service.listSpaces({ environmentId }));
            assert.equal(catalog.defaultSpaceId, previous.id);
            assert.equal(catalog.items.find((s) => s.id === changed.id)!.title, "Peer name");
            assert.equal(h.libraryRequests.length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "retains a definite server root-rank refusal for explicit inspection without fabricating a receipt or renumbering peers",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            sql
              .prepare("UPDATE spaces_pages SET root_order=? WHERE page_id=?")
              .run("ffffffffffffffffffffffffffffffff", h.pages.at(-1)!);
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const owner = h.make(),
              selected = await h.ports.getPage(h.key);
            await owner.createRootPage(selected.space, "No rank available");
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            assert.equal(pending.rejection, "invalid_order");
            assert.equal(h.libraryRequests.length, 1);
            assert.deepEqual(await h.order(), h.pages);
            const lookup = await h.run(service.lookupMutationReceipt({ request: pending.request }));
            assert.equal(lookup.status, "absent");
            await expect(owner.recover()).rejects.toThrow("No uncertain");
            await owner.reinspect();
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "saves current block attributes and rich links as incremental replacements with shared views and exact saved compensation",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const mention = {
            type: "page_mention",
            version: 1,
            target: { environmentId, pageId: C.SpacePageId.make("mentioned-page") },
          };
          const runs = [
            { text: "", marks: [] },
            { text: "head", marks: [{ type: "bold", version: 1 }, mention] },
          ];
          const blocks = [
            {
              ...savedParagraph("format-heading", ""),
              type: "heading",
              content: { level: 1, runs },
            },
            {
              ...savedParagraph("format-callout", "body", "80000000000000000000000000000000"),
              type: "callout",
              content: { icon: "💡", runs: [{ text: "body", marks: [] }] },
            },
            {
              ...savedParagraph("format-code", "", "c0000000000000000000000000000000"),
              type: "code",
              content: { text: "source", language: "original-language" },
            },
          ];
          const h = yield* savedUndoFixture(service, blocks);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            const at = (state: EditorState, id: string, offset = 0) => {
              let found = -1;
              state.doc.descendants((node, pos) => {
                if (node.attrs.block?.id === id) found = pos + 1 + offset;
              });
              return found;
            };
            const select = (id: string, end?: number) =>
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(
                    view.state.doc,
                    at(view.state, id),
                    end === undefined ? undefined : at(view.state, id, end),
                  ),
                ),
              );
            const run = (command: Command) => assert.isTrue(command(view.state, view.dispatch));
            try {
              peer.dispatch(
                peer.state.tr.setSelection(
                  TextSelection.create(peer.state.doc, at(peer.state, "format-callout", 2)),
                ),
              );
              select("format-heading");
              run(view.bridge.adapter.setHeadingLevel(3));
              const heading = { ...blocks[0]!, content: { level: 3, runs } };
              select("format-callout");
              run(view.bridge.adapter.setCalloutIcon("📌"));
              const callout = {
                ...blocks[1]!,
                content: { icon: "📌", runs: [{ text: "body", marks: [] }] },
              };
              select("format-code");
              run(view.bridge.adapter.setCodeLanguage("typescript"));
              const code = { ...blocks[2]!, content: { text: "source", language: "typescript" } };
              select("format-heading", 4);
              run(view.bridge.adapter.setLink("https://example.test/kept"));
              const linked = {
                ...heading,
                content: {
                  level: 3,
                  runs: [
                    runs[0]!,
                    {
                      text: "head",
                      marks: [
                        { type: "bold", version: 1 },
                        mention,
                        { type: "link", version: 1, href: "https://example.test/kept" },
                      ],
                    },
                  ],
                },
              };
              const expected = [linked, callout, code];
              assert.deepEqual(spaceDocumentBlocks(peer.state.doc), expected);
              assert.equal(peer.state.selection.head, at(peer.state, "format-callout", 2));
              await controller.save();
              assert.deepEqual(h.requests[0]!.mutations, [
                { kind: "replace", block: linked },
                { kind: "replace", block: callout },
                { kind: "replace", block: code },
              ]);
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 2 }))).blocks,
                expected,
              );
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 3 }))).blocks,
                blocks,
              );
              assert.deepEqual(spaceDocumentBlocks(peer.state.doc), blocks);
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 4 }))).blocks,
                expected,
              );
              select("format-heading");
              run(view.bridge.adapter.setHeadingLevel(2));
              await controller.save();
              assert.equal(h.requests.length, 4);
              assert.deepEqual(h.requests[3]!.mutations, [
                { kind: "replace", block: { ...linked, content: { ...linked.content, level: 2 } } },
              ]);
              assert.notEqual(h.requests[3]!.mutationId, h.requests[0]!.mutationId);
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);

it.effect(
  "keeps a newer heading attribute edit after the exact earlier formatting prefix is acknowledged",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const block = {
            ...savedParagraph("format-late", "title"),
            type: "heading",
            content: { level: 1, runs: [{ text: "title", marks: [] }] },
          };
          const h = yield* savedUndoFixture(service, [block]);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.setHeadingLevel(2)(view.state, view.dispatch));
              h.transport.hold = true;
              const saving = controller.save();
              await h.transport.committed.promise;
              const original = controller.session.getSnapshot().pending!;
              assert.isTrue(view.bridge.adapter.setHeadingLevel(3)(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().pending, original);
              h.transport.reply.resolve();
              await saving;
              assert.isTrue(controller.session.getSnapshot().dirty);
              assert.deepEqual(controller.session.getSnapshot().blocks, [
                { ...block, content: { ...block.content, level: 3 } },
              ]);
              await controller.save();
              assert.equal(h.requests.length, 2);
              assert.deepEqual(h.requests[0]!.mutations, [
                { kind: "replace", block: { ...block, content: { ...block.content, level: 2 } } },
              ]);
              assert.deepEqual(h.requests[1]!.mutations, [
                { kind: "replace", block: { ...block, content: { ...block.content, level: 3 } } },
              ]);
              assert.equal(h.requests[1]!.baseRevision, 2);
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 3 }))).blocks,
                controller.session.getSnapshot().blocks,
              );
            } finally {
              h.transport.reply.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
