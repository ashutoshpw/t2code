import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import * as SpacesSql from "./SpacesSql.ts";

export interface PageRow {
  readonly page_id: C.SpacePageId;
  readonly space_id: C.SpaceId;
  readonly title: string;
  readonly revision: number;
  readonly root_order: string | null;
  readonly block_count: number;
  readonly block_bytes: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly trash_batch_id: string | null;
  readonly trash_root_id: C.SpacePageId | null;
  readonly trashed_at_ms: number | null;
  readonly trash_origin: string | null;
  readonly owner_block_id: C.SpaceBlockId | null;
  readonly parent_page_id: C.SpacePageId | null;
  readonly owner_deleted: number | null;
  readonly parent_space_id: C.SpaceId | null;
  readonly owner_type: string | null;
}

export function summary(row: PageRow, allowOrphanedTrash = false): C.SpacePageSummary {
  let location: C.SpacePageLocation | undefined;
  if (row.root_order !== null && row.owner_block_id === null) {
    location = { kind: "root", spaceId: row.space_id, order: row.root_order };
  } else if (
    row.root_order === null &&
    row.owner_block_id !== null &&
    row.parent_page_id !== null &&
    row.owner_deleted === 0 &&
    row.parent_space_id === row.space_id &&
    row.owner_type === "child_page"
  ) {
    location = {
      kind: "child",
      spaceId: row.space_id,
      ownerBlockId: row.owner_block_id,
      parentPageId: row.parent_page_id,
    };
  } else if (!(allowOrphanedTrash && row.trash_batch_id !== null && row.root_order === null))
    throw new C.SpacesUnavailableError({ stage: "storage" });
  return {
    id: row.page_id,
    spaceId: row.space_id,
    title: row.title,
    revision: row.revision,
    rootOrder: row.root_order,
    ...(location ? { location } : {}),
    ...(row.trash_batch_id !== null ? { trash: trashStatus(row) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const load = Effect.fn("SpacesPages.load")(function* (id: C.SpacePageId) {
  const sql = yield* SpacesSql.SpacesSql;
  const [row] = yield* sql<PageRow>`SELECT p.*, o.owner_block_id, b.page_id AS parent_page_id,
    b.deleted AS owner_deleted, parent.space_id AS parent_space_id,
    json_extract(b.payload,'$.type') AS owner_type
    FROM spaces_pages p LEFT JOIN spaces_page_owners o ON o.child_page_id = p.page_id
    LEFT JOIN spaces_blocks b ON b.block_id = o.owner_block_id
    LEFT JOIN spaces_pages parent ON parent.page_id = b.page_id WHERE p.page_id = ${id}`;
  if (!row) return yield* new C.SpaceNotFoundError({ entity: "page", id });
  return row;
});

export const read = Effect.fn("SpacesService.page")(function* (id: C.SpacePageId) {
  const row = yield* load(id);
  summary(row);
  return row;
});

export function assertActive(row: PageRow) {
  if (row.trash_batch_id !== null) throw new C.SpaceValidationError({ reason: "trashed" });
}
export const trashStatus = (
  row: Pick<PageRow, "trash_batch_id" | "trash_root_id" | "trashed_at_ms">,
): C.SpacePageTrashStatus => ({
  batchId: row.trash_batch_id!,
  originalRootPageId: row.trash_root_id!,
  trashedAt: DateTime.formatIso(DateTime.makeUnsafe(row.trashed_at_ms!)),
});
export const trashSnapshot = (
  row: Pick<PageRow, "trash_batch_id" | "trash_root_id" | "trashed_at_ms" | "trash_origin">,
) =>
  row.trash_batch_id === null
    ? null
    : {
        batchId: row.trash_batch_id,
        rootPageId: row.trash_root_id!,
        trashedAtMs: row.trashed_at_ms!,
        origin: row.trash_origin!,
      };
export type TrashPreimage = NonNullable<ReturnType<typeof trashSnapshot>>;
const decodeOrigin = Schema.decodeUnknownSync(
  Schema.Struct({
    spaceId: C.SpaceId,
    rootOrder: Schema.NullOr(Schema.String),
    ownerBlockId: Schema.NullOr(C.SpaceBlockId),
    ownerPageId: Schema.NullOr(C.SpacePageId),
    parentId: Schema.NullOr(C.SpaceBlockId),
    rank: Schema.NullOr(Schema.String),
  }),
  { onExcessProperty: "error" },
);
export const origin = (row: PageRow) => decodeOrigin(JSON.parse(row.trash_origin!));
export const preimage = (row: PageRow) => ({
  pageId: row.page_id,
  spaceId: row.space_id,
  title: row.title,
  revision: row.revision,
  rootOrder: row.root_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export const ownerPreimage = (row: PageRow) =>
  row.owner_block_id === null
    ? null
    : { childPageId: row.page_id, ownerBlockId: row.owner_block_id };
