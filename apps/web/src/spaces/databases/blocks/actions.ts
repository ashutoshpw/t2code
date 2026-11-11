import type { SpaceViewId } from "@t2code/contracts/spaces";

export interface DatabaseBlockActions {
  /** False when the page is not editable. */
  setViews(viewIds: ReadonlyArray<SpaceViewId>): boolean;
  remove(): boolean;
}
