import type { EnvironmentId } from "@t2code/contracts";
import {
  SpaceRootReorder,
  checkSpaceStructureDrafts,
  type SpaceDraftStore,
  type SpaceRootReorderPorts,
  type SpaceStructureStore,
} from "@t2code/client-runtime/spaces";
import type { MobileSpaceDocuments } from "./documents";

export function createMobileSpaceStructure(
  environmentId: EnvironmentId,
  ports: Omit<SpaceRootReorderPorts, "store" | "reserve" | "checkDrafts" | "refresh"> & {
    readonly store: SpaceStructureStore;
    readonly drafts: SpaceDraftStore;
    readonly documents: MobileSpaceDocuments;
  },
) {
  return new SpaceRootReorder(environmentId, {
    ...ports,
    reserve: (pages, restoring) => ports.documents.reserve(environmentId, pages, restoring),
    checkDrafts: (pages) => checkSpaceStructureDrafts(ports.drafts, environmentId, pages),
    refresh: (pages) => ports.documents.refreshStructure(environmentId, pages),
  });
}
