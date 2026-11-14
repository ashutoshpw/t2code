import type { EnvironmentId } from "@t2code/contracts";
import {
  SPACE_PAGE_SHARE_BLOCK_PARAM,
  SPACE_PAGE_SHARE_FORM_PARAM,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_VIEW_PARAM,
} from "@t2code/contracts";
import type { SpaceBlockId, SpacePageId, SpaceViewId } from "@t2code/contracts/spaces";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export interface SpacePageShareTarget {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  /** A form view on the page: the dialog also offers its public link. */
  readonly form?: { readonly blockId: SpaceBlockId; readonly viewId: SpaceViewId };
}

/** The page whose share dialog is open. The page menu, header and command palette all set it. */
export const spacePageShareDialogAtom = Atom.make<SpacePageShareTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("space-page-share:dialog"),
);

export function openSpacePageShareDialog(target: SpacePageShareTarget): void {
  appAtomRegistry.set(spacePageShareDialogAtom, target);
}

/** The link's viewer URL narrowed to one form: the query goes before the `#credential`. */
export function formLinkUrl(
  url: string,
  pageId: SpacePageId,
  form: NonNullable<SpacePageShareTarget["form"]>,
): string {
  const hash = url.indexOf("#");
  const head = hash < 0 ? url : url.slice(0, hash);
  const tail = hash < 0 ? "" : url.slice(hash);
  const query = new URLSearchParams({
    [SPACE_PAGE_SHARE_PAGE_PARAM]: pageId,
    [SPACE_PAGE_SHARE_BLOCK_PARAM]: form.blockId,
    [SPACE_PAGE_SHARE_VIEW_PARAM]: form.viewId,
    [SPACE_PAGE_SHARE_FORM_PARAM]: "1",
  });
  return `${head}${head.includes("?") ? "&" : "?"}${query}${tail}`;
}
