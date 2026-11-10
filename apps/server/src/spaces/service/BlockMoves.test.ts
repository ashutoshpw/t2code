import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  env,
  block,
  bytes,
  fixture,
  boot,
  historyState,
  structureState,
  childPage,
  rootPage,
  blockMoveIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect(
    "rebalances a real exhausted sibling gap for multiple selected roots in requested order",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "multi-rank-dest",
          );
          const roots = [block("multi-a"), block("multi-b", 2)];
          yield* service.applyBlockBatch(
            request(
              "multi-roots",
              0,
              roots.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const peers = [0, 1].map((i) => ({
            ...block(`multi-peer-${i}`, i),
            futureEnvelope: { untouched: ["界", i] },
          }));
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "multi-peers",
            pageId: destination.id,
            baseRevision: 0,
            generation: 0,
            mutations: peers.map((value) => ({ kind: "insert", block: value })),
          });
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [roots[1]!.id, roots[0]!.id],
            { pageId: destination.id, parentId: null, beforeBlockId: peers[1]!.id },
            "multi-gap",
          );
          const moved = yield* service.moveBlocks(input);
          if (moved.status !== "saved") return yield* Effect.die("Expected multi move");
          assert.deepEqual(
            moved.changed.pages.map((row) => row.revision),
            [2, 2],
          );
          const body = (yield* service.readBlocks({ ...env, pageId: destination.id, revision: 2 }))
            .blocks;
          assert.deepEqual(
            body.map((value) => value.id),
            [peers[0]!.id, roots[1]!.id, roots[0]!.id, peers[1]!.id],
          );
          assert.equal(new Set(body.map((value) => value.order)).size, 4);
          assert.isTrue(body.every((value) => /^[0-9a-f]{32}$/.test(value.order)));
          assert.deepEqual(body[0]!.futureEnvelope, peers[0]!.futureEnvelope);
          assert.deepEqual(body[3]!.futureEnvelope, peers[1]!.futureEnvelope);
          const history = yield* historyState(dbPath);
          const delta = JSON.parse(
            history.revisions.find(
              (row) => row.page_id === destination.id && row.mutation_id === "multi-gap",
            )!.payload,
          );
          assert.equal(delta.blocksBefore.length, 4);
        }),
      ),
  );

  it.effect(
    "bounds moved list depth and exact UTF8 work bytes before changing any ownership or body",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "depth-destination",
          );
          const list = { ...block("depth-moving"), type: "bulleted_item" };
          const leaf = block("depth-moving-leaf", 1, list.id);
          yield* service.applyBlockBatch(
            request(
              "depth-source",
              0,
              [list, leaf].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const ancestors = Array.from({ length: 15 }, (_, i) => ({
            ...block(
              `dest-ancestor-${i}`,
              1,
              i === 0 ? null : C.SpaceBlockId.make(`dest-ancestor-${i - 1}`),
            ),
            type: "bulleted_item",
          }));
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "depth-dest-seed",
            pageId: destination.id,
            baseRevision: 0,
            generation: 0,
            mutations: ancestors.map((value) => ({ kind: "insert", block: value })),
          });
          const placement = {
            pageId: destination.id,
            parentId: ancestors[14]!.id,
            beforeBlockId: null,
          };
          const before = yield* structureState(dbPath);
          const over = {
            ...common,
            mutationId: "depth-over",
            sourcePageId: page.id,
            blockIds: [list.id],
            destination: placement,
            guards: { pages: [], roots: [] },
          };
          const error = yield* Effect.flip(service.moveBlocks(over));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") {
            assert.equal(error.limit, "maxDepth");
            assert.equal(error.actual, 17);
          }
          assert.deepEqual(yield* structureState(dbPath), before);
          const atLimit = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [list.id],
            { ...placement, parentId: ancestors[13]!.id },
            "depth-at-limit",
          );
          assert.equal((yield* service.moveBlocks(atLimit)).status, "saved");
          const wide = Array.from({ length: 5 }, (_, i) => {
            const value = {
              ...block(`wide-moving-${i}`, i + 1),
              type: "code",
              content: { language: "", text: "" },
            };
            return {
              ...value,
              content: { language: "", text: "界".repeat(Math.floor((32768 - bytes(value)) / 3)) },
            };
          });
          yield* service.applyBlockBatch(
            request(
              "wide-seed",
              2,
              wide.map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const inspection = yield* service.inspectStructure({
            ...env,
            target: { kind: "blocks", pageId: page.id, blockIds: wide.map((value) => value.id) },
            destination: {
              kind: "child",
              placement: { pageId: destination.id, parentId: null, beforeBlockId: null },
            },
          });
          const state = yield* structureState(dbPath);
          const refused = yield* Effect.flip(
            service.moveBlocks({
              ...common,
              mutationId: "wide-write",
              sourcePageId: page.id,
              blockIds: wide.map((value) => value.id),
              destination: { pageId: destination.id, parentId: null, beforeBlockId: null },
              guards: inspection.guards,
            }),
          );
          assert.equal(refused._tag, "SpaceLimitExceededError");
          if (refused._tag === "SpaceLimitExceededError")
            assert.equal(refused.limit, "maxMutationBytes");
          assert.deepEqual(yield* structureState(dbPath), state);
        }),
      ),
  );

  it.effect(
    "moves disjoint block roots and their owned pages across spaces while preserving opaque data and pins",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, request } = yield* boot();
          const createdSpace = yield* service.createSpace({
            ...common,
            mutationId: "blocks-space",
            title: "Elsewhere",
          });
          if (createdSpace.status !== "saved") return yield* Effect.die("Expected space");
          const destination = yield* rootPage(
            service,
            common,
            createdSpace.space.id,
            "blocks-dest",
          );
          const container = { ...block("move-list"), type: "bulleted_item" };
          const leaf = { ...block("move-leaf", 1, container.id), extra: { keep: ["界", 7] } };
          const tail = block("move-tail", 2);
          yield* service.applyBlockBatch(
            request(
              "move-seed",
              0,
              [container, leaf, tail].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const owned = yield* childPage(
            service,
            common,
            page.id,
            "blocks-owned",
            null,
            container.id,
          );
          const grandchild = yield* childPage(service, common, owned.page.id, "blocks-grandchild");
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [old] =
              yield* sql`SELECT logical_bytes FROM spaces_blocks WHERE block_id=${leaf.id}`;
            const payload = JSON.stringify({
              ...leaf,
              type: "image",
              content: { assetId: "legacy-asset", caption: [{ text: "旧图", marks: [] }] },
              futureEnvelope: { preserve: true },
            });
            yield* sql`UPDATE spaces_blocks SET payload=${payload},logical_bytes=${Buffer.byteLength(payload, "utf8")} WHERE block_id=${leaf.id}`;
            yield* sql`UPDATE spaces_pages SET block_bytes=block_bytes+${Buffer.byteLength(payload, "utf8") - Number(old!.logical_bytes)} WHERE page_id=${page.id}`;
            yield* sql`INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (${leaf.id},'legacy-asset')`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const original = yield* structureState(dbPath);
          const placement = { pageId: destination.id, parentId: null, beforeBlockId: null };
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [container.id, tail.id],
            placement,
            "blocks-cross-space",
          );
          assert.isTrue(input.guards.pages.some((guard) => guard.pageId === grandchild.page.id));
          assert.equal(input.guards.roots.length, 2);
          const moved = yield* service.moveBlocks(input);
          if (moved.status !== "saved") return yield* Effect.die("Expected moved blocks");
          assert.deepEqual(moved.blockIds, [container.id, tail.id]);
          assert.equal(moved.changed.pages.length, 4);
          assert.deepEqual(moved.changed.roots, []);
          assert.deepEqual(yield* service.moveBlocks(input), moved);
          assert.equal(
            (yield* service.getPage({ ...env, pageId: grandchild.page.id })).page.spaceId,
            createdSpace.space.id,
          );
          const ownedNow = (yield* service.getPage({ ...env, pageId: owned.page.id })).page;
          assert.deepEqual(ownedNow.location, {
            kind: "child",
            spaceId: createdSpace.space.id,
            ownerBlockId: owned.ownerBlockId,
            parentPageId: destination.id,
          });
          const current = yield* structureState(dbPath);
          assert.deepEqual(current.ids, original.ids);
          assert.deepEqual(current.owners, original.owners);
          assert.deepEqual(current.blockPins, original.blockPins);
          const oldLeaf = original.blocks.find((row) => row.block_id === leaf.id)!;
          assert.equal(
            current.blocks.find((row) => row.block_id === leaf.id)!.payload,
            oldLeaf.payload,
          );
          assert.equal(
            current.blocks.find((row) => row.block_id === leaf.id)!.page_id,
            destination.id,
          );
          assert.deepEqual(
            current.pages.filter((row) => row.page_id === page.id).map((row) => row.block_count),
            [0],
          );
          const delta = current.history.filter((row) => row.mutation_id === input.mutationId);
          assert.equal(delta.length, 4);
          for (const id of [page.id, destination.id]) {
            const revision = delta.find((row) => row.page_id === id)!;
            assert.isTrue(
              current.revisionPins.some(
                (pin) =>
                  pin.page_id === id &&
                  pin.to_revision === revision.to_revision &&
                  pin.asset_id === "legacy-asset",
              ),
            );
            const preimage = JSON.parse(String(revision.payload));
            assert.deepEqual(
              preimage.blocksBefore.find((row: { id: string }) => row.id === leaf.id).row.payload,
              oldLeaf.payload,
            );
          }
          const unchanged = yield* historyState(dbPath);
          const noop = yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              destination.id,
              [container.id, tail.id],
              placement,
              "blocks-noop",
            ),
          );
          if (noop.status !== "saved") return yield* Effect.die("Expected no-op");
          assert.deepEqual(noop.changed, { pages: [], roots: [] });
          assert.deepEqual(yield* historyState(dbPath), unchanged);
          const reordered = yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              destination.id,
              [tail.id],
              { ...placement, beforeBlockId: container.id },
              "blocks-reorder",
            ),
          );
          assert.equal(reordered.status, "saved");
          const window = yield* service.readBlocks({
            ...env,
            pageId: destination.id,
            revision: (yield* service.getPage({ ...env, pageId: destination.id })).page.revision,
          });
          assert.deepEqual(
            window.blocks.map((value) => value.id),
            [tail.id, container.id, leaf.id, owned.ownerBlockId],
          );
          const resolved = yield* service.resolveReference({
            ...env,
            target: { kind: "block", blockId: leaf.id },
            pageIdHint: page.id,
            spaceIdHint: C.SpaceId.make("stale-space"),
          });
          assert.equal(resolved.status, "resolved");
          if (resolved.status === "resolved") assert.equal(resolved.page.id, destination.id);
        }),
      ),
  );

  it.effect(
    "rejects overlapping selections, cycles, stale or missing block-move guards and complete closure overflow atomically",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "guard-block-dest",
          );
          const parent = { ...block("guard-list"), type: "bulleted_item" };
          const child = block("guard-leaf", 1, parent.id);
          yield* service.applyBlockBatch(
            request(
              "guard-list-seed",
              0,
              [parent, child].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const owned = yield* childPage(
            service,
            common,
            page.id,
            "guard-block-owned",
            null,
            parent.id,
          );
          const destinationPlacement = {
            pageId: destination.id,
            parentId: null,
            beforeBlockId: null,
          };
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [parent.id],
            destinationPlacement,
            "block-stale",
          );
          yield* service.updatePage({
            ...common,
            mutationId: "block-dest-edit",
            pageId: destination.id,
            baseRevision: 0,
            title: "Edited",
          });
          const history = yield* historyState(dbPath);
          assert.equal((yield* service.moveBlocks(input)).status, "conflict");
          const fresh = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [parent.id],
            destinationPlacement,
            "block-missing",
          );
          assert.equal(
            (yield* service.moveBlocks({
              ...fresh,
              guards: {
                ...fresh.guards,
                pages: fresh.guards.pages.filter((guard) => guard.pageId !== owned.page.id),
              },
            })).status,
            "conflict",
          );
          assert.deepEqual(yield* historyState(dbPath), history);
          for (const value of [
            {
              ...fresh,
              mutationId: "block-duplicates",
              guards: { ...fresh.guards, pages: [...fresh.guards.pages, fresh.guards.pages[0]!] },
            },
            { ...fresh, mutationId: "block-overlap", blockIds: [parent.id, child.id] },
            { ...fresh, mutationId: "block-repeat", blockIds: [parent.id, parent.id] },
            {
              ...fresh,
              mutationId: "block-list-cycle",
              destination: { pageId: page.id, parentId: parent.id, beforeBlockId: null },
            },
            {
              ...fresh,
              mutationId: "block-page-cycle",
              destination: { pageId: owned.page.id, parentId: null, beforeBlockId: null },
            },
          ]) {
            const before = yield* structureState(dbPath);
            assert.equal(
              (yield* Effect.flip(service.moveBlocks(value)))._tag,
              "SpaceValidationError",
            );
            assert.deepEqual(yield* structureState(dbPath), before);
          }
          const packed = { ...block("packed-root", 3), type: "bulleted_item" };
          const packedChildren = Array.from({ length: 96 }, (_, i) =>
            block(`packed-child-${i}`, i + 1, packed.id),
          );
          yield* service.applyBlockBatch(
            request(
              "packed-seed",
              2,
              [packed, ...packedChildren].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          const atLimit = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [packed.id],
            destinationPlacement,
            "packed-100",
          );
          assert.equal((yield* service.moveBlocks(atLimit)).status, "saved");
          const emptyDestination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "packed-empty",
          );
          const back = yield* blockMoveIntent(
            service,
            common,
            destination.id,
            [packed.id],
            { pageId: emptyDestination.id, parentId: null, beforeBlockId: null },
            "packed-101",
          );
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "packed-extra",
            pageId: destination.id,
            baseRevision: (yield* service.getPage({ ...env, pageId: destination.id })).page
              .revision,
            generation: 0,
            mutations: [{ kind: "insert", block: block("packed-extra-leaf", 97, packed.id) }],
          });
          const before = yield* structureState(dbPath);
          const error = yield* Effect.flip(service.moveBlocks(back));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") {
            assert.equal(error.limit, "maxMutationNodes");
            assert.equal(error.actual, 101);
          }
          assert.deepEqual(yield* structureState(dbPath), before);
        }),
      ),
  );

  it.effect(
    "resolves stable merged identities after moves, further joins and final deletion without resurrecting bodies",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library, request } = yield* boot();
          const destination = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "reference-dest",
          );
          const [a, b, c] = [block("ref-a"), block("ref-b", 2), block("ref-c", 3)] as const;
          yield* service.applyBlockBatch(
            request(
              "refs-seed",
              0,
              [a, b, c].map((value) => ({ kind: "insert", block: value })),
            ),
          );
          yield* service.applyBlockBatch(
            request("refs-join", 1, [{ kind: "delete", blockId: a.id, mergedInto: b.id }]),
          );
          const input = yield* blockMoveIntent(
            service,
            common,
            page.id,
            [b.id, c.id],
            { pageId: destination.id, parentId: null, beforeBlockId: null },
            "refs-move",
          );
          assert.equal((yield* service.moveBlocks(input)).status, "saved");
          const resolve = () =>
            service.resolveReference({
              ...env,
              target: { kind: "block", blockId: a.id },
              pageIdHint: page.id,
            });
          const first = yield* resolve();
          assert.equal(first.status, "merged");
          if (first.status === "merged") {
            assert.equal(first.blockId, b.id);
            assert.equal(first.requestedBlockId, a.id);
            assert.equal(first.page.id, destination.id);
          }
          yield* service.applyBlockBatch({
            ...common,
            mutationId: "refs-second-join",
            pageId: destination.id,
            baseRevision: 1,
            generation: 0,
            mutations: [{ kind: "delete", blockId: b.id, mergedInto: c.id }],
          });
          const second = yield* resolve();
          assert.equal(second.status, "merged");
          if (second.status === "merged") assert.equal(second.blockId, c.id);
          yield* service.moveBlocks(
            yield* blockMoveIntent(
              service,
              common,
              destination.id,
              [c.id],
              { pageId: page.id, parentId: null, beforeBlockId: null },
              "refs-return",
            ),
          );
          const moved = yield* resolve();
          if (moved.status !== "merged") return yield* Effect.die("Expected merged target");
          assert.equal(moved.page.id, page.id);
          yield* service.applyBlockBatch(
            request("refs-final-delete", 4, [{ kind: "delete", blockId: c.id }]),
          );
          assert.deepEqual(yield* resolve(), { status: "deleted" });
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepEqual(
              yield* sql`SELECT * FROM spaces_blocks WHERE block_id IN ('ref-a','ref-b','ref-c')`,
              [],
            );
            const ids =
              yield* sql`SELECT id,deleted,merged_into FROM spaces_ids WHERE id IN ('ref-a','ref-b','ref-c') ORDER BY id`;
            assert.deepEqual(ids, [
              { id: a.id, deleted: 1, merged_into: c.id },
              { id: b.id, deleted: 1, merged_into: c.id },
              { id: c.id, deleted: 1, merged_into: null },
            ]);
            assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
            assert.equal(
              (yield* sql`SELECT block_count,block_bytes FROM spaces_pages WHERE page_id=${page.id}`)[0]
                ?.block_count,
              0,
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          assert.equal(
            (yield* Effect.flip(
              service.applyBlockBatch(request("refs-reuse", 5, [{ kind: "insert", block: a }])),
            ))._tag,
            "SpaceValidationError",
          );
          assert.deepEqual(
            yield* service.resolveReference({
              ...env,
              target: { kind: "block", blockId: C.SpaceBlockId.make("never-known") },
            }),
            { status: "unavailable" },
          );
          const pageReference = yield* service.resolveReference({
            ...env,
            target: { kind: "page", pageId: destination.id },
            pageIdHint: page.id,
          });
          assert.equal(pageReference.status, "resolved");
          if (pageReference.status === "resolved")
            assert.equal(pageReference.page.id, destination.id);
        }),
      ),
  );
});
