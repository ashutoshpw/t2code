import { createContext } from "react";
import type { AtomRegistry } from "effect/reactivity";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceBlock,
  SpaceBlockId,
  SpacePageId,
  SpaceReadSubtreeResult,
} from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";

import type { SpaceDocumentController } from "../documentController";

/** What a synced block needs from the page that hosts it. */
export interface SyncedHost {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly openPage: (target: SpacePageNavigationTarget) => void;
  /** Whether the hosting document has no unsaved work, so a structural change may run. */
  readonly hostClean: () => boolean;
  readonly saveHost: () => Promise<void>;
  readonly refreshHost: () => Promise<void>;
  /** Asks the user to confirm turning every copy of an original into ordinary blocks. */
  readonly confirmUnsyncAll: (blockId: SpaceBlockId) => void;
}

export const SyncedHostContext = createContext<SyncedHost | null>(null);

/** The originals a shared page embeds, by original block id. */
type SyncedStaticEntries = ReadonlyMap<
  SpaceBlockId,
  { readonly blocks: readonly SpaceBlock[]; readonly complete: boolean }
>;

export const SyncedStaticContext = createContext<SyncedStaticEntries | null>(null);

/** What a synced copy reads and opens; the app supplies the real ones and tests supply stand-ins. */
export interface SyncedPorts {
  readonly useSubtree: (
    environmentId: EnvironmentId,
    blockId: SpaceBlockId | null,
  ) => { readonly data: SpaceReadSubtreeResult | null; readonly error: string | null };
  readonly useWritable: (environmentId: EnvironmentId) => boolean;
  readonly createController: (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    source: { readonly blockId: SpaceBlockId; readonly pageId: SpacePageId },
  ) => SpaceDocumentController;
}

export const SyncedPortsContext = createContext<SyncedPorts | null>(null);
