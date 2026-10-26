// @effect-diagnostics nodeBuiltinImport:off -- structural identities use the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";

import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as BlockStore from "./BlockStore.ts";
import { byteLength, canonical, checkLimit, limits } from "./CorePolicy.ts";
import * as PageStore from "./PageStore.ts";
import * as RevisionStore from "./RevisionStore.ts";
import * as ReferenceStore from "./ReferenceStore.ts";
import * as SpacesSql from "./SpacesSql.ts";

interface Peer {
  readonly id: string;
  readonly rank: string;
}
interface RankChange extends Peer {
  readonly kind: "page" | "block";
}
const maxRank = (1n << 128n) - 1n;
const rankNumber = (rank: string) => {
  if (!/^[0-9a-f]{32}$/.test(rank)) throw new C.SpaceValidationError({ reason: "invalid_order" });
  return BigInt(`0x${rank}`);
};
const rankString = (rank: bigint) => rank.toString(16).padStart(32, "0");
const invalid = (reason: C.SpaceValidationError["reason"] = "invalid_input") =>
  new C.SpaceValidationError({ reason });

// Bounded traversal shares the planner span and caller transaction.
export const plan = Effect.fn("SpacesStructure.plan")(function* (
  input: C.SpaceInspectStructureInput,
  initialBytes: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const nodes = new Set<string>();
  let bytes = initialBytes;
  const produced = (value: unknown) => {
    bytes += byteLength(value);
    checkLimit("maxMutationBytes", bytes);
  };
  const touch = (key: string, value: unknown) => {
    if (nodes.has(key)) return;
    nodes.add(key);
    checkLimit("maxMutationNodes", nodes.size);
    produced(value);
  };
  const idLimit = (id: string) => checkLimit("maxIdBytes", byteLength(id));
  const pages = new Map<C.SpacePageId, PageStore.PageRow>();
  const blocks = new Map<string, BlockStore.BlockRow>();
  const roots = new Map<C.SpaceId, C.SpaceRootRevisionGuard>();
  const block = Effect.fnUntraced(function* (id: string) {
    idLimit(id);
    const cached = blocks.get(id);
    if (cached) return cached;
    const [row] =
      yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE block_id = ${id} AND deleted = 0`;
    if (!row) return yield* new C.SpaceNotFoundError({ entity: "block", id });
    touch(`block:${id}`, { ...row });
    blocks.set(id, row);
    return row;
  });
  const page = Effect.fnUntraced(function* (id: C.SpacePageId) {
    idLimit(id);
    const cached = pages.get(id);
    if (cached) return cached;
    const row = yield* PageStore.read(id);
    touch(`page:${id}`, { ...row });
    pages.set(id, row);
    if (row.owner_block_id !== null) {
      yield* block(row.owner_block_id);
      touch(`owner:${id}`, { child_page_id: id, owner_block_id: row.owner_block_id });
    }
    return row;
  });
  const root = Effect.fnUntraced(function* (spaceId: C.SpaceId) {
    idLimit(spaceId);
    if (roots.has(spaceId)) return;
    const [row] = yield* sql<{
      readonly root_order_revision: number;
    }>`SELECT root_order_revision FROM spaces WHERE space_id = ${spaceId}`;
    if (!row) return yield* new C.SpaceNotFoundError({ entity: "space", id: spaceId });
    const guard = { spaceId, rootOrderRevision: row.root_order_revision };
    touch(`root:${spaceId}`, guard);
    roots.set(spaceId, guard);
  });
  const ancestry = Effect.fnUntraced(function* (id: C.SpacePageId) {
    const seen = new Set<string>();
    let current: C.SpacePageId | null = id;
    while (current !== null) {
      if (seen.has(current)) return yield* invalid("cycle");
      seen.add(current);
      checkLimit("maxDepth", seen.size);
      current = (yield* page(current)).parent_page_id;
    }
    return seen.size;
  });
  const listAncestry = Effect.fnUntraced(function* (pageId: string, parentId: string | null) {
    const seen = new Set<string>();
    let current = parentId;
    while (current !== null) {
      if (seen.has(current)) return yield* invalid("cycle");
      seen.add(current);
      checkLimit("maxDepth", seen.size + 1);
      const row = yield* block(current);
      if (row.page_id !== pageId || !BlockStore.isListContainer(BlockStore.storedBlockFromRow(row)))
        return yield* invalid("invalid_parent");
      current = row.parent_id;
    }
  });
  const subtree = Effect.fnUntraced(function* (id: C.SpacePageId) {
    const queue = [{ id, depth: 1 }];
    const members = new Set<C.SpacePageId>();
    let depth = 1;
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]!;
      if (members.has(next.id)) return yield* invalid("cycle");
      members.add(next.id);
      checkLimit("maxDepth", next.depth);
      depth = Math.max(depth, next.depth);
      yield* page(next.id);
      const children = yield* sql<{
        readonly block_id: string;
        readonly child_page_id: C.SpacePageId | null;
      }>`
        SELECT b.block_id, o.child_page_id FROM spaces_blocks b LEFT JOIN spaces_page_owners o ON o.owner_block_id = b.block_id
        WHERE b.page_id = ${next.id} AND b.deleted = 0 AND json_extract(b.payload,'$.type') = 'child_page'
        ORDER BY b.rank,b.block_id LIMIT ${limits.maxMutationNodes - nodes.size + 1}`;
      for (const child of children) {
        if (child.child_page_id === null)
          return yield* new C.SpacesUnavailableError({ stage: "storage" });
        queue.push({ id: child.child_page_id, depth: next.depth + 1 });
      }
    }
    return { members, depth };
  });
  const source = input.target.kind === "page" ? yield* page(input.target.pageId) : undefined;
  const movingPages = source
    ? yield* subtree(source.page_id)
    : { members: new Set<C.SpacePageId>(), depth: 0 };
  yield* ancestry(input.target.pageId);
  if (source?.root_order !== null && source !== undefined) yield* root(source.space_id);
  if (source?.owner_block_id) {
    const owner = yield* block(source.owner_block_id);
    yield* listAncestry(owner.page_id, owner.parent_id);
  }
  const selectedBlocks = new Set<string>();
  const selectedRoots = input.target.kind === "blocks" ? [...input.target.blockIds] : [];
  const movingBlocks = selectedRoots.length > 0;
  let blockHeight = 0;
  if (input.target.kind === "blocks") {
    const selected = new Set<string>(input.target.blockIds);
    if (selected.size !== input.target.blockIds.length) return yield* invalid();
    checkLimit("maxMutationNodes", selected.size);
    const queue = [...selected].map((id) => ({ id, depth: 1 }));
    for (let i = 0; i < queue.length; i++) {
      const { id, depth } = queue[i]!;
      blockHeight = Math.max(blockHeight, depth);
      if (selectedBlocks.has(id)) return yield* invalid();
      selectedBlocks.add(id);
      const row = yield* block(id);
      if (row.page_id !== input.target.pageId) return yield* invalid("invalid_parent");
      yield* listAncestry(row.page_id, row.parent_id);
      if (BlockStore.storedBlockFromRow(row).type === "child_page") {
        const [owner] = yield* sql<{
          readonly child_page_id: C.SpacePageId;
        }>`SELECT child_page_id FROM spaces_page_owners WHERE owner_block_id = ${id}`;
        if (!owner) return yield* new C.SpacesUnavailableError({ stage: "storage" });
        const owned = yield* subtree(owner.child_page_id);
        for (const ownedId of owned.members) movingPages.members.add(ownedId);
        movingPages.depth = Math.max(movingPages.depth, owned.depth);
      }
      const children = yield* sql<{ readonly block_id: string }>`SELECT block_id FROM spaces_blocks
        WHERE page_id = ${row.page_id} AND deleted = 0 AND parent_id = ${id} ORDER BY rank,block_id
        LIMIT ${limits.maxMutationNodes - nodes.size + 1}`;
      for (const child of children) {
        if (selected.has(child.block_id)) return yield* invalid();
        queue.push({ id: child.block_id, depth: depth + 1 });
      }
    }
  }
  if (movingBlocks) yield* root((yield* page(input.target.pageId)).space_id);
  const destination = input.destination;
  const creating =
    input.target.kind === "blocks" &&
    input.target.blockIds.length === 0 &&
    destination?.kind === "child";
  if (creating) {
    touch("new:page", null);
    touch("new:owner", null);
    touch("new:block", null);
  }
  if (source?.root_order !== null && source !== undefined && destination?.kind === "child") {
    touch("new:owner", null);
    touch("new:block", null);
  }
  if (destination?.kind === "root") {
    if (input.target.kind !== "page") return yield* invalid();
    yield* root(destination.spaceId);
  } else if (destination?.kind === "child") {
    const parent = yield* page(destination.placement.pageId);
    if (movingPages.members.has(parent.page_id)) return yield* invalid("cycle");
    const depth = yield* ancestry(parent.page_id);
    checkLimit("maxDepth", depth + Math.max(1, movingPages.depth));
    if (
      destination.placement.parentId !== null &&
      selectedBlocks.has(destination.placement.parentId)
    )
      return yield* invalid("cycle");
    yield* listAncestry(parent.page_id, destination.placement.parentId);
    if (movingBlocks) {
      yield* root(parent.space_id);
      let listDepth = 0;
      let parentId: string | null = destination.placement.parentId;
      while (parentId !== null) {
        listDepth++;
        parentId = (yield* block(parentId)).parent_id;
      }
      checkLimit("maxDepth", listDepth + blockHeight);
    }
  }
  const ranks: RankChange[] = [];
  const rankOwnedPages = new Set<C.SpacePageId>();
  let rank: string | null = null;
  let placementRanks: string[] = [];
  const insertionCount = Math.max(1, selectedRoots.length);
  let unchanged = false;
  if (destination) {
    const excluded = source
      ? [destination.kind === "root" ? source.page_id : (source.owner_block_id ?? "")]
      : [...selectedBlocks];
    if (!excluded.length) excluded.push("");
    const kind = destination.kind === "root" ? "page" : "block";
    const remember = Effect.fnUntraced(function* (peer: Peer | undefined) {
      if (!peer) return undefined;
      rankNumber(peer.rank);
      if (kind === "page") yield* page(C.SpacePageId.make(peer.id));
      else yield* block(peer.id);
      return peer;
    });
    const adjacent = Effect.fnUntraced(function* (pivot: Peer | undefined, previous: boolean) {
      let rows: readonly Peer[];
      if (destination.kind === "root") {
        rows = previous
          ? pivot
            ? yield* sql<Peer>`SELECT page_id AS id,root_order AS rank FROM spaces_pages WHERE space_id = ${destination.spaceId} AND root_order IS NOT NULL AND page_id NOT IN ${sql.in(excluded)} AND (root_order,page_id) < (${pivot.rank},${pivot.id}) ORDER BY root_order DESC,page_id DESC LIMIT 1`
            : yield* sql<Peer>`SELECT page_id AS id,root_order AS rank FROM spaces_pages WHERE space_id = ${destination.spaceId} AND root_order IS NOT NULL AND page_id NOT IN ${sql.in(excluded)} ORDER BY root_order DESC,page_id DESC LIMIT 1`
          : yield* sql<Peer>`SELECT page_id AS id,root_order AS rank FROM spaces_pages WHERE space_id = ${destination.spaceId} AND root_order IS NOT NULL AND page_id NOT IN ${sql.in(excluded)} AND (root_order,page_id) > (${pivot!.rank},${pivot!.id}) ORDER BY root_order,page_id LIMIT 1`;
      } else {
        const placement = destination.placement;
        rows = previous
          ? pivot
            ? yield* sql<Peer>`SELECT block_id AS id,rank FROM spaces_blocks WHERE page_id = ${placement.pageId} AND parent_id IS ${placement.parentId} AND deleted = 0 AND block_id NOT IN ${sql.in(excluded)} AND (rank,block_id) < (${pivot.rank},${pivot.id}) ORDER BY rank DESC,block_id DESC LIMIT 1`
            : yield* sql<Peer>`SELECT block_id AS id,rank FROM spaces_blocks WHERE page_id = ${placement.pageId} AND parent_id IS ${placement.parentId} AND deleted = 0 AND block_id NOT IN ${sql.in(excluded)} ORDER BY rank DESC,block_id DESC LIMIT 1`
          : yield* sql<Peer>`SELECT block_id AS id,rank FROM spaces_blocks WHERE page_id = ${placement.pageId} AND parent_id IS ${placement.parentId} AND deleted = 0 AND block_id NOT IN ${sql.in(excluded)} AND (rank,block_id) > (${pivot!.rank},${pivot!.id}) ORDER BY rank,block_id LIMIT 1`;
      }
      return yield* remember(rows[0]);
    });
    const beforeId =
      destination.kind === "root" ? destination.beforePageId : destination.placement.beforeBlockId;
    const current =
      source &&
      destination.kind === "root" &&
      source.root_order !== null &&
      source.space_id === destination.spaceId
        ? { id: source.page_id, rank: source.root_order }
        : source?.owner_block_id &&
            destination.kind === "child" &&
            blocks.get(source.owner_block_id)?.page_id === destination.placement.pageId &&
            blocks.get(source.owner_block_id)?.parent_id === destination.placement.parentId
          ? { id: source.owner_block_id, rank: blocks.get(source.owner_block_id)!.rank }
          : undefined;
    if (
      current &&
      (beforeId === current.id || (yield* adjacent(current, false))?.id === (beforeId ?? undefined))
    ) {
      unchanged = true;
      rank = current.rank;
    } else {
      let right: Peer | undefined;
      if (beforeId !== null) {
        idLimit(beforeId);
        if (excluded.includes(beforeId)) return yield* invalid("invalid_order");
        if (destination.kind === "root") {
          const next = yield* page(C.SpacePageId.make(beforeId));
          if (next.space_id !== destination.spaceId || next.root_order === null)
            return yield* invalid("invalid_order");
          right = { id: beforeId, rank: next.root_order };
        } else {
          const next = yield* block(beforeId);
          if (
            next.page_id !== destination.placement.pageId ||
            next.parent_id !== destination.placement.parentId
          )
            return yield* invalid("invalid_order");
          right = { id: beforeId, rank: next.rank };
        }
      }
      let left = yield* adjacent(right, true);
      const low = left ? rankNumber(left.rank) : -1n;
      const high = right ? rankNumber(right.rank) : maxRank + 1n;
      if (high - low > BigInt(insertionCount)) {
        const step = (high - low) / BigInt(insertionCount + 1);
        placementRanks = Array.from({ length: insertionCount }, (_, i) =>
          rankString(low + step * BigInt(i + 1)),
        );
        rank = placementRanks[0]!;
      } else {
        const window: Peer[] = [];
        let at = 0;
        for (;;) {
          if (left) {
            window.unshift(left);
            at++;
            left = yield* adjacent(left, true);
          }
          if (right) {
            window.push(right);
            right = yield* adjacent(right, false);
          }
          const lower = left ? rankNumber(left.rank) : -1n;
          const upper = right ? rankNumber(right.rank) : maxRank + 1n;
          const step = (upper - lower) / BigInt(window.length + insertionCount + 1);
          if (step <= 0n) continue;
          placementRanks = Array.from({ length: insertionCount }, (_, i) =>
            rankString(lower + step * BigInt(at + i + 1)),
          );
          rank = placementRanks[0]!;
          for (const [i, peer] of window.entries()) {
            const nextRank = rankString(
              lower + step * BigInt(i + 1 + (i >= at ? insertionCount : 0)),
            );
            if (peer.rank === nextRank) continue;
            ranks.push({ ...peer, rank: nextRank, kind });
            if (
              kind === "block" &&
              BlockStore.storedBlockFromRow(blocks.get(peer.id)!).type === "child_page"
            ) {
              const [owner] = yield* sql<{
                readonly child_page_id: C.SpacePageId;
              }>`SELECT child_page_id FROM spaces_page_owners WHERE owner_block_id = ${peer.id}`;
              if (!owner) return yield* new C.SpacesUnavailableError({ stage: "storage" });
              yield* page(owner.child_page_id);
              rankOwnedPages.add(owner.child_page_id);
            }
          }
          break;
        }
      }
    }
  }
  if (movingBlocks && destination?.kind === "child") {
    const placement = destination.placement;
    const first = blocks.get(selectedRoots[0]!)!;
    if (
      selectedRoots.every((id) => {
        const row = blocks.get(id)!;
        return row.page_id === placement.pageId && row.parent_id === placement.parentId;
      })
    ) {
      const siblings = yield* sql<{ readonly block_id: string }>`SELECT block_id FROM spaces_blocks
        WHERE page_id=${placement.pageId} AND deleted=0 AND parent_id IS ${placement.parentId}
        AND (rank,block_id)>=(${first.rank},${first.block_id}) ORDER BY rank,block_id LIMIT ${selectedRoots.length + 1}`;
      unchanged =
        selectedRoots.every((id, i) => siblings[i]?.block_id === id) &&
        (siblings[selectedRoots.length]?.block_id ?? null) === placement.beforeBlockId;
    }
  }
  const guards: C.SpaceStructureGuards = {
    pages: [...pages.values()]
      .map((row) => ({ pageId: row.page_id, revision: row.revision }))
      .sort((a, b) => a.pageId.localeCompare(b.pageId)),
    roots: [...roots.values()].sort((a, b) => a.spaceId.localeCompare(b.spaceId)),
  };
  return {
    pages,
    blocks,
    movingBlocks,
    selectedRoots,
    selectedBlocks,
    placementRanks,
    sourcePageId: input.target.pageId,
    roots,
    guards,
    source,
    destination,
    creating,
    movingPages: movingPages.members,
    ranks,
    rankOwnedPages,
    rank,
    unchanged,
    produced,
  };
});

type Plan = Effect.Success<ReturnType<typeof plan>>;

export function guardsMatch(plan: Plan, supplied: C.SpaceStructureGuards) {
  checkLimit("maxMutationNodes", supplied.pages.length + supplied.roots.length);
  const pages = new Map(supplied.pages.map((row) => [row.pageId, row.revision]));
  const roots = new Map(supplied.roots.map((row) => [row.spaceId, row.rootOrderRevision]));
  for (const id of [...pages.keys(), ...roots.keys()]) checkLimit("maxIdBytes", byteLength(id));
  if (
    pages.size !== supplied.pages.length ||
    roots.size !== supplied.roots.length ||
    [...pages.keys()].some((id) => !plan.pages.has(id)) ||
    [...roots.keys()].some((id) => !plan.roots.has(id))
  )
    throw invalid();
  return (
    pages.size === plan.guards.pages.length &&
    roots.size === plan.guards.roots.length &&
    plan.guards.pages.every((row) => pages.get(row.pageId) === row.revision) &&
    plan.guards.roots.every((row) => roots.get(row.spaceId) === row.rootOrderRevision)
  );
}

const preimage = (row: PageStore.PageRow): RevisionStore.PagePreimage => ({
  pageId: row.page_id,
  spaceId: row.space_id,
  title: row.title,
  revision: row.revision,
  rootOrder: row.root_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const ownerBefore = (row: PageStore.PageRow) =>
  row.owner_block_id === null
    ? null
    : { childPageId: row.page_id, ownerBlockId: row.owner_block_id };

export const apply = Effect.fn("SpacesStructure.apply")(function* (
  plan: Plan,
  mutationId: string,
  now: number,
  title?: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const destination = plan.destination;
  if (!destination || plan.rank === null) return yield* invalid();
  if (plan.unchanged && plan.movingBlocks)
    return { blockIds: plan.selectedRoots, changed: { pages: [], roots: [] } };
  if (plan.unchanged && plan.source)
    return {
      page: PageStore.summary(plan.source),
      ownerBlockId: plan.source.owner_block_id,
      changed: { pages: [], roots: [] },
    };
  const timestamp = DateTime.formatIso(DateTime.makeUnsafe(now));
  const changed = new Map<C.SpacePageId, Map<string, BlockStore.BlockRow | null>>();
  const mark = (id: C.SpacePageId) => {
    if (!changed.has(id)) changed.set(id, new Map());
  };
  const writes = new Map<string, BlockStore.BlockRow>();
  const writeBlock = (row: BlockStore.BlockRow, old: BlockStore.BlockRow | null) => {
    checkLimit("maxBlockBytes", row.logical_bytes);
    const target = C.SpacePageId.make(row.page_id);
    mark(target);
    changed.get(target)!.set(row.block_id, old ? { ...old } : null);
    if (old && old.page_id !== row.page_id) {
      const source = C.SpacePageId.make(old.page_id);
      mark(source);
      changed.get(source)!.set(row.block_id, { ...old });
    }
    plan.produced({ ...row });
    writes.set(row.block_id, row);
  };
  const relocate = (
    old: BlockStore.BlockRow,
    pageId: C.SpacePageId,
    parentId: string | null,
    rank: string,
  ) => {
    const raw = BlockStore.storedBlockFromRow(old);
    const content =
      raw.type === "child_page" &&
      raw.content !== null &&
      typeof raw.content === "object" &&
      !Array.isArray(raw.content)
        ? Object.fromEntries(Object.entries(raw.content).filter(([key]) => key !== "pageId"))
        : raw.content;
    const payload = canonical({ ...raw, parentId, order: rank, content });
    return {
      ...old,
      page_id: pageId,
      parent_id: parentId,
      rank,
      payload,
      logical_bytes: Buffer.byteLength(payload, "utf8"),
    };
  };
  for (const rank of plan.ranks) {
    if (rank.kind === "page") {
      mark(C.SpacePageId.make(rank.id));
    } else {
      const old = plan.blocks.get(rank.id)!;
      writeBlock(relocate(old, C.SpacePageId.make(old.page_id), old.parent_id, rank.rank), old);
    }
  }
  for (const id of plan.rankOwnedPages) mark(id);
  const pageId = plan.movingBlocks
    ? plan.sourcePageId
    : (plan.source?.page_id ?? C.SpacePageId.make(NodeCrypto.randomUUID()));
  const spaceId =
    destination.kind === "root"
      ? destination.spaceId
      : plan.pages.get(destination.placement.pageId)!.space_id;
  let ownerBlockId: C.SpaceBlockId | null = null;
  if (plan.movingBlocks) {
    if (destination.kind !== "child") return yield* invalid();
    for (const id of plan.selectedBlocks) {
      const old = plan.blocks.get(id)!;
      const selectedIndex = plan.selectedRoots.indexOf(C.SpaceBlockId.make(id));
      const row =
        selectedIndex >= 0
          ? relocate(
              old,
              destination.placement.pageId,
              destination.placement.parentId,
              plan.placementRanks[selectedIndex]!,
            )
          : { ...old, page_id: destination.placement.pageId };
      if (old.page_id === row.page_id && old.payload === row.payload) continue;
      writeBlock(row, old);
      const owned = [...plan.pages.values()].find((page) => page.owner_block_id === id);
      if (owned) mark(owned.page_id);
    }
  } else if (destination.kind === "child") {
    const existingOwner = plan.source?.owner_block_id ?? null;
    ownerBlockId = existingOwner ?? C.SpaceBlockId.make(NodeCrypto.randomUUID());
    const old = existingOwner === null ? null : plan.blocks.get(existingOwner)!;
    const payload = canonical({
      id: ownerBlockId,
      parentId: destination.placement.parentId,
      order: plan.rank,
      type: "child_page",
      version: 1,
      content: {},
    });
    const row = old
      ? relocate(old, destination.placement.pageId, destination.placement.parentId, plan.rank)
      : {
          block_id: ownerBlockId,
          page_id: destination.placement.pageId,
          parent_id: destination.placement.parentId,
          rank: plan.rank,
          payload,
          logical_bytes: Buffer.byteLength(payload, "utf8"),
          deleted: 0,
          merged_into: null,
        };
    if (!old) yield* sql`INSERT INTO spaces_ids(id,kind) VALUES (${ownerBlockId},'block')`;
    writeBlock(row, old);
  } else if (plan.source?.owner_block_id) {
    const old = plan.blocks.get(plan.source.owner_block_id)!;
    const payload = canonical({ id: old.block_id, pageId: old.page_id, mergedInto: null });
    writeBlock(
      {
        ...old,
        payload,
        logical_bytes: Buffer.byteLength(payload, "utf8"),
        deleted: 1,
        merged_into: null,
      },
      old,
    );
  }
  if (!plan.source && !plan.movingBlocks) {
    if (title === undefined) return yield* invalid();
    plan.produced({
      page_id: pageId,
      space_id: spaceId,
      title,
      root_order: null,
      revision: 0,
      created_at: timestamp,
      updated_at: timestamp,
      block_count: 0,
      block_bytes: 0,
      retained_revision_count: 0,
      retained_revision_bytes: 0,
    });
    yield* sql`INSERT INTO spaces_ids(id,kind) VALUES (${pageId},'page')`;
    yield* sql`INSERT INTO spaces_pages(page_id,space_id,title,root_order,created_at,updated_at) VALUES (${pageId},${spaceId},${title},NULL,${timestamp},${timestamp})`;
  }
  for (const row of writes.values()) {
    if (plan.blocks.has(row.block_id)) {
      yield* sql`UPDATE spaces_blocks SET page_id=${row.page_id},parent_id=${row.parent_id},rank=${row.rank},payload=${row.payload},logical_bytes=${row.logical_bytes},deleted=${row.deleted},merged_into=${row.merged_into} WHERE block_id=${row.block_id}`;
      continue;
    }
    yield* sql`INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes,deleted,merged_into)
      VALUES (${row.block_id},${row.page_id},${row.parent_id},${row.rank},${row.payload},${row.logical_bytes},${row.deleted},${row.merged_into})
      ON CONFLICT(block_id) DO UPDATE SET page_id=excluded.page_id,parent_id=excluded.parent_id,rank=excluded.rank,payload=excluded.payload,logical_bytes=excluded.logical_bytes,deleted=excluded.deleted,merged_into=excluded.merged_into`;
  }
  if (!plan.movingBlocks) {
    if (ownerBlockId !== null)
      yield* sql`INSERT INTO spaces_page_owners(child_page_id,owner_block_id) VALUES (${pageId},${ownerBlockId}) ON CONFLICT(child_page_id) DO UPDATE SET owner_block_id = excluded.owner_block_id`;
    else yield* sql`DELETE FROM spaces_page_owners WHERE child_page_id = ${pageId}`;
  }
  const counters = new Map<C.SpacePageId, { count: number; bytes: number }>();
  for (const [id, row] of plan.pages)
    counters.set(id, { count: row.block_count, bytes: row.block_bytes });
  for (const row of writes.values()) {
    const old = plan.blocks.get(row.block_id);
    if (old) {
      const from = counters.get(C.SpacePageId.make(old.page_id))!;
      from.count--;
      from.bytes -= old.logical_bytes;
    }
    const to = counters.get(C.SpacePageId.make(row.page_id))!;
    if (!row.deleted) {
      to.count++;
      to.bytes += row.logical_bytes;
    }
  }
  for (const id of plan.movingPages) if (plan.pages.get(id)!.space_id !== spaceId) mark(id);
  if (plan.source) mark(pageId);
  const rootChanges = new Set<C.SpaceId>();
  if (plan.source?.root_order !== null && plan.source !== undefined)
    rootChanges.add(plan.source.space_id);
  if (destination.kind === "root") rootChanges.add(spaceId);
  for (const [id] of changed) {
    const old = plan.pages.get(id)!;
    const counter = counters.get(id)!;
    checkLimit("maxPageBlocks", counter.count);
    checkLimit("maxPageBytes", counter.bytes);
    const rootRank =
      !plan.movingBlocks && id === pageId
        ? destination.kind === "root"
          ? plan.rank
          : null
        : (plan.ranks.find((row) => row.kind === "page" && row.id === id)?.rank ?? old.root_order);
    const memberSpace = plan.movingPages.has(id) ? spaceId : old.space_id;
    plan.produced({
      pageId: id,
      spaceId: memberSpace,
      rootOrder: rootRank,
      revision: old.revision + 1,
      blockCount: counter.count,
      blockBytes: counter.bytes,
    });
    yield* sql`UPDATE spaces_pages SET space_id=${memberSpace},root_order=${rootRank},revision=revision+1,block_count=${counter.count},block_bytes=${counter.bytes},updated_at=${timestamp} WHERE page_id=${id}`;
  }
  const historyBudget = RevisionStore.createCaptureBudget();
  if (!plan.source && !plan.movingBlocks)
    yield* RevisionStore.capture(
      { pageId, toRevision: 0, mutationId, pageBefore: null, ownerBefore: null, blocksBefore: [] },
      now,
      historyBudget,
    );
  for (const [id, rows] of changed) {
    const old = plan.pages.get(id)!;
    yield* RevisionStore.capture(
      {
        pageId: id,
        toRevision: old.revision + 1,
        mutationId,
        pageBefore: preimage(old),
        ownerBefore: ownerBefore(old),
        blocksBefore: [...rows].map(([id, row]) => ({ id, row })),
      },
      now,
      historyBudget,
    );
  }
  yield* ReferenceStore.release(
    [...writes.values()].filter((row) => row.deleted).map((row) => row.block_id),
  );
  for (const id of rootChanges)
    yield* sql`UPDATE spaces SET root_order_revision=root_order_revision+1,updated_at=${timestamp} WHERE space_id=${id}`;
  yield* sql`UPDATE spaces_core SET catalog_revision=catalog_revision+1 WHERE singleton=1`;
  for (const id of new Set([pageId, ...changed.keys()])) yield* PageStore.read(id);
  const changedGuards = {
    pages: [
      ...(plan.source || plan.movingBlocks ? [] : [{ pageId, revision: 0 }]),
      ...[...changed.keys()].map((id) => ({
        pageId: id,
        revision: plan.pages.get(id)!.revision + 1,
      })),
    ],
    roots: [...rootChanges].map((id) => ({
      spaceId: id,
      rootOrderRevision: plan.roots.get(id)!.rootOrderRevision + 1,
    })),
  };
  return plan.movingBlocks
    ? { blockIds: plan.selectedRoots, changed: changedGuards }
    : {
        page: PageStore.summary(yield* PageStore.read(pageId)),
        ownerBlockId,
        changed: changedGuards,
      };
});
