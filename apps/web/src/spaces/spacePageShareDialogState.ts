import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export interface SpacePageShareTarget {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}

/** The page whose share dialog is open. The page menu, header and command palette all set it. */
export const spacePageShareDialogAtom = Atom.make<SpacePageShareTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("space-page-share:dialog"),
);

export function openSpacePageShareDialog(target: SpacePageShareTarget): void {
  appAtomRegistry.set(spacePageShareDialogAtom, target);
}
