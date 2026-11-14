import * as Schema from "effect/Schema";

import { SpaceBlockId, SpacePageIcon, spaceBlockBase } from "./spacesCore.ts";

export const SPACE_TAB_TITLE_MAX_LENGTH = 100;

/** Not part of SpaceKnownBlock: older clients see an unknown block and retain it. */
export const SpaceTabsBlock = Schema.Struct({
  ...spaceBlockBase,
  type: Schema.Literal("tabs"),
  content: Schema.Struct({}),
});
export type SpaceTabsBlock = typeof SpaceTabsBlock.Type;

export const SpaceTabPaneBlock = Schema.Struct({
  ...spaceBlockBase,
  type: Schema.Literal("tab_pane"),
  content: Schema.Struct({
    title: Schema.String.check(Schema.isMaxLength(SPACE_TAB_TITLE_MAX_LENGTH)),
    icon: Schema.optionalKey(SpacePageIcon),
  }),
});
export type SpaceTabPaneBlock = typeof SpaceTabPaneBlock.Type;

/** The original of a synced block; its children live on this page. */
export const SpaceSyncedBlock = Schema.Struct({
  ...spaceBlockBase,
  type: Schema.Literal("synced_block"),
  content: Schema.Struct({}),
});
export type SpaceSyncedBlock = typeof SpaceSyncedBlock.Type;

/** A copy of a synced_block elsewhere in the environment; it has no content of its own. */
export const SpaceSyncedRefBlock = Schema.Struct({
  ...spaceBlockBase,
  type: Schema.Literal("synced_ref"),
  content: Schema.Struct({ sourceBlockId: SpaceBlockId }),
});
export type SpaceSyncedRefBlock = typeof SpaceSyncedRefBlock.Type;

export const SPACE_LIST_CONTAINER_TYPES = [
  "bulleted_item",
  "numbered_item",
  "todo_item",
  "toggle",
] as const;

const EXTENSION_CONTAINER_TYPES: readonly string[] = ["tabs", "tab_pane", "synced_block"];

/** Types that may have child blocks. */
export function spaceHoldsChildren(type: string): boolean {
  return (
    EXTENSION_CONTAINER_TYPES.includes(type) ||
    SPACE_LIST_CONTAINER_TYPES.some((container) => container === type)
  );
}

const SYNCED_FORBIDDEN_TYPES: readonly string[] = [
  "synced_block",
  "synced_ref",
  "tabs",
  "tab_pane",
  "database",
  "child_page",
];

/** Whether a block of this type may sit anywhere inside a synced_block. */
export const spaceAllowedInSynced = (type: string) => !SYNCED_FORBIDDEN_TYPES.includes(type);

/** Whether moved blocks (depth 1 = the roots being placed) fit under `ancestorTypes`, nearest first. */
export function spaceMovesAllowed(
  moved: readonly { readonly depth: number; readonly type: string }[],
  ancestorTypes: readonly string[],
): boolean {
  const synced = ancestorTypes.includes("synced_block");
  return moved.every(({ depth, type }) =>
    depth === 1 ? spaceNestingAllowed(type, ancestorTypes) : !synced || spaceAllowedInSynced(type),
  );
}

/** Whether a block of `childType` may sit under ancestors listed nearest first; [] is the page root. */
export function spaceNestingAllowed(childType: string, ancestorTypes: readonly string[]): boolean {
  const parent = ancestorTypes[0];
  if (parent !== undefined && !spaceHoldsChildren(parent)) return false;
  // Inside a synced block, at any depth, no kind that could nest or cycle back.
  if (ancestorTypes.includes("synced_block") && !spaceAllowedInSynced(childType)) return false;
  if (childType === "tab_pane") return parent === "tabs";
  return parent !== "tabs";
}
