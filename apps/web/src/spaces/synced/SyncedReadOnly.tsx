import { useState, type ReactNode } from "react";
import type { SpaceBlock, SpacePageId } from "@t2code/contracts/spaces";

import { staticAdapter } from "~/components/sharedPage/staticAdapter";
import { SpaceEditor } from "../SpaceEditor";
import { SyncedHostContext, SyncedStaticContext } from "./SyncedContext";

/** The original's blocks, read only; remount it (change its key) when the blocks change. */
export function SyncedReadOnly({
  pageId,
  blocks,
  renderChild,
}: {
  readonly pageId: SpacePageId;
  readonly blocks: readonly SpaceBlock[];
  readonly renderChild: ((block: SpaceBlock) => ReactNode) | undefined;
}) {
  const [adapter] = useState(() => staticAdapter(pageId, { revision: 0, blocks }));
  return (
    <SyncedHostContext.Provider value={null}>
      <SyncedStaticContext.Provider value={null}>
        <SpaceEditor embedded adapter={adapter} editable={false} renderChild={renderChild} />
      </SyncedStaticContext.Provider>
    </SyncedHostContext.Provider>
  );
}
