import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import type * as SqlError from "effect/sql/SqlError";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import {
  extensionBlock,
  isContainer,
  strictSyncedBlock,
  strictSyncedRefBlock,
} from "./BlockKinds.ts";

import { byteLength, ensureDatabaseLimit, ensureLimit, canonical, limits } from "./CorePolicy.ts";
import * as SpacesSql from "./SpacesSql.ts";
import * as ReferenceStore from "./ReferenceStore.ts";
import * as SearchStore from "./SearchStore.ts";
import * as AssetReferences from "./assets/References.ts";
import * as Reconciliation from "./assets/Reconciliation.ts";

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
const media = new Set(["image", "pdf", "video"]);
const strictKnown = Schema.decodeUnknownOption(C.SpaceKnownBlock, { onExcessProperty: "error" });

function ownValue(value: unknown, key: PropertyKey) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined;
}

const strictDatabase = Schema.decodeUnknownOption(C.SpaceDatabaseBlock, {
  onExcessProperty: "error",
});
const databaseBlock = (block: C.SpaceBlock) => {
  const decoded = strictDatabase(block);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

function editable(block: C.SpaceBlock) {
  if (databaseBlock(block) || extensionBlock(block)) return true;
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
export { isContainer };

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

const ensureScoped = Effect.fnUntraced(function* <E>(
  rootId: string,
  pageId: string,
  mutations: readonly C.SpaceBlockMutation[],
  original: ReadonlyMap<string, BlockRow | undefined>,
  current: (id: string) => Effect.Effect<C.SpaceBlock | null, E>,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const invalid = new C.SpaceValidationError({ reason: "invalid_parent" });
  const [rootRow] = yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${rootId}`;
  if (!rootRow || rootRow.deleted || rootRow.page_id !== pageId) return yield* invalid;
  if (!strictSyncedBlock(storedBlockFromRow(rootRow))) return yield* invalid;
  const rows = new Map<string, BlockRow | undefined>();
  const stored = Effect.fnUntraced(function* (id: string) {
    if (!rows.has(id)) {
      const [row] = yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${id}`;
      rows.set(id, row);
    }
    return rows.get(id);
  });
  const reaches = Effect.fnUntraced(function* (
    start: string | null,
    parentOf: (id: string) => Effect.Effect<string | null | undefined, E | SqlError.SqlError>,
  ) {
    const seen = new Set<string>();
    let at = start;
    while (at !== null) {
      if (at === rootId) return true;
      if (seen.has(at)) return false;
      seen.add(at);
      yield* ensureLimit("maxDepth", seen.size + 1);
      const next = yield* parentOf(at);
      if (next === undefined) return false;
      at = next;
    }
    return false;
  });
  for (const mutation of mutations) {
    const id = mutation.kind === "delete" ? mutation.blockId : mutation.block.id;
    const before = original.get(id);
    if (before && !before.deleted) {
      const ok = yield* reaches(before.parent_id, (parent) =>
        Effect.map(stored(parent), (row) => (row && !row.deleted ? row.parent_id : undefined)),
      );
      if (!ok) return yield* invalid;
    }
    if (mutation.kind !== "delete") {
      const ok = yield* reaches(mutation.block.parentId, (parent) =>
        Effect.map(current(parent), (block) => (block ? block.parentId : undefined)),
      );
      if (!ok) return yield* invalid;
    }
  }
});

// All traversal and validation share the enclosing service span and its transaction.
export const apply = Effect.fnUntraced(function* (
  pageId: C.SpacePageId,
  mutations: readonly C.SpaceBlockMutation[],
  count: number,
  bytes: number,
  requestBytes: number,
  /** Confines every change to the descendants of this synced_block, so a copy cannot edit its host. */
  scope?: { readonly rootId: string },
) {
  const sql = yield* SpacesSql.SpacesSql;
  const original = new Map<string, BlockRow | undefined>();
  const newRefSources = new Set<string>();
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
  const touch = Effect.fnUntraced(function* (id: string) {
    affected.add(id);
    yield* ensureLimit("maxMutationNodes", affected.size);
  });
  for (const mutation of mutations) {
    const id = mutation.kind === "delete" ? mutation.blockId : mutation.block.id;
    yield* touch(id);
    if (id === scope?.rootId)
      return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
    yield* ensureLimit("maxIdBytes", byteLength(id));
    if (mutation.kind === "delete" && mutation.mergedInto !== undefined)
      yield* ensureLimit("maxIdBytes", byteLength(mutation.mergedInto));
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
      yield* ensureLimit("maxIdBytes", byteLength(block.id));
      if (block.parentId !== null) yield* ensureLimit("maxIdBytes", byteLength(block.parentId));
      yield* ensureLimit("maxOrderBytes", byteLength(block.order));
      if (!/^[0-9a-f]{32}$/.test(block.order))
        return yield* new C.SpaceValidationError({ reason: "invalid_order" });
      yield* ensureLimit("maxBlockBytes", byteLength(block));
      const database = databaseBlock(block);
      if (database)
        yield* ensureDatabaseLimit("maxViewsPerDatabase", database.content.viewIds.length);
      const extension = extensionBlock(block);
      if (previous && (databaseBlock(previous) === undefined) !== (database === undefined))
        return yield* new C.SpaceValidationError({ reason: "unsupported_block" });
      if (previous && previous.type !== block.type && (extensionBlock(previous) || extension))
        return yield* new C.SpaceValidationError({ reason: "unsupported_block" });
      const ref = strictSyncedRefBlock(block);
      if (ref && previous) {
        if (strictSyncedRefBlock(previous)?.content.sourceBlockId !== ref.content.sourceBlockId)
          return yield* new C.SpaceValidationError({ reason: "unsupported_block" });
      } else if (ref) newRefSources.add(ref.content.sourceBlockId);
      // Unknown envelope/content fields must survive replacement, including on known block types.
      // Database and extension blocks decode strictly, so they have none to preserve.
      if (previous && !database && !extension) {
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
  for (const sourceId of newRefSources) {
    const inBatch = final.get(sourceId);
    const [row] =
      inBatch === undefined
        ? yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${sourceId} AND deleted = 0`
        : [];
    const source = inBatch === undefined ? (row ? storedBlockFromRow(row) : null) : inBatch;
    if (!source || !strictSyncedBlock(source))
      return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
  }
  if (scope) yield* ensureScoped(scope.rootId, pageId, mutations, original, get);
  // Include original descendants: reparenting/deleting a container cannot hide unloaded children.
  const queue = [...affected];
  for (let i = 0; i < queue.length; i++) {
    const children = yield* sql<BlockRow>`SELECT * FROM spaces_blocks
      WHERE page_id = ${pageId} AND deleted = 0 AND parent_id = ${queue[i]!}
      ORDER BY rank, block_id LIMIT ${limits.maxMutationNodes + 1}`;
    for (const child of children) {
      original.set(child.block_id, child);
      if (!affected.has(child.block_id)) {
        yield* touch(child.block_id);
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
    const ancestors: string[] = [];
    while (node.parentId !== null) {
      if (chain.has(node.parentId)) return yield* new C.SpaceValidationError({ reason: "cycle" });
      chain.add(node.parentId);
      yield* touch(node.parentId);
      const parent = yield* get(node.parentId);
      if (!parent || !isContainer(parent))
        return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
      ancestors.push(parent.type);
      node = parent;
      yield* ensureLimit("maxDepth", ++depth);
    }
    if (!C.spaceNestingAllowed(block.type, ancestors))
      return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
  }
  let workBytes = requestBytes;
  const reserve = Effect.fnUntraced(function* (value: unknown) {
    workBytes += byteLength(value);
    yield* ensureLimit("maxMutationBytes", workBytes);
  });
  for (const [id, target] of merges) {
    if (target === null) continue;
    yield* touch(target);
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
    if (block) yield* Reconciliation.admitBlock(payload);
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
  yield* ensureLimit("maxPageBlocks", count);
  yield* ensureLimit("maxPageBytes", bytes);
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
    blocksAfter: changes.map(({ id, block, payload }) => ({ id, payload: block ? payload : null })),
  };
});

/**
 * One byte-bounded window of a page's live blocks in tree order, starting after `after` (a block
 * id and rank from a previous window). `continuation` mints the cursor that resumes after a row.
 */
export const readWindow = Effect.fn("SpacesBlocks.readWindow")(function* <E, R>(input: {
  readonly pageId: string;
  readonly revision: number;
  readonly after: { readonly id: string; readonly rank: string } | undefined;
  readonly limit: number;
  readonly continuation: (row: BlockRow) => Effect.Effect<C.SpaceCursor, E, R>;
}) {
  const sql = yield* SpacesSql.SpacesSql;
  const { pageId } = input;
  const firstChild = Effect.fnUntraced(function* (parent: string | null) {
    const [row] =
      yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${pageId} AND deleted = 0 AND parent_id IS ${parent} ORDER BY rank, block_id LIMIT 1`;
    return row;
  });
  const successor = Effect.fnUntraced(function* (row: BlockRow) {
    const child = yield* firstChild(row.block_id);
    if (child) return child;
    const seen = new Set<string>();
    let node = row;
    while (true) {
      if (seen.has(node.block_id)) return yield* new C.SpaceValidationError({ reason: "cycle" });
      seen.add(node.block_id);
      yield* ensureLimit("maxDepth", seen.size);
      const [sibling] =
        yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${pageId} AND deleted = 0 AND parent_id IS ${node.parent_id} AND (rank, block_id) > (${node.rank}, ${node.block_id}) ORDER BY rank, block_id LIMIT 1`;
      if (sibling) return sibling;
      if (node.parent_id === null) return undefined;
      const [parent] =
        yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE page_id = ${pageId} AND deleted = 0 AND block_id = ${node.parent_id}`;
      if (!parent) return yield* new C.SpaceValidationError({ reason: "invalid_parent" });
      node = parent;
    }
  });
  let row: BlockRow | undefined;
  if (input.after) {
    const [last] =
      yield* sql<BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${input.after.id} AND page_id = ${pageId} AND deleted = 0`;
    if (!last || last.rank !== input.after.rank)
      return yield* new C.SpaceValidationError({ reason: "invalid_cursor" });
    row = yield* successor(last);
  } else row = yield* firstChild(null);
  const blocks: C.SpaceBlock[] = [];
  const seen = new Set<string>();
  let nextCursor: C.SpaceCursor | null = null;
  while (row && blocks.length < input.limit) {
    if (seen.has(row.block_id)) return yield* new C.SpaceValidationError({ reason: "cycle" });
    seen.add(row.block_id);
    const next = yield* successor(row);
    const candidate = [...blocks, yield* blockFromRow(row)];
    const continuation = next ? yield* input.continuation(row) : null;
    const size = byteLength({
      revision: input.revision,
      blocks: candidate,
      nextCursor: continuation,
    });
    if (size > limits.maxBlockWindowResponseBytes) {
      if (!blocks.length) yield* ensureLimit("maxBlockWindowResponseBytes", size);
      break;
    }
    blocks.push(candidate[candidate.length - 1]!);
    nextCursor = continuation;
    row = next;
  }
  return { revision: input.revision, blocks, nextCursor };
});
