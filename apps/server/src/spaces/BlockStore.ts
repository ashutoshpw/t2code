import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { byteLength, checkLimit, canonical, limits } from "./CorePolicy.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as ReferenceStore from "./ReferenceStore.ts";
import * as SearchStore from "./SearchStore.ts";
import * as AssetReferences from "./assets/References.ts";

export interface BlockRow {
  readonly block_id: string;
  readonly page_id: string;
  readonly parent_id: string | null;
  readonly rank: string;
  readonly payload: string;
  readonly logical_bytes: number;
  readonly deleted: number;
  readonly merged_into: string | null;
}

const decodeBlock = Schema.decodeUnknownSync(C.SpaceBlock, { onExcessProperty: "error" });
const knownBlock = Schema.is(C.SpaceKnownBlock);
const decodeKnown = Schema.decodeUnknownSync(C.SpaceKnownBlock);
const knownMark = Schema.is(C.SpaceKnownMark);
const decodeKnownMark = Schema.decodeUnknownSync(C.SpaceKnownMark);
const containers = new Set(["bulleted_item", "numbered_item", "todo_item"]);
const media = new Set(["image", "pdf", "video"]);
const strictKnown = Schema.decodeUnknownOption(C.SpaceKnownBlock, { onExcessProperty: "error" });

function ownValue(value: unknown, key: PropertyKey) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

function editable(block: C.SpaceBlock) {
  if (block.type === "child_page" || !knownBlock(block)) return false;
  if (media.has(block.type) && Option.isNone(strictKnown(block))) return false;
  const content = block.content as Schema.Json;
  if (
    content !== null &&
    typeof content === "object" &&
    !Array.isArray(content) &&
    (("runs" in content && Array.isArray(content.runs)) ||
      ("caption" in content && Array.isArray(content.caption)))
  ) {
    const runs = "runs" in content ? content.runs : content.caption;
    if (!Array.isArray(runs)) return false;
    for (const run of runs) {
      if (
        run === null ||
        typeof run !== "object" ||
        Array.isArray(run) ||
        !Array.isArray(run.marks) ||
        !run.marks.every(knownMark)
      )
        return false;
    }
  }
  return true;
}

export const storedBlockFromRow = (row: BlockRow) => decodeBlock(JSON.parse(row.payload));
export const isListContainer = (block: C.SpaceBlock) =>
  containers.has(block.type) && knownBlock(block);

// Materialization stays inside the bounded read-window span.
export const blockFromRow = Effect.fnUntraced(function* (row: BlockRow) {
  const block = storedBlockFromRow(row);
  if (block.type !== "child_page") return block;
  const sql = yield* SpacesSql.SpacesSql;
  const [owner] = yield* sql<{
    readonly child_page_id: string;
    readonly space_id: string;
    readonly parent_space_id: string;
  }>`
    SELECT o.child_page_id, p.space_id, parent.space_id AS parent_space_id FROM spaces_page_owners o
    JOIN spaces_pages p ON p.page_id = o.child_page_id JOIN spaces_pages parent ON parent.page_id = ${row.page_id}
    WHERE o.owner_block_id = ${row.block_id} AND p.root_order IS NULL`;
  if (!owner || owner.space_id !== owner.parent_space_id)
    return yield* new C.SpacesUnavailableError({ stage: "storage" });
  if (block.content === null || typeof block.content !== "object" || Array.isArray(block.content))
    return block;
  return decodeBlock({ ...block, content: { ...block.content, pageId: owner.child_page_id } });
});

// All traversal and validation share the enclosing service span and its transaction.
export const apply = Effect.fnUntraced(function* (
  pageId: C.SpacePageId,
  mutations: readonly C.SpaceBlockMutation[],
  count: number,
  bytes: number,
  requestBytes: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const original = new Map<string, BlockRow | undefined>();
  const final = new Map<string, C.SpaceBlock | null>();
  const merges = new Map<string, string | null>();
  const affected = new Set<string>();
  const get = Effect.fnUntraced(function* (id: string) {
    if (!original.has(id)) {
      const [row] = yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${id}`;
      original.set(id, row);
    }
    const row = original.get(id);
    return final.has(id)
      ? final.get(id)!
      : row && !row.deleted && row.page_id === pageId
        ? storedBlockFromRow(row)
        : null;
  });
  const touch = (id: string) => {
    affected.add(id);
    checkLimit("maxMutationNodes", affected.size);
  };
  for (const mutation of mutations) {
    const id = mutation.kind === "delete" ? mutation.blockId : mutation.block.id;
    touch(id);
    checkLimit("maxIdBytes", byteLength(id));
    if (mutation.kind === "delete" && mutation.mergedInto !== undefined)
      checkLimit("maxIdBytes", byteLength(mutation.mergedInto));
    const previous = yield* get(id);
    if (mutation.kind === "insert") {
      const exists = yield* sql`SELECT 1 FROM spaces_ids WHERE id = ${id}`;
      if (exists.length || final.has(id))
        return yield* new C.SpaceValidationError({ reason: "duplicate_id" });
    } else if (!previous) return yield* new C.SpaceNotFoundError({ entity: "block", id });
    if (previous && !editable(previous))
      return yield* new C.SpaceValidationError({ reason: "unsupported_block" });
    if (mutation.kind === "delete") {
      final.set(id, null);
      merges.set(id, mutation.mergedInto ?? null);
    } else {
      const block = mutation.block;
      if (!editable(block))
        return yield* new C.SpaceValidationError({ reason: "unsupported_block" });
      if (media.has(block.type)) yield* AssetReferences.validate(decodeKnown(block));
      checkLimit("maxIdBytes", byteLength(block.id));
      if (block.parentId !== null) checkLimit("maxIdBytes", byteLength(block.parentId));
      checkLimit("maxOrderBytes", byteLength(block.order));
      if (!/^[0-9a-f]{32}$/.test(block.order))
        return yield* new C.SpaceValidationError({ reason: "invalid_order" });
      checkLimit("maxBlockBytes", byteLength(block));
      // Unknown envelope/content fields must survive replacement, including on known block types.
      if (previous) {
        const decoded = decodeKnown(previous);
        const projected = { ...decoded, content: { ...decoded.content } };
        const runs =
          "runs" in decoded.content
            ? decoded.content.runs
            : "caption" in decoded.content
              ? decoded.content.caption
              : undefined;
        if (runs !== undefined) {
          Object.assign(projected.content, {
            ["runs" in decoded.content ? "runs" : "caption"]: runs.map((run) => ({
              text: run.text,
              marks: run.marks.map((mark) => {
                const keys =
                  mark.type === "link"
                    ? ["type", "version", "href"]
                    : mark.type === "page_mention" || mark.type === "block_mention"
                      ? ["type", "version", "target"]
                      : ["type", "version"];
                const decodedMark = decodeKnownMark(mark);
                return Object.fromEntries(keys.map((key) => [key, ownValue(decodedMark, key)]));
              }),
            })),
          });
        }
        const preserve = (old: unknown, known: unknown, next: unknown): boolean => {
          if (Array.isArray(old))
            return old.every((v, i) =>
              preserve(
                v,
                Array.isArray(known) ? ownValue(known, i) : undefined,
                Array.isArray(next) ? ownValue(next, i) : undefined,
              ),
            );
          if (old !== null && typeof old === "object") {
            return Object.keys(old).every((key) => {
              const v = ownValue(old, key);
              const k = ownValue(known, key);
              const n = ownValue(next, key);
              return k === undefined
                ? n !== undefined && canonical(v) === canonical(n)
                : preserve(v, k, n);
            });
          }
          return true;
        };
        if (!preserve(previous, projected, block))
          return yield* new C.SpaceValidationError({ reason: "unsupported_block" });
      }
      final.set(id, block);
    }
  }
  // Include original descendants: reparenting/deleting a container cannot hide unloaded children.
  const queue = [...affected];
  for (let i = 0; i < queue.length; i++) {
    const children = yield* sql<BlockRow>`SELECT * FROM spaces_blocks
      WHERE page_id = ${pageId} AND deleted = 0 AND parent_id = ${queue[i]!}
      ORDER BY rank, block_id LIMIT ${limits.maxMutationNodes + 1}`;
    for (const child of children) {
      original.set(child.block_id, child);
      if (!affected.has(child.block_id)) {
        touch(child.block_id);
        queue.push(child.block_id);
      }
    }
  }
  for (const id of affected) {
    const block = yield* get(id);
    if (!block) continue;
    const chain = new Set([id]);
    let node = block;
    let depth = 1;
    while (node.parentId !== null) {
      if (chain.has(node.parentId)) return yield* new C.SpaceValidationError({ reason: "cycle" });
      chain.add(node.parentId);
      touch(node.parentId);
      const parent = yield* get(node.parentId);
      if (!parent || !containers.has(parent.type) || !knownBlock(parent))
        return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
      node = parent;
      checkLimit("maxDepth", ++depth);
    }
  }
  let workBytes = requestBytes;
  const reserve = (value: unknown) => {
    workBytes += byteLength(value);
    checkLimit("maxMutationBytes", workBytes);
  };
  for (const [id, target] of merges) {
    if (target === null) continue;
    touch(target);
    const survivor = yield* get(target);
    if (target === id || !survivor || !editable(survivor))
      return yield* new C.SpaceValidationError({ reason: "invalid_merge" });
    yield* ReferenceStore.flatten(id, target, touch, reserve);
  }
  const changes: Array<{
    id: string;
    block: C.SpaceBlock | null;
    old: BlockRow | undefined;
    payload: string;
    size: number;
  }> = [];
  const assetRefsAfter: Array<{ blockId: string; assetId: C.SpaceAssetId | null }> = [];
  for (const [id, block] of final) {
    const old = original.get(id);
    const payload = block
      ? canonical(block)
      : canonical({ id, pageId, mergedInto: merges.get(id) ?? null });
    if (old?.payload === payload) continue;
    const previous = old && !old.deleted ? storedBlockFromRow(old) : null;
    const wasMedia = previous !== null && media.has(previous.type);
    if (wasMedia) yield* AssetReferences.requireCurrent(decodeKnown(previous));
    if (wasMedia || (block !== null && media.has(block.type))) {
      const known = block ? decodeKnown(block) : null;
      assetRefsAfter.push({
        blockId: id,
        assetId: known && "assetId" in known.content ? known.content.assetId : null,
      });
    }
    const size = Buffer.byteLength(payload, "utf8");
    count += (block ? 1 : 0) - (old && !old.deleted ? 1 : 0);
    bytes += (block ? size : 0) - (old && !old.deleted ? old.logical_bytes : 0);
    changes.push({ id, block, old, payload, size });
  }
  checkLimit("maxPageBlocks", count);
  checkLimit("maxPageBytes", bytes);
  for (const { id, block, old, payload, size } of changes) {
    yield* SearchStore.writeBlock(pageId, id, block);
    if (!old) yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, 'block')`;
    yield* sql`INSERT INTO spaces_blocks (block_id, page_id, parent_id, rank, payload, logical_bytes, deleted, merged_into)
      VALUES (${id}, ${pageId}, ${block?.parentId ?? null}, ${block?.order ?? old?.rank ?? ""}, ${payload}, ${size}, ${block ? 0 : 1}, ${merges.get(id) ?? null})
      ON CONFLICT (block_id) DO UPDATE SET parent_id = excluded.parent_id, rank = excluded.rank,
      payload = excluded.payload, logical_bytes = excluded.logical_bytes, deleted = excluded.deleted, merged_into = excluded.merged_into`;
  }
  return {
    changed: changes.length > 0,
    count,
    bytes,
    retiredIds: changes.filter((change) => change.block === null).map((change) => change.id),
    blocksBefore: changes.map(({ id, old }) => ({ id, row: old ? { ...old } : null })),
    assetRefsAfter,
  };
});
