import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCommentThreadId, SpacePageId } from "@t2code/contracts/spaces";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export interface SpaceCommentsPanelTarget {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly commentThreadId?: SpaceCommentThreadId;
}

/** The page whose comments panel is open. The page header, narrow layouts and the palette set it. */
export const spaceCommentsPanelAtom = Atom.make<SpaceCommentsPanelTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("space-comments:panel"),
);

export function openSpaceCommentsPanel(target: SpaceCommentsPanelTarget): void {
  appAtomRegistry.set(spaceCommentsPanelAtom, target);
}
