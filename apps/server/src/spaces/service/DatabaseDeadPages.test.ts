import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { block, boot, childPage, env, fixture, recoveryIntent } from "./Spaces.testkit.ts";
import { databaseKit, validationReason, warmSearch } from "./Databases.testkit.ts";

it.layer(NodeServices.layer)("Spaces pages inside dead databases", (it) => {
  it.effect("hides rows and their sub-pages everywhere while the database is dead", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Hosted", { appendToPageId: page.id });
        const [row, trashedRow] = (yield* kit.addRows(created.dataSourceId, [
          { title: "needle row" },
          { title: "needle trashed row" },
        ])).rows.map((entry) => entry.pageId);
        const sub = (yield* childPage(service, common, row!, "needle sub")).page.id;
        yield* service.trashPage(
          yield* recoveryIntent(service, common, trashedRow!, "trash", "trash-row"),
        );
        for (const pageId of [row!, sub]) {
          yield* service.addPin({ ...env, pageId });
          yield* service.recordRecent({ ...env, pageId });
        }
        yield* warmSearch(service);

        const surfaces = Effect.fn("DeadPages.surfaces")(function* () {
          const ids = (items: readonly { readonly page: { readonly id: string } }[]) =>
            items.map((item) => item.page.id);
          return {
            pins: ids((yield* service.listPins(env)).items),
            recents: ids((yield* service.listRecents(env)).items),
            all: ids((yield* service.listAllPages(env)).items),
            search: ids((yield* service.search({ ...env, query: "needle" })).items),
            trash: (yield* service.listTrash(env)).items.map((item) => item.pageId as string),
          };
        });
        const alive = yield* surfaces();
        assert.includeMembers(alive.pins, [row!, sub]);
        assert.includeMembers(alive.recents, [row!, sub]);
        assert.include(alive.all, sub);
        assert.includeMembers(alive.search, [row!, sub]);
        assert.include(alive.trash, trashedRow!);
        assert.equal(
          (yield* service.listPages({ ...env, spaceId: page.spaceId, parentPageId: row! }))
            .items[0]!.id,
          sub,
        );

        const host = yield* service.getPage({ ...env, pageId: page.id });
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "drop-home",
          pageId: page.id,
          baseRevision: host.page.revision,
          generation: 0,
          mutations: [{ kind: "delete", blockId: created.block!.blockId }],
        });
        const dead = yield* surfaces();
        for (const [name, listed] of Object.entries(dead))
          for (const hidden of [row!, sub, trashedRow!])
            assert.notInclude(listed, hidden, `${name} lists ${hidden}`);
        assert.equal(
          yield* validationReason(
            service.listPages({ ...env, spaceId: page.spaceId, parentPageId: row! }),
          ),
          "trashed",
        );
        assert.equal(yield* validationReason(service.getPage({ ...env, pageId: sub })), "trashed");

        // Adopting the database again brings everything back.
        const reborn = yield* service.getPage({ ...env, pageId: page.id });
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "restore-home",
          pageId: page.id,
          baseRevision: reborn.page.revision,
          generation: 0,
          mutations: [
            {
              kind: "insert",
              block: {
                ...block("restored-home", 90),
                type: "database",
                content: { databaseId: created.databaseId, viewIds: [created.viewId] },
              } as C.SpaceBlock,
            },
          ],
        });
        const revived = yield* surfaces();
        assert.includeMembers(revived.pins, [row!, sub]);
        assert.includeMembers(revived.recents, [row!, sub]);
        assert.include(revived.all, sub);
        assert.includeMembers(revived.search, [row!, sub]);
        assert.include(revived.trash, trashedRow!);
      }),
    ),
  );

  it.effect("refuses writes to a row of a dead database but lets the host page re-adopt it", () =>
    fixture(() =>
      Effect.gen(function* () {
        const { service, common, page } = yield* boot();
        const kit = databaseKit(service, common, page.spaceId);
        const created = yield* kit.create("Hosted", { appendToPageId: page.id });
        const row = (yield* kit.addRows(created.dataSourceId, [{ title: "row" }])).rows[0]!.pageId;
        const sub = (yield* childPage(service, common, row, "sub")).page.id;
        const host = yield* service.getPage({ ...env, pageId: page.id });
        yield* service.applyBlockBatch({
          ...common,
          mutationId: "drop-home",
          pageId: page.id,
          baseRevision: host.page.revision,
          generation: 0,
          mutations: [{ kind: "delete", blockId: created.block!.blockId }],
        });
        for (const pageId of [row, sub]) {
          assert.equal(
            yield* validationReason(
              service.updatePage({
                ...common,
                mutationId: `rename-${pageId}`,
                pageId,
                baseRevision: 0,
                title: "renamed",
              }),
            ),
            "trashed",
          );
          assert.equal(
            yield* validationReason(
              service.applyBlockBatch({
                ...common,
                mutationId: `body-${pageId}`,
                pageId,
                baseRevision: 0,
                generation: 0,
                mutations: [{ kind: "insert", block: block(`body-${pageId}`, 1) }],
              }),
            ),
            "trashed",
          );
        }
        const reborn = yield* service.getPage({ ...env, pageId: page.id });
        const saved = yield* service.applyBlockBatch({
          ...common,
          mutationId: "re-adopt",
          pageId: page.id,
          baseRevision: reborn.page.revision,
          generation: 0,
          mutations: [
            {
              kind: "insert",
              block: {
                ...block("again", 90),
                type: "database",
                content: { databaseId: created.databaseId, viewIds: [] },
              } as C.SpaceBlock,
            },
          ],
        });
        assert.equal(saved.status, "saved");
        assert.equal(
          (yield* service.updatePage({
            ...common,
            mutationId: "rename-after",
            pageId: row,
            baseRevision: 0,
            title: "renamed",
          })).status,
          "saved",
        );
      }),
    ),
  );
});
