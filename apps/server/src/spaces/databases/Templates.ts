import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BlockStore from "../BlockStore.ts";
import { ensureLimit, limits } from "../CorePolicy.ts";
import * as PageStore from "../PageStore.ts";
import { applyBatch } from "../service/BlockBatch.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as CellCodec from "./CellCodec.ts";
import * as CellStore from "./CellStore.ts";
import * as Ids from "./Ids.ts";
import type { Json } from "./Json.ts";
import * as RelationStore from "./RelationStore.ts";
import type { Snapshot } from "./SchemaStore.ts";
import { dbError, trashed } from "./Types.ts";

const isKnownBlock = Schema.is(C.SpaceKnownBlock);

/**
 * What a new row inherits from its template: the icon and every copyable stored cell. The title,
 * computed properties and the sub-items pair are not inherited. Callers let the draft win.
 */
export const load = Effect.fn("SpacesDatabases.loadTemplate")(function* (
  snapshot: Snapshot,
  templateId: string,
) {
  const page = yield* PageStore.load(C.SpacePageId.make(templateId));
  if (page.data_source_id !== snapshot.source.data_source_id) return yield* dbError("not_a_row");
  if (page.trash_batch_id !== null) return yield* trashed();
  if (page.row_template !== 1) return yield* dbError("not_a_row");
  const subItems = snapshot.source.sub_items_property_id;
  const subItemsTwin =
    subItems === null || snapshot.byId.get(subItems) === undefined
      ? null
      : RelationStore.relationOf(snapshot.byId.get(subItems)!).twinId;
  const sql = yield* SpacesSql.SpacesSql;
  const cells = yield* CellStore.readCells([templateId]);
  const values: Record<string, Json> = {};
  for (const property of snapshot.live) {
    if (property.type === "title" || CellCodec.readOnlyTypes.has(property.type)) continue;
    if (property.id === subItems || property.id === subItemsTwin) continue;
    const value = CellCodec.decode(property, cells.get(templateId)?.get(property.id) ?? []);
    if (value === undefined) continue;
    if (property.type !== "relation" || !Array.isArray(value)) {
      values[property.id] = value;
      continue;
    }
    // Links to trashed or template rows are not copied.
    const ids = value.filter((id): id is string => typeof id === "string");
    const live =
      ids.length === 0
        ? []
        : yield* sql<{
            readonly page_id: string;
          }>`SELECT page_id FROM spaces_pages WHERE page_id IN ${sql.in(ids)}
            AND trash_batch_id IS NULL AND row_template = 0`;
    const keep = new Set(live.map((row) => row.page_id));
    const kept = ids.filter((id) => keep.has(id));
    if (kept.length > 0) values[property.id] = kept;
  }
  return { icon: page.icon, values };
});

/**
 * Copies the template's live blocks, in order and nesting, onto a new page through the same batch
 * path as any block write, so search text, references and asset usage are recorded.
 */
export const copyBody = Effect.fn("SpacesDatabases.copyTemplateBody")(function* (input: {
  readonly templateId: string;
  readonly pageId: string;
  readonly mutationId: string;
  readonly nowMs: number;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const rows = yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks
    WHERE page_id = ${input.templateId} AND deleted = 0 ORDER BY rank, block_id
    LIMIT ${limits.maxMutationNodes + 1}`;
  yield* ensureLimit("maxMutationNodes", rows.length);
  const stored = rows.map((row) => BlockStore.storedBlockFromRow(row));
  const skipped = new Set(
    stored
      .filter((block) => !isKnownBlock(block) || block.type === "child_page")
      .map((block) => block.id),
  );
  const parentOf = new Map(stored.map((block) => [block.id, block.parentId] as const));
  // A block under a skipped ancestor, at any depth, has no parent to attach to.
  const survives = (id: string | null): boolean => {
    for (let at = id; at !== null; at = parentOf.get(at as never) ?? null)
      if (skipped.has(at as never)) return false;
    return true;
  };
  const blocks = stored.filter((block) => survives(block.id));
  const copied = new Set(blocks.map((block) => block.id));
  const fresh = new Map(blocks.map((block) => [block.id, Ids.newBlockId()] as const));
  const mutations = blocks.flatMap((block): C.SpaceBlockMutation[] => {
    if (block.parentId !== null && !copied.has(block.parentId)) return [];
    const id = fresh.get(block.id)!;
    return [
      {
        kind: "insert",
        block: {
          ...block,
          id: C.SpaceBlockId.make(id),
          parentId:
            block.parentId === null ? null : C.SpaceBlockId.make(fresh.get(block.parentId)!),
        },
      },
    ];
  });
  if (mutations.length === 0) return;
  const page = yield* PageStore.read(C.SpacePageId.make(input.pageId));
  yield* applyBatch({
    page,
    mutations,
    mutationId: input.mutationId,
    nowMs: input.nowMs,
    requestBytes: 0,
  });
});
