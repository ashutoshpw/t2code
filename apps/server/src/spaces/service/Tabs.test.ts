import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { block, boot, blockMoveIntent, env, fixture, rootPage } from "./Spaces.testkit.ts";

const tabs = (id: string, order = 1, parentId: C.SpaceBlockId | null = null): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId,
  order: order.toString(16).padStart(32, "0"),
  type: "tabs",
  version: 1,
  content: {},
});
const pane = (id: string, parentId: string, title: string, order = 1): C.SpaceBlock => ({
  ...tabs(id, order, C.SpaceBlockId.make(parentId)),
  type: "tab_pane",
  content: { title },
});
const insert = (...blocks: readonly C.SpaceBlock[]) =>
  blocks.map((value) => ({ kind: "insert" as const, block: value }));

it.layer(NodeServices.layer)("Spaces tabs blocks", (it) => {
  it.effect("enforces tabs and pane parents and keeps the kind on replace", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, page, request } = yield* boot();
        const rejected = (id: string, mutations: ReturnType<typeof insert>) =>
          Effect.flip(service.applyBlockBatch(request(id, 0, mutations))).pipe(
            Effect.map((error) =>
              error._tag === "SpaceValidationError" ? error.reason : error._tag,
            ),
          );
        assert.equal(
          yield* rejected(
            "tabs-paragraph",
            insert(tabs("t0"), block("p0", 1, C.SpaceBlockId.make("t0"))),
          ),
          "invalid_parent",
        );
        assert.equal(
          yield* rejected("root-pane", insert({ ...pane("pane-root", "x", "x"), parentId: null })),
          "invalid_parent",
        );
        assert.equal(
          yield* rejected("pane-under-paragraph", insert(block("p1"), pane("pane-p", "p1", "x"))),
          "invalid_parent",
        );
        assert.equal(
          yield* rejected(
            "extra-field",
            insert(tabs("t1"), {
              ...pane("pane-extra", "t1", "x"),
              content: { title: "x", more: 1 },
            }),
          ),
          "unsupported_block",
        );

        const valid = [
          tabs("t2"),
          pane("pane-a", "t2", "Alpha"),
          block("p2", 1, C.SpaceBlockId.make("pane-a")),
          pane("pane-b", "t2", "Beta", 2),
        ];
        const saved = yield* service.applyBlockBatch(request("valid", 0, insert(...valid)));
        assert.equal(saved.status, "saved");
        const read = yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 });
        assert.deepEqual(read.blocks, valid);

        const swapped = yield* Effect.flip(
          service.applyBlockBatch(
            request("replace-kind", 1, [
              { kind: "replace", block: { ...block("t2"), order: valid[0]!.order } },
            ]),
          ),
        );
        assert.equal(
          swapped._tag === "SpaceValidationError" && swapped.reason,
          "unsupported_block",
        );
      }),
    ),
  );

  it.effect("moves blocks out of a pane and refuses to move a paragraph into tabs", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, library, request } = yield* boot();
        const destination = yield* rootPage(service, common, library.defaultSpaceId, "tabs-dest");
        const mover = block("mover", 1, C.SpaceBlockId.make("pane-a"));
        yield* service.applyBlockBatch(
          request(
            "seed",
            0,
            insert(tabs("t2"), pane("pane-a", "t2", "Alpha"), mover, block("loose", 2)),
          ),
        );
        const into = yield* Effect.flip(
          blockMoveIntent(
            service,
            common,
            page.id,
            [C.SpaceBlockId.make("loose")],
            { pageId: page.id, parentId: C.SpaceBlockId.make("t2"), beforeBlockId: null },
            "into-tabs",
          ),
        );
        assert.equal(into._tag === "SpaceValidationError" && into.reason, "invalid_parent");
        const input = yield* blockMoveIntent(
          service,
          common,
          page.id,
          [mover.id],
          { pageId: destination.id, parentId: null, beforeBlockId: null },
          "out-of-pane",
        );
        const done = yield* service.moveBlocks(input);
        assert.equal(done.status, "saved");
        const revision = (yield* service.getPage({ ...env, pageId: destination.id })).page.revision;
        const moved = yield* service.readBlocks({ ...env, pageId: destination.id, revision });
        assert.deepEqual(
          moved.blocks.map((value) => [value.id, value.parentId]),
          [["mover", null]],
        );
      }),
    ),
  );

  it.effect("indexes pane titles and renders panes in context snapshots", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, page, request } = yield* boot();
        yield* service.applyBlockBatch(
          request(
            "seed",
            0,
            insert(
              tabs("t2"),
              pane("pane-a", "t2", "Zebrafish"),
              { ...block("p2", 1, C.SpaceBlockId.make("pane-a")) },
              block("after", 2),
            ),
          ),
        );
        const pending = yield* Effect.flip(service.search({ ...env, query: "Zebrafish" }));
        assert.equal(pending._tag, "SpaceSearchUnavailableError");
        const first = yield* service.search({ ...env, query: "Zebrafish" });
        assert.equal(first.items[0]?.page.id, page.id);
        const captured = yield* service.captureContextSnapshot({
          ...env,
          contextId: "ctx",
          target: { kind: "page", pageId: page.id },
        });
        if (captured.status !== "captured") return yield* Effect.die("Expected capture");
        assert.equal(captured.record.snapshot.text, "### Zebrafish\np2\nafter");
      }),
    ),
  );
});
