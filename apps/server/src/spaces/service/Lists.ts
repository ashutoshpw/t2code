import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import { byteLength, canonical, ensureLimit, limits } from "../CorePolicy.ts";
import * as Liveness from "../databases/Liveness.ts";
import * as PageStore from "../PageStore.ts";
import * as SpacesSql from "../SpacesSql.ts";
import {
  type SpaceRow,
  type PageRow,
  type PageListCandidate,
  spaceSummary,
  pageSummary,
  decodeTrashList,
  decodeList,
  decodePages,
  decodeGet,
  isServiceError,
  validateRaw,
  cursorFor,
  cursorFrom,
  checkIds,
  getSpace,
  getPageRow,
  defaultSpace,
} from "./Helpers.ts";
import type { Runtime } from "./Runtime.ts";

export const make = (rt: Runtime) => {
  const { admit, checkEnvironment, run, read, readWithAdmission } = rt;
  const listSpaces = Effect.fn("SpacesService.listSpaces")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeList),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (meta, admission) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* checkIds(input);
        const limit = input.limit ?? limits.maxListRows;
        yield* ensureLimit("maxListRows", limit);
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "listSpaces",
          "",
          meta.catalog_revision,
        );
        const rows = cursor
          ? yield* sql<SpaceRow>`SELECT * FROM spaces WHERE (created_at, space_id) > (${cursor.key}, ${cursor.id}) ORDER BY created_at, space_id LIMIT ${limit + 1}`
          : yield* sql<SpaceRow>`SELECT * FROM spaces ORDER BY created_at, space_id LIMIT ${limit + 1}`;
        const def = yield* defaultSpace();
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceListResult = {
            items: rows.slice(0, take).map(spaceSummary),
            defaultSpaceId: def.space_id,
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? yield* cursorFor(
                    environmentId,
                    "listSpaces",
                    "",
                    meta.catalog_revision,
                    last.created_at,
                    last.space_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) {
            yield* ensureLimit("maxListResponseBytes", size);
          }
          take--;
        }
      }),
    );
  });
  const mutateLibrary = Effect.fn("SpacesService.mutateLibrary")(function* (
    raw: unknown,
    operation: "add" | "remove" | "record",
  ) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeGet),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* run(environmentId, () =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* checkIds(input);
        yield* PageStore.assertActive(yield* getPageRow(input.pageId));
        if (operation === "add") {
          const existing = yield* sql`SELECT 1 FROM spaces_pins WHERE page_id=${input.pageId}`;
          if (existing.length) return {};
        }
        if (operation === "remove") {
          const existing = yield* sql`SELECT 1 FROM spaces_pins WHERE page_id=${input.pageId}`;
          if (!existing.length) return {};
        }
        if (operation === "record")
          yield* sql`UPDATE spaces_library_sequence SET sequence=sequence+1, recents_revision=recents_revision+1 WHERE singleton=1`;
        else
          yield* sql`UPDATE spaces_library_sequence SET sequence=sequence+1, pins_revision=pins_revision+1 WHERE singleton=1`;
        const [state] = yield* sql<{
          readonly sequence: number;
        }>`SELECT sequence FROM spaces_library_sequence WHERE singleton=1`;
        if (!state) return yield* new C.SpacesUnavailableError({ stage: "storage" });
        if (operation === "add")
          yield* sql`INSERT INTO spaces_pins(page_id,sequence) VALUES (${input.pageId},${state.sequence})`;
        else if (operation === "remove")
          yield* sql`DELETE FROM spaces_pins WHERE page_id=${input.pageId}`;
        else {
          yield* sql`INSERT INTO spaces_recents(page_id,sequence) VALUES (${input.pageId},${state.sequence}) ON CONFLICT(page_id) DO UPDATE SET sequence=excluded.sequence`;
          yield* sql`DELETE FROM spaces_recents WHERE page_id IN (SELECT page_id FROM spaces_recents ORDER BY sequence DESC,page_id LIMIT -1 OFFSET 50)`;
        }
        return {};
      }),
    );
  });
  const addPin = Effect.fn("SpacesService.addPin")((input: unknown) => mutateLibrary(input, "add"));
  const removePin = Effect.fn("SpacesService.removePin")((input: unknown) =>
    mutateLibrary(input, "remove"),
  );
  const recordRecent = Effect.fn("SpacesService.recordRecent")((input: unknown) =>
    mutateLibrary(input, "record"),
  );
  const listLibrary = Effect.fn("SpacesService.listLibrary")(function* (
    raw: unknown,
    kind: "pins" | "recents",
  ) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeList),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* read(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const limit = input.limit ?? limits.maxListRows;
        yield* ensureLimit("maxListRows", limit);
        const [state] = yield* sql<{
          readonly pins_revision: number;
          readonly recents_revision: number;
        }>`SELECT pins_revision, recents_revision FROM spaces_library_sequence WHERE singleton=1`;
        if (!state) return yield* new C.SpacesUnavailableError({ stage: "storage" });
        const filter = String(kind === "pins" ? state.pins_revision : state.recents_revision);
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          `listLibrary:${kind}`,
          filter,
          meta.catalog_revision,
          true,
        );
        const sequence = cursor ? Number(cursor.key) : 0;
        if (cursor && (!Number.isSafeInteger(sequence) || String(sequence) !== cursor.key))
          return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
        const after = cursor
          ? sql`AND (l.sequence < ${sequence} OR (l.sequence = ${sequence} AND l.page_id > ${cursor.id}))`
          : sql``;
        const table = kind === "pins" ? sql`spaces_pins` : sql`spaces_recents`;
        const rows = yield* sql<
          PageRow & { readonly space_title: string; readonly sequence: number }
        >`SELECT p.*,s.title AS space_title,l.sequence, EXISTS(SELECT 1 FROM spaces_pins pin WHERE pin.page_id=p.page_id) AS is_pinned,
        o.owner_block_id,b.page_id AS parent_page_id,b.deleted AS owner_deleted,parent.space_id AS parent_space_id,json_extract(b.payload,'$.type') AS owner_type
        FROM ${table} l JOIN spaces_pages p ON p.page_id=l.page_id JOIN spaces s ON s.space_id=p.space_id
        LEFT JOIN spaces_page_owners o ON o.child_page_id=p.page_id LEFT JOIN spaces_blocks b ON b.block_id=o.owner_block_id
        LEFT JOIN spaces_pages parent ON parent.page_id=b.page_id WHERE p.trash_batch_id IS NULL ${after}
        ORDER BY l.sequence DESC,l.page_id LIMIT ${limit + 1}`;
        // Pages inside a dead database are not reachable, so they drop out of the window.
        const dead = new Set<string>();
        for (const row of rows)
          if (row.root_order === null && !(yield* Liveness.pageLive(row.page_id)))
            dead.add(row.page_id);
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceAllPagesResult = {
            items: rows
              .slice(0, take)
              .filter((row) => !dead.has(row.page_id))
              .map((row) => ({ page: pageSummary(row), spaceTitle: row.space_title })),
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? yield* cursorFor(
                    environmentId,
                    `listLibrary:${kind}`,
                    filter,
                    meta.catalog_revision,
                    String(last.sequence),
                    last.page_id,
                  )
                : null,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) yield* ensureLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  const listPins = Effect.fn("SpacesService.listPins")((input: unknown) =>
    listLibrary(input, "pins"),
  );
  const listRecents = Effect.fn("SpacesService.listRecents")((input: unknown) =>
    listLibrary(input, "recents"),
  );
  const listAllPages = Effect.fn("SpacesService.listAllPages")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeList),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* read(environmentId, (meta) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* checkIds(input);
        const limit = input.limit ?? limits.maxListRows;
        yield* ensureLimit("maxListRows", limit);
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "listAllPages",
          "",
          meta.catalog_revision,
        );
        const after = cursor
          ? sql`AND (p.updated_at < ${cursor.key} OR (p.updated_at = ${cursor.key} AND p.page_id > ${cursor.id}))`
          : sql``;
        const rows = yield* sql<
          PageRow & { readonly space_title: string; readonly has_children: number }
        >`SELECT p.*, s.title AS space_title, EXISTS(SELECT 1 FROM spaces_pins pin WHERE pin.page_id=p.page_id) AS is_pinned,
        EXISTS(SELECT 1 FROM spaces_blocks cb JOIN spaces_page_owners co ON co.owner_block_id=cb.block_id
          JOIN spaces_pages cp ON cp.page_id=co.child_page_id WHERE cb.page_id=p.page_id
          AND cb.deleted=0 AND json_extract(cb.payload,'$.type')='child_page'
          AND cp.trash_batch_id IS NULL AND cp.space_id=p.space_id AND cp.root_order IS NULL) AS has_children,
        o.owner_block_id, b.page_id AS parent_page_id, b.deleted AS owner_deleted,
        parent.space_id AS parent_space_id, json_extract(b.payload,'$.type') AS owner_type
        FROM spaces_pages p JOIN spaces s ON s.space_id = p.space_id
        LEFT JOIN spaces_page_owners o ON o.child_page_id = p.page_id
        LEFT JOIN spaces_blocks b ON b.block_id = o.owner_block_id
        LEFT JOIN spaces_pages parent ON parent.page_id = b.page_id
        WHERE p.trash_batch_id IS NULL AND p.data_source_id IS NULL ${after}
        ORDER BY p.updated_at DESC, p.page_id ASC LIMIT ${limit + 1}`;
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceAllPagesResult = {
            items: rows.slice(0, take).map((row) => ({
              page: { ...pageSummary(row), hasChildren: row.has_children === 1 },
              spaceTitle: row.space_title,
            })),
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? yield* cursorFor(
                    environmentId,
                    "listAllPages",
                    "",
                    meta.catalog_revision,
                    last.updated_at,
                    last.page_id,
                  )
                : null,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) yield* ensureLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  const listPages = Effect.fn("SpacesService.listPages")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodePages),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (meta, admission) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        yield* checkIds(input);
        const space = yield* getSpace(input.spaceId);
        const limit = input.limit ?? limits.maxListRows;
        yield* ensureLimit("maxListRows", limit);
        if (input.parentPageId !== undefined)
          yield* PageStore.assertActive(yield* getPageRow(input.parentPageId));
        if (
          input.parentPageId !== undefined &&
          (yield* getPageRow(input.parentPageId)).space_id !== input.spaceId
        )
          return yield* new C.SpaceNotFoundError({ entity: "page", id: input.parentPageId });
        const filter = canonical({
          spaceId: input.spaceId,
          parentPageId: input.parentPageId ?? null,
        });
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "listPages",
          filter,
          meta.catalog_revision,
        );
        const after =
          cursor === undefined
            ? sql``
            : input.parentPageId === undefined
              ? sql`AND (p.root_order,p.page_id) > (${cursor.key},${cursor.id})`
              : sql`AND (b.rank,b.block_id) > (${cursor.key},${cursor.id})`;
        const rows =
          input.parentPageId === undefined
            ? yield* sql<PageListCandidate>`SELECT p.*, EXISTS(SELECT 1 FROM spaces_pins pin WHERE pin.page_id=p.page_id) AS is_pinned, p.root_order AS list_order, p.page_id AS list_id, o.owner_block_id, b.page_id AS parent_page_id, b.deleted AS owner_deleted, parent.space_id AS parent_space_id, json_extract(b.payload,'$.type') AS owner_type
              FROM spaces_pages p LEFT JOIN spaces_page_owners o ON o.child_page_id = p.page_id
              LEFT JOIN spaces_blocks b ON b.block_id = o.owner_block_id LEFT JOIN spaces_pages parent ON parent.page_id = b.page_id WHERE p.space_id = ${input.spaceId} AND p.root_order IS NOT NULL AND p.trash_batch_id IS NULL
              ${after}
              ORDER BY p.root_order,p.page_id LIMIT ${limit + 1}`
            : yield* sql<PageListCandidate>`SELECT p.*, EXISTS(SELECT 1 FROM spaces_pins pin WHERE pin.page_id=p.page_id) AS is_pinned, b.rank AS list_order, b.block_id AS list_id, o.owner_block_id,
              b.page_id AS parent_page_id, 0 AS owner_deleted, parent.space_id AS parent_space_id,
              'child_page' AS owner_type
              FROM (SELECT b.block_id,b.page_id,b.rank FROM spaces_blocks b
                WHERE b.page_id=${input.parentPageId} AND b.deleted=0 AND json_extract(b.payload,'$.type')='child_page'
                ${after} ORDER BY b.rank,b.block_id LIMIT ${limit + 1}) b
              LEFT JOIN spaces_page_owners o ON o.owner_block_id=b.block_id
              LEFT JOIN spaces_pages p ON p.page_id=o.child_page_id
              LEFT JOIN spaces_pages parent ON parent.page_id=b.page_id
              ORDER BY b.rank,b.block_id`;
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpacePageListResult = {
            space: spaceSummary(space),
            items: rows
              .slice(0, take)
              .filter(
                (row): row is PageRow & PageListCandidate =>
                  row.page_id !== null &&
                  row.space_id === input.spaceId &&
                  row.trash_batch_id === null,
              )
              .map((row) => pageSummary(row)),
            catalogRevision: meta.catalog_revision,
            nextCursor:
              take < rows.length && last
                ? yield* cursorFor(
                    environmentId,
                    "listPages",
                    filter,
                    meta.catalog_revision,
                    last.list_order,
                    last.list_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) yield* ensureLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  const listTrash = Effect.fn("SpacesService.listTrash")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeTrashList),
      Effect.mapError((error) =>
        isServiceError(error) ? error : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (meta, admission) =>
      Effect.gen(function* () {
        const sql = yield* SpacesSql.SpacesSql;
        const limit = input.limit ?? limits.maxListRows;
        yield* ensureLimit("maxListRows", limit);
        const cursor = yield* cursorFrom(
          input.cursor,
          environmentId,
          "listTrash",
          "",
          meta.catalog_revision,
        );
        const time = cursor === undefined ? 0 : Number(cursor.key);
        if (!Number.isSafeInteger(time) || time < 0)
          return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
        const after =
          cursor === undefined
            ? sql``
            : sql`AND (p.trashed_at_ms,p.page_id)>(${time},${cursor.id})`;
        const rows = yield* sql<
          Pick<
            PageRow,
            | "page_id"
            | "space_id"
            | "title"
            | "revision"
            | "trash_batch_id"
            | "trash_root_id"
            | "trashed_at_ms"
          > & { readonly is_trash_root: number }
        >`
        SELECT p.*, CASE WHEN o.owner_block_id IS NULL OR b.block_id IS NULL OR b.deleted!=0 OR parent.trash_batch_id IS NULL OR parent.trash_batch_id!=p.trash_batch_id THEN 1 ELSE 0 END AS is_trash_root
        FROM (SELECT p.* FROM spaces_pages p WHERE p.trash_batch_id IS NOT NULL ${after} ORDER BY p.trashed_at_ms,p.page_id LIMIT ${limit + 1}) p
        LEFT JOIN spaces_page_owners o ON o.child_page_id=p.page_id LEFT JOIN spaces_blocks b ON b.block_id=o.owner_block_id LEFT JOIN spaces_pages parent ON parent.page_id=b.page_id ORDER BY p.trashed_at_ms,p.page_id`;
        let take = Math.min(limit, rows.length);
        while (true) {
          const last = rows[take - 1];
          const result: C.SpaceTrashListResult = {
            catalogRevision: meta.catalog_revision,
            items: rows
              .slice(0, take)
              .filter((row) => row.is_trash_root === 1)
              .map((row) => ({
                pageId: row.page_id,
                spaceId: row.space_id,
                title: row.title,
                revision: row.revision,
                trash: PageStore.trashStatus(row),
              })),
            nextCursor:
              take < rows.length && last
                ? yield* cursorFor(
                    environmentId,
                    "listTrash",
                    "",
                    meta.catalog_revision,
                    String(last.trashed_at_ms),
                    last.page_id,
                  )
                : null,
            mutationAdmission: admission,
          };
          const size = byteLength(result);
          if (size <= limits.maxListResponseBytes) return result;
          if (take <= 1) yield* ensureLimit("maxListResponseBytes", size);
          take--;
        }
      }),
    );
  });
  return {
    listSpaces,
    addPin,
    removePin,
    recordRecent,
    listPins,
    listRecents,
    listAllPages,
    listPages,
    listTrash,
  };
};
