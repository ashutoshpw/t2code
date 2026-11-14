import { isSpaceTabPaneBlock, isSpaceTabsBlock } from "@t2code/client-runtime/spaces";
import { SpaceBlockId, type SpaceBlock } from "@t2code/contracts/spaces";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface VisibleTabPane {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
}

export interface VisibleSpaceBlock {
  readonly block: SpaceBlock;
  readonly depth: number;
  readonly tabs?: { readonly panes: readonly VisibleTabPane[]; readonly active: string };
}

const MAX_DEPTH = 16;

/** Kinds mobile only shows; the block and everything under it is never edited on mobile. */
const READ_ONLY_CONTAINER_TYPES: readonly string[] = [
  "tabs",
  "tab_pane",
  "synced_block",
  "synced_ref",
];

/** True when the block, or any loaded ancestor, is a tabs or synced kind. */
export function isMobileReadOnlyBlock(blocks: readonly SpaceBlock[], block: SpaceBlock): boolean {
  const byId = new Map(blocks.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (
    let current: SpaceBlock | undefined = block;
    current && !seen.has(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  ) {
    if (READ_ONLY_CONTAINER_TYPES.includes(current.type)) return true;
    seen.add(current.id);
  }
  return false;
}

/**
 * The rows the reader shows: pane rows and inactive panes' content are hidden, each tabs row carries
 * its loaded panes, and depth ignores tabs and pane ancestors so pane content lines up with its tabs.
 */
export function visibleSpaceBlocks(
  blocks: readonly SpaceBlock[],
  activePaneByTabs: ReadonlyMap<string, string>,
): readonly VisibleSpaceBlock[] {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const panesOf = new Map<string, VisibleTabPane[]>();
  for (const block of blocks) {
    if (block.parentId === null || !isSpaceTabPaneBlock(block)) continue;
    const panes = panesOf.get(block.parentId) ?? [];
    panes.push({
      id: block.id,
      title: block.content.title,
      ...(block.content.icon ? { icon: block.content.icon } : {}),
    });
    panesOf.set(block.parentId, panes);
  }
  const activeOf = (tabsId: string) => {
    const panes = panesOf.get(tabsId) ?? [];
    const chosen = activePaneByTabs.get(tabsId);
    return panes.find((pane) => pane.id === chosen)?.id ?? panes[0]?.id ?? "";
  };
  const rows: VisibleSpaceBlock[] = [];
  for (const block of blocks) {
    if (isSpaceTabPaneBlock(block)) continue;
    let hidden = false;
    let depth = 0;
    const seen = new Set([block.id]);
    let child: SpaceBlock = block;
    for (let steps = 0; child.parentId !== null && steps < MAX_DEPTH; steps++) {
      const parent = byId.get(child.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      if (isSpaceTabPaneBlock(parent) && parent.parentId !== null)
        hidden ||= activeOf(parent.parentId) !== parent.id;
      else if (!isSpaceTabsBlock(parent)) depth++;
      child = parent;
    }
    if (hidden) continue;
    if (isSpaceTabsBlock(block))
      rows.push({
        block,
        depth,
        tabs: { panes: panesOf.get(block.id) ?? [], active: activeOf(block.id) },
      });
    else rows.push({ block, depth });
  }
  return rows;
}

/** What a synced copy says when its original cannot be shown; null when there is content. */
export function syncedRefNotice(status: "found" | "deleted" | "unavailable"): string | null {
  return status === "deleted"
    ? "The original synced block was deleted."
    : status === "unavailable"
      ? "The original is unavailable (it may be in Trash)."
      : null;
}

const decodeBlockId = Schema.decodeUnknownOption(SpaceBlockId);

/** The original a `synced_ref` copy points at, or null when the block is not a well-formed copy. */
export function syncedRefSource(block: SpaceBlock): SpaceBlockId | null {
  if (block.type !== "synced_ref" || typeof block.content !== "object" || block.content === null)
    return null;
  const source = "sourceBlockId" in block.content ? block.content.sourceBlockId : undefined;
  const decoded = decodeBlockId(source);
  return Option.isSome(decoded) ? decoded.value : null;
}
