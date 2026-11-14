import type { SpaceBlockId, SpacePageId, SpaceViewId } from "@t2code/contracts/spaces";

export interface DatabaseBlockActions {
  /** False when the page is not editable. */
  setViews(viewIds: ReadonlyArray<SpaceViewId>): boolean;
  remove(): boolean;
  /** False when the page is not editable. */
  setTitleHidden(hidden: boolean): boolean;
  /** Only on the full-page route: tab edits reach this block through the server. */
  readonly remote?: { readonly pageId: SpacePageId; readonly blockId: SpaceBlockId };
}
