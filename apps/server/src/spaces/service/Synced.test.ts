import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  block,
  blockMoveIntent,
  boot,
  env,
  fixture,
  recoveryIntent,
  rootPage,
} from "./Spaces.testkit.ts";

const id = C.SpaceBlockId.make;
const synced = (
  blockId: string,
  order = 1,
  parentId: C.SpaceBlockId | null = null,
): C.SpaceBlock => ({
  id: id(blockId),
  parentId,
  order: order.toString(16).padStart(32, "0"),
  type: "synced_block",
  version: 1,
  content: {},
});
const ref = (
  blockId: string,
  sourceBlockId: string,
  order = 1,
  parentId: string | null = null,
): C.SpaceBlock => ({
  id: id(blockId),
  parentId: parentId === null ? null : id(parentId),
  order: order.toString(16).padStart(32, "0"),
  type: "synced_ref",
  version: 1,
  content: { sourceBlockId: id(sourceBlockId) },
});
const spaced = (value: C.SpaceBlock, n: number): C.SpaceBlock => ({
  ...value,
  order: (BigInt(n) << 100n).toString(16).padStart(32, "0"),
});
const insert = (...blocks: readonly C.SpaceBlock[]): C.SpaceBlockMutation[] =>
  blocks.map((value) => ({ kind: "insert" as const, block: value }));
const reasonOf = (error: C.SpaceServiceError) =>
  error._tag === "SpaceValidationError" ? error.reason : error._tag;
const child = (blockId: string, parentId: string, order = 1) => block(blockId, order, id(parentId));

it.layer(NodeServices.layer)("Spaces synced blocks", (it) => {
  it.effect("enforces where originals and copies may sit", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, page, request } = yield* boot();
        let revision = 0;
        const reject = (mutationId: string, ...blocks: readonly C.SpaceBlock[]) =>
          Effect.flip(
            service.applyBlockBatch(request(mutationId, revision, insert(...blocks))),
          ).pipe(Effect.map(reasonOf));
        assert.equal(
          yield* reject("ref-paragraph", block("p0"), ref("r0", "p0")),
          "invalid_parent",
        );
        assert.equal(yield* reject("ref-missing", ref("r1", "nowhere")), "invalid_parent");
        assert.equal(
          yield* reject("ref-in-synced", synced("s0"), ref("r2", "s0", 1, "s0")),
          "invalid_parent",
        );
        assert.equal(
          yield* reject("synced-in-synced", synced("s1"), synced("s2", 1, id("s1"))),
          "invalid_parent",
        );
        assert.equal(
          yield* reject(
            "deep-synced",
            synced("s3"),
            { ...block("t0", 1, id("s3")), type: "toggle" },
            synced("s4", 1, id("t0")),
          ),
          "invalid_parent",
        );
        assert.equal(
          yield* reject("tabs-in-synced", synced("s5"), {
            ...block("t1", 1, id("s5")),
            type: "tabs",
            content: {},
          }),
          "invalid_parent",
        );
        assert.equal(
          yield* reject("database-in-synced", synced("s6"), {
            ...block("d0", 1, id("s6")),
            type: "database",
            content: { databaseId: "x", viewIds: [] },
          }),
          "invalid_parent",
        );
        assert.equal(
          yield* reject("synced-extra-field", { ...synced("s7"), content: { more: 1 } }),
          "unsupported_block",
        );

        const saved = yield* service.applyBlockBatch(
          request("valid", revision, insert(synced("s8"), child("c8", "s8"), ref("r8", "s8", 2))),
        );
        assert.equal(saved.status, "saved");
        revision = saved.status === "saved" ? saved.revision : 0;
        assert.equal(
          yield* Effect.flip(
            service.applyBlockBatch(
              request("retarget", revision, [{ kind: "replace", block: ref("r8", "c8", 2) }]),
            ),
          ).pipe(Effect.map(reasonOf)),
          "unsupported_block",
        );
        const read = yield* service.readBlocks({ ...env, pageId: page.id, revision });
        assert.deepEqual(
          read.blocks.map((value) => value.type),
          ["synced_block", "paragraph", "synced_ref"],
        );
      }),
    ),
  );

  it.effect(
    "reads an original's subtree and its copies, and reports deleted or trashed originals",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const other = yield* rootPage(service, common, library.defaultSpaceId, "copy-page");
          yield* service.applyBlockBatch(
            request(
              "seed",
              0,
              insert(
                synced("s"),
                child("c1", "s", 1),
                { ...block("c2", 2, id("s")), type: "toggle" },
                child("c3", "c2"),
                block("after", 2),
              ),
            ),
          );
          yield* service.applyBlockBatch({
            ...common,
            mutationId: C.SpaceMutationId.make("copy"),
            pageId: other.id,
            baseRevision: other.revision,
            generation: 0,
            mutations: insert(ref("r1", "s"), ref("r2", "s", 2)),
          });
          const found = yield* service.readSubtree({ ...env, blockId: "s" });
          assert.equal(found.status, "found");
          if (found.status !== "found") return;
          assert.deepEqual(
            found.blocks.map((value) => value.id),
            ["s", "c1", "c2", "c3"],
          );
          assert.equal(found.page.id, page.id);
          assert.equal(found.complete, true);
          assert.equal(found.refCount, 2);
          assert.deepEqual(
            found.refs.map((value) => [value.blockId, value.pageId, value.title]),
            [
              ["r1", other.id, "copy-page"],
              ["r2", other.id, "copy-page"],
            ],
          );
          assert.equal(
            found.revision,
            (yield* service.getPage({ ...env, pageId: page.id })).page.revision,
          );

          assert.equal(
            (yield* service.readSubtree({ ...env, blockId: "after" })).status,
            "unavailable",
          );
          assert.equal((yield* service.readSubtree({ ...env, blockId: "nope" })).status, "deleted");

          const trash = yield* recoveryIntent(service, common, page.id, "trash", "trash-source");
          yield* service.trashPage(trash);
          assert.equal(
            (yield* service.readSubtree({ ...env, blockId: "s" })).status,
            "unavailable",
          );
          const restore = yield* recoveryIntent(
            service,
            common,
            page.id,
            "restore",
            "restore-source",
          );
          yield* service.restorePage(restore);
          assert.equal((yield* service.readSubtree({ ...env, blockId: "s" })).status, "found");

          const revision = (yield* service.getPage({ ...env, pageId: page.id })).page.revision;
          yield* service.applyBlockBatch(
            request("drop", revision, [
              { kind: "delete", blockId: id("c1") },
              { kind: "delete", blockId: id("c3") },
              { kind: "delete", blockId: id("c2") },
              { kind: "delete", blockId: id("s") },
            ]),
          );
          assert.equal((yield* service.readSubtree({ ...env, blockId: "s" })).status, "deleted");
        }),
      ),
  );

  it.effect("confines a scoped batch to the subtree and conflicts on a stale base", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, request } = yield* boot();
        yield* service.applyBlockBatch(
          request("seed", 0, insert(synced("s"), child("c1", "s", 1), block("outside", 2))),
        );
        const scoped = (
          mutationId: string,
          baseRevision: number,
          mutations: ReturnType<typeof insert>,
        ) => ({
          ...request(mutationId, baseRevision, mutations),
          subtreeRootId: id("s"),
        });
        const rejected = (mutationId: string, mutations: ReturnType<typeof insert>) =>
          Effect.flip(service.applyBlockBatch(scoped(mutationId, 1, mutations))).pipe(
            Effect.map(reasonOf),
          );
        assert.equal(yield* rejected("outside-insert", insert(block("n0", 3))), "invalid_parent");
        assert.equal(
          yield* rejected("outside-edit", [
            { kind: "replace", block: { ...block("outside", 2), content: { runs: [] } } },
          ]),
          "invalid_parent",
        );
        assert.equal(
          yield* rejected("outside-delete", [{ kind: "delete", blockId: id("outside") }]),
          "invalid_parent",
        );
        assert.equal(
          yield* rejected("move-out", [
            { kind: "replace", block: { ...block("c1", 1), parentId: null } },
          ]),
          "invalid_parent",
        );
        assert.equal(
          yield* rejected("touch-root", [{ kind: "replace", block: synced("s", 9) }]),
          "invalid_parent",
        );
        assert.equal(
          yield* rejected("delete-root", [
            { kind: "delete", blockId: id("c1") },
            { kind: "delete", blockId: id("s") },
          ]),
          "invalid_parent",
        );
        const ok = yield* service.applyBlockBatch(scoped("inside", 1, insert(child("c2", "s", 2))));
        assert.equal(ok.status, "saved");
        const unscoped = yield* service
          .applyBlockBatch({
            ...scoped("elsewhere", 2, insert(block("n1", 4))),
            pageId: page.id,
            subtreeRootId: id("c1"),
          })
          .pipe(Effect.flip);
        assert.equal(reasonOf(unscoped), "invalid_parent");
        // Another editor of the source page moved it on; the copy's save is a conflict.
        yield* service.applyBlockBatch(request("host-edit", 2, insert(block("n2", 5))));
        const stale = yield* service.applyBlockBatch(
          scoped("late", 2, insert(child("c3", "s", 3))),
        );
        assert.equal(stale.status, "conflict");
        assert.equal(common.environmentId, env.environmentId);
      }),
    ),
  );

  it.effect("keeps blocks with forbidden descendants out of a synced block", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, request } = yield* boot();
        yield* service.applyBlockBatch(
          request(
            "seed",
            0,
            insert(
              synced("s"),
              { ...block("tg", 2), type: "toggle" },
              { ...block("tabs", 1, id("tg")), type: "tabs", content: {} },
              block("plain", 3),
            ),
          ),
        );
        const into = yield* Effect.flip(
          blockMoveIntent(
            service,
            common,
            page.id,
            [id("tg")],
            { pageId: page.id, parentId: id("s"), beforeBlockId: null },
            "toggle-into-synced",
          ),
        );
        assert.equal(reasonOf(into), "invalid_parent");
        const allowed = yield* blockMoveIntent(
          service,
          common,
          page.id,
          [id("plain")],
          { pageId: page.id, parentId: id("s"), beforeBlockId: null },
          "plain-into-synced",
        );
        assert.equal((yield* service.moveBlocks(allowed)).status, "saved");
      }),
    ),
  );

  it.effect("unsyncs copies into ordinary blocks and publishes the changed pages", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const first = yield* rootPage(service, common, library.defaultSpaceId, "first");
          const second = yield* rootPage(service, common, library.defaultSpaceId, "second");
          yield* service.applyBlockBatch(
            request(
              "seed",
              0,
              insert(
                synced("s"),
                child("c1", "s", 1),
                { ...block("c2", 2, id("s")), type: "toggle" },
                child("c3", "c2"),
              ),
            ),
          );
          const place = (
            target: typeof first,
            mutationId: string,
            ...blocks: readonly C.SpaceBlock[]
          ) =>
            service.applyBlockBatch({
              ...common,
              mutationId: C.SpaceMutationId.make(mutationId),
              pageId: target.id,
              baseRevision: 0,
              generation: 0,
              mutations: insert(...blocks),
            });
          yield* place(
            first,
            "first-seed",
            spaced(block("before"), 1),
            spaced(ref("r1", "s"), 2),
            spaced(block("tail"), 3),
          );
          yield* place(second, "second-seed", spaced(ref("r2", "s"), 1));
          const pull = yield* Stream.toPull(service.subscribePageChanges(env));
          yield* pull;
          const one = yield* service.unsyncBlocks({
            ...common,
            mutationId: "unsync-one",
            sourceBlockId: id("s"),
            refBlockIds: [id("r1")],
          });
          assert.equal(one.pages.length, 1);
          assert.equal(one.pages[0]!.pageId, first.id);
          const events = yield* pull;
          assert.deepEqual(
            events.flatMap((event) =>
              event.type === "changed" ? event.pages.map((p) => p.id) : [],
            ),
            [first.id],
          );
          const body = yield* service.readBlocks({
            ...env,
            pageId: first.id,
            revision: one.pages[0]!.revision,
          });
          const types = body.blocks.map((value) => [value.type, value.parentId === null]);
          assert.deepEqual(types, [
            ["paragraph", true],
            ["paragraph", true],
            ["toggle", true],
            ["paragraph", false],
            ["paragraph", true],
          ]);
          assert.isFalse(body.blocks.some((value) => value.id === "r1" || value.id === "c1"));
          const [copied, toggle, nested] = [body.blocks[1]!, body.blocks[2]!, body.blocks[3]!];
          assert.equal(nested.parentId, toggle.id);
          assert.isTrue(copied.order > body.blocks[0]!.order && toggle.order > copied.order);
          assert.isTrue(body.blocks[4]!.order > toggle.order);
          const source = yield* service.readSubtree({ ...env, blockId: "s" });
          assert.equal(source.status === "found" && source.blocks.length, 4);
          assert.equal(source.status === "found" && source.refCount, 1);

          const all = yield* service.unsyncBlocks({
            ...common,
            mutationId: "unsync-all",
            sourceBlockId: id("s"),
          });
          assert.deepEqual(
            all.pages.map((entry) => entry.pageId),
            [second.id],
          );
          const after = yield* service.readSubtree({ ...env, blockId: "s" });
          assert.equal(after.status === "found" && after.refCount, 0);
          assert.equal(page.id === first.id, false);
        }),
      ),
    ),
  );

  it.effect("refuses to unsync a copy of another original or a missing one", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, request } = yield* boot();
        yield* service.applyBlockBatch(
          request(
            "seed",
            0,
            insert(
              synced("s"),
              synced("t", 2),
              child("tc", "t"),
              ref("r", "t", 3),
              block("tail", 4),
            ),
          ),
        );
        const wrong = yield* Effect.flip(
          service.unsyncBlocks({
            ...common,
            mutationId: "wrong",
            sourceBlockId: id("s"),
            refBlockIds: [id("r")],
          }),
        );
        assert.equal(wrong._tag, "SpaceNotFoundError");
        const tight = yield* Effect.flip(
          service.unsyncBlocks({ ...common, mutationId: "tight", sourceBlockId: id("t") }),
        );
        assert.equal(tight._tag === "SpaceValidationError" && tight.reason, "invalid_order");
        const gone = yield* Effect.flip(
          service.unsyncBlocks({ ...common, mutationId: "gone", sourceBlockId: id("nope") }),
        );
        assert.equal(gone._tag, "SpaceNotFoundError");
      }),
    ),
  );
});
