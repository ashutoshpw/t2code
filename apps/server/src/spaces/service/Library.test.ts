import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  env,
  block,
  fixture,
  boot,
  childPage,
  rootPage,
  recoveryIntent,
} from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect("keeps list cursors valid across title and block edits", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page, request } = yield* boot();
        yield* rootPage(service, common, page.spaceId, "cursor-second");
        yield* rootPage(service, common, page.spaceId, "cursor-third");
        const first = yield* service.listPages({ ...env, spaceId: page.spaceId, limit: 1 });
        assert.isNotNull(first.nextCursor);
        yield* service.applyBlockBatch(
          request("edit-while-paging", 0, [{ kind: "insert", block: block("paging", 1) }]),
        );
        yield* service.updatePage({
          ...common,
          mutationId: "rename-while-paging",
          pageId: page.id,
          baseRevision: 1,
          title: "Renamed",
        });
        const next = yield* service.listPages({
          ...env,
          spaceId: page.spaceId,
          limit: 1,
          cursor: first.nextCursor!,
        });
        assert.lengthOf(next.items, 1);
      }),
    ),
  );

  it.effect("isolates pin and recent cursor revisions", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const other = yield* rootPage(service, common, page.spaceId, "cursor-other");
        const third = yield* rootPage(service, common, page.spaceId, "cursor-third");
        const target = { ...env, pageId: page.id };
        const otherTarget = { ...env, pageId: other.id };
        yield* service.addPin(target);
        yield* service.addPin(otherTarget);
        yield* service.recordRecent(target);
        yield* service.recordRecent(otherTarget);
        const pins = yield* service.listPins({ ...env, limit: 1 });
        const recents = yield* service.listRecents({ ...env, limit: 1 });
        yield* service.addPin(target);
        yield* service.removePin({ ...env, pageId: third.id });
        yield* service.listPins({ ...env, limit: 1, cursor: pins.nextCursor! });
        yield* service.recordRecent(target);
        assert.equal(
          (yield* service.listPins({ ...env, limit: 1, cursor: pins.nextCursor! })).items[0]?.page
            .id,
          page.id,
        );
        assert.equal(
          (yield* Effect.flip(
            service.listRecents({ ...env, limit: 1, cursor: recents.nextCursor! }),
          ))._tag,
          "SpaceCursorStaleError",
        );
        const freshRecents = yield* service.listRecents({ ...env, limit: 1 });
        yield* service.addPin({ ...env, pageId: third.id });
        assert.equal(
          (yield* Effect.flip(service.listPins({ ...env, limit: 1, cursor: pins.nextCursor! })))
            ._tag,
          "SpaceCursorStaleError",
        );
        assert.equal(
          (yield* service.listRecents({ ...env, limit: 1, cursor: freshRecents.nextCursor! }))
            .items[0]?.page.id,
          other.id,
        );
      }),
    ),
  );

  it.effect("bounds recents and moves a revisited page to the front", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        yield* service.recordRecent({ ...env, pageId: page.id });
        for (let i = 0; i < 50; i++) {
          const next = yield* rootPage(service, common, page.spaceId, `recent-${i}`);
          yield* service.recordRecent({ ...env, pageId: next.id });
        }
        const before = yield* service.listRecents({ ...env, limit: 50 });
        assert.lengthOf(before.items, 50);
        assert.isFalse(before.items.some((item) => item.page.id === page.id));
        yield* service.recordRecent({ ...env, pageId: page.id });
        const after = yield* service.listRecents({ ...env, limit: 50 });
        assert.lengthOf(after.items, 50);
        assert.equal(after.items[0]?.page.id, page.id);
        assert.isNull(after.nextCursor);
      }),
    ),
  );

  it.effect("persists pins and deduplicated recents across trash, restore and purge", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const other = yield* rootPage(service, common, page.spaceId, "library-other");
        const target = { ...env, pageId: page.id };
        yield* service.addPin(target);
        assert.isTrue((yield* service.getPage(target)).page.isPinned);
        assert.isTrue(
          (yield* service.listAllPages(env)).items.find((item) => item.page.id === page.id)?.page
            .isPinned,
        );
        assert.isTrue(
          (yield* service.listPages({ ...env, spaceId: page.spaceId })).items.find(
            (item) => item.id === page.id,
          )?.isPinned,
        );
        yield* service.addPin(target);
        yield* service.addPin({ ...env, pageId: other.id });
        yield* service.recordRecent(target);
        yield* service.recordRecent({ ...env, pageId: other.id });
        yield* service.recordRecent(target);
        assert.deepEqual(
          (yield* service.listRecents(env)).items.map((item) => item.page.id),
          [page.id, other.id],
        );
        const first = yield* service.listPins({ ...env, limit: 1 });
        assert.deepEqual(
          first.items.map((item) => item.page.id),
          [other.id],
        );
        const second = yield* service.listPins({ ...env, limit: 1, cursor: first.nextCursor! });
        assert.deepEqual(
          second.items.map((item) => item.page.id),
          [page.id],
        );
        yield* service.trashPage(
          yield* recoveryIntent(service, common, page.id, "trash", "library-trash"),
        );
        assert.deepEqual(
          (yield* service.listPins(env)).items.map((item) => item.page.id),
          [other.id],
        );
        assert.deepEqual(
          (yield* service.listRecents(env)).items.map((item) => item.page.id),
          [other.id],
        );
        yield* service.restorePage(
          yield* recoveryIntent(service, common, page.id, "restore", "library-restore"),
        );
        assert.lengthOf((yield* service.listPins(env)).items, 2);
        yield* service.removePin({ ...env, pageId: other.id });
        yield* service.trashPage(
          yield* recoveryIntent(service, common, page.id, "trash", "library-trash-again"),
        );
        yield* service.permanentlyDeletePage(
          yield* recoveryIntent(service, common, page.id, "permanentlyDelete", "library-purge"),
        );
        const counts = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly count: number;
          }>`SELECT (SELECT count(*) FROM spaces_pins) + (SELECT count(*) FROM spaces_recents WHERE page_id=${page.id}) AS count`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        assert.equal(counts[0]?.count, 0);
      }),
    ),
  );

  it.effect("lists active pages across spaces with revision-bound cursors", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const other = yield* service.createSpace({
          ...common,
          mutationId: "all-space",
          title: "Other",
        });
        const second = yield* rootPage(service, common, other.space.id, "all-second");
        const child = yield* childPage(service, common, page.id, "all-child");
        assert.isTrue(
          (yield* service.listAllPages(env)).items.find((item) => item.page.id === page.id)?.page
            .hasChildren,
        );
        yield* service.trashPage(
          yield* recoveryIntent(service, common, child.page.id, "trash", "all-trash"),
        );
        const first = yield* service.listAllPages({ ...env, limit: 1 });
        assert.lengthOf(first.items, 1);
        assert.isNotNull(first.nextCursor);
        const next = yield* service.listAllPages({ ...env, limit: 1, cursor: first.nextCursor! });
        assert.deepEqual(
          new Set([...first.items, ...next.items].map((item) => item.page.id)),
          new Set([page.id, second.id]),
        );
        assert.equal(
          [...first.items, ...next.items].find((item) => item.page.id === second.id)?.spaceTitle,
          "Other",
        );
        assert.isNull(next.nextCursor);
        assert.isFalse(
          [...first.items, ...next.items].find((item) => item.page.id === page.id)?.page
            .hasChildren,
        );
        const wrong = yield* Effect.flip(
          service.listPages({ ...env, spaceId: page.spaceId, cursor: first.nextCursor! }),
        );
        assert.equal(wrong._tag, "SpaceValidationError");
        yield* rootPage(service, common, other.space.id, "all-new");
        const stale = yield* Effect.flip(
          service.listAllPages({ ...env, cursor: first.nextCursor! }),
        );
        assert.equal(stale._tag, "SpaceCursorStaleError");
      }),
    ),
  );

  it.effect(
    "bounds child owner candidates before trash filtering and advances tied-rank cursors through empty pages",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page, library } = yield* boot();
          const other = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "paging-other-parent",
          );
          const children: Effect.Success<ReturnType<typeof childPage>>[] = [];
          for (let i = 0; i < 5; i++)
            children.push(yield* childPage(service, common, page.id, `paging-child-${i}`));
          const ordered = children.toSorted((a, b) =>
            a.ownerBlockId < b.ownerBlockId ? -1 : a.ownerBlockId > b.ownerBlockId ? 1 : 0,
          );
          const rank = "00000000000000000000000000000001";
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE spaces_blocks SET rank=${rank},payload=json_set(payload,'$.order',${rank}) WHERE page_id=${page.id} AND deleted=0 AND json_extract(payload,'$.type')='child_page'`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          for (const child of ordered.slice(0, 3))
            yield* service.trashPage(
              yield* recoveryIntent(
                service,
                common,
                child.page.id,
                "trash",
                `paging-trash-${child.page.id}`,
              ),
            );
          const input = {
            ...env,
            spaceId: library.defaultSpaceId,
            parentPageId: page.id,
            limit: 1,
          };
          const first = yield* service.listPages(input);
          assert.deepEqual(first.items, []);
          assert.isNotNull(first.nextCursor);
          const wrongParent = yield* Effect.flip(
            service.listPages({ ...input, parentPageId: other.id, cursor: first.nextCursor! }),
          );
          assert.equal(wrongParent._tag, "SpaceValidationError");
          if (wrongParent._tag === "SpaceValidationError")
            assert.equal(wrongParent.reason, "invalid_cursor");
          const cursors = new Set([first.nextCursor]);
          const visible: C.SpacePageId[] = [];
          let cursor: C.SpaceCursor | null = first.nextCursor;
          for (let i = 1; i < ordered.length; i++) {
            const next: C.SpacePageListResult = yield* service.listPages({
              ...input,
              cursor: cursor!,
            });
            assert.deepEqual(
              next.items.map((row) => row.id),
              i < 3 ? [] : [ordered[i]!.page.id],
            );
            visible.push(...next.items.map((row) => row.id));
            if (i < ordered.length - 1) {
              assert.isNotNull(next.nextCursor);
              assert.isFalse(cursors.has(next.nextCursor));
              cursors.add(next.nextCursor);
            } else assert.isNull(next.nextCursor);
            cursor = next.nextCursor;
          }
          assert.deepEqual(
            visible,
            ordered.slice(3).map((row) => row.page.id),
          );
        }),
      ),
  );
});
