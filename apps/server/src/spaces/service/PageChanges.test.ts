import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  block,
  boot,
  childPage,
  env,
  fixture,
  moveIntent,
  recoveryIntent,
  rootPage,
} from "./Spaces.testkit.ts";

type Changed = Extract<C.SpacePageChangeEvent, { readonly type: "changed" }>;

// Pulled by hand, so each assertion sees exactly what the mailbox collected since the last pull.
const listen = Effect.fn("PageChangesTest.listen")(function* (
  service: Effect.Success<ReturnType<typeof boot>>["service"],
) {
  const pull = yield* Stream.toPull(service.subscribePageChanges(env));
  assert.deepEqual(yield* pull, [{ type: "resync" }]);
  return Effect.map(pull, (events) =>
    events.filter((event): event is Changed => event.type === "changed"),
  );
});

const pagesOf = (events: ReadonlyArray<Changed>) => events.flatMap((event) => event.pages);

it.layer(NodeServices.layer)("Spaces page change stream", (it) => {
  it.effect("publishes a block batch once, with committed revisions and no block text", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, page, request } = yield* boot();
          const next = yield* listen(service);
          yield* service.applyBlockBatch(
            request("batch-1", 0, [{ kind: "insert", block: block("secret-text") }]),
          );
          const events = yield* next;
          const stored = (yield* service.getPage({ ...env, pageId: page.id })).page;
          assert.equal(events.length, 1);
          assert.deepEqual(events[0]!.pages, [
            {
              id: page.id,
              spaceId: page.spaceId,
              revision: stored.revision,
              bodyRevision: stored.revision,
            },
          ]);
          assert.deepEqual(events[0]!.spaces, []);
          assert.notInclude(JSON.stringify(events), "secret-text");
          yield* service.applyBlockBatch(
            request("batch-2", stored.revision, [{ kind: "insert", block: block("two", 2) }]),
          );
          const second = pagesOf(yield* next);
          assert.equal(second.length, 1);
          assert.equal(second[0]!.revision, stored.revision + 1);
        }),
      ),
    ),
  );

  it.effect("publishes a title change as a tree change that leaves the body revision alone", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, common, page, request } = yield* boot();
          yield* service.applyBlockBatch(
            request("body", 0, [{ kind: "insert", block: block("a") }]),
          );
          const next = yield* listen(service);
          yield* service.updatePage({
            ...common,
            mutationId: "rename",
            pageId: page.id,
            baseRevision: 1,
            title: "Renamed",
          });
          const [change] = pagesOf(yield* next);
          assert.deepEqual(change, {
            id: page.id,
            spaceId: page.spaceId,
            revision: 2,
            bodyRevision: 1,
            tree: true,
          });
        }),
      ),
    ),
  );

  it.effect("publishes creation, nesting, moving, trashing and restoring as tree changes", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, common, library, page } = yield* boot();
          const next = yield* listen(service);
          const expectTree = Effect.fn("PageChangesTest.expectTree")(function* (
            label: string,
            id: C.SpacePageId,
          ) {
            const events = pagesOf(yield* next);
            assert.isTrue(
              events.some((change) => change.id === id && change.tree === true),
              label,
            );
          });
          const created = yield* rootPage(service, common, library.defaultSpaceId, "root-two");
          yield* expectTree("createPage", created.id);
          const child = yield* childPage(service, common, page.id, "child");
          yield* expectTree("createChildPage", child.page.id);
          yield* service.movePage(
            yield* moveIntent(service, common, created.id, "move", {
              kind: "child",
              placement: { pageId: page.id, parentId: null, beforeBlockId: null },
            }),
          );
          yield* expectTree("movePage", created.id);
          yield* service.trashPage(
            yield* recoveryIntent(service, common, created.id, "trash", "t"),
          );
          yield* expectTree("trashPage", created.id);
          yield* service.restorePage(
            yield* recoveryIntent(service, common, created.id, "restore", "r"),
          );
          yield* expectTree("restorePage", created.id);
        }),
      ),
    ),
  );

  it.effect("publishes a permanent delete as removed", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, common, library } = yield* boot();
          const doomed = yield* rootPage(service, common, library.defaultSpaceId, "doomed");
          yield* service.trashPage(yield* recoveryIntent(service, common, doomed.id, "trash", "t"));
          const next = yield* listen(service);
          yield* service.permanentlyDeletePage(
            yield* recoveryIntent(service, common, doomed.id, "permanentlyDelete", "purge"),
          );
          const change = pagesOf(yield* next).find((item) => item.id === doomed.id);
          assert.deepEqual(change, {
            id: doomed.id,
            spaceId: doomed.spaceId,
            revision: 0,
            bodyRevision: 0,
            tree: true,
            removed: true,
          });
        }),
      ),
    ),
  );

  it.effect("publishes nothing for a conflicting batch", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, page, request } = yield* boot();
          const next = yield* listen(service);
          const stale = yield* service.applyBlockBatch(
            request("stale", 5, [{ kind: "insert", block: block("never") }]),
          );
          assert.equal(stale.status, "conflict");
          yield* service.applyBlockBatch(
            request("real", 0, [{ kind: "insert", block: block("real") }]),
          );
          const events = yield* next;
          assert.equal(events.length, 1);
          assert.deepEqual(
            events[0]!.pages.map((change) => change.id),
            [page.id],
          );
          assert.equal(events[0]!.pages[0]!.revision, 1);
        }),
      ),
    ),
  );

  it.effect("lists created and renamed spaces", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, common } = yield* boot();
          const next = yield* listen(service);
          const created = yield* service.createSpace({
            ...common,
            mutationId: "space",
            title: "A",
          });
          if (created.status !== "saved") return yield* Effect.die("Expected a space");
          assert.deepEqual(
            (yield* next).flatMap((event) => event.spaces),
            [created.space.id],
          );
          yield* service.renameSpace({
            ...common,
            mutationId: "rename-space",
            spaceId: created.space.id,
            baseRevision: created.space.revision,
            title: "B",
          });
          assert.deepEqual(
            (yield* next).flatMap((event) => event.spaces),
            [created.space.id],
          );
        }),
      ),
    ),
  );
});
