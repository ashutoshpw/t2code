import type { EnvironmentId } from "@t2code/contracts";
import {
  SpaceRootReorder,
  checkSpaceStructureDrafts,
  type SpaceDraftStore,
  type SpaceRootReorderPorts,
  type SpaceStructureStore,
} from "@t2code/client-runtime/spaces";
import type { MobileSpaceDocuments } from "./documents";
import type {
  SpaceBlockId,
  SpacePageSummary,
  SpaceReadBlocksResult,
} from "@t2code/contracts/spaces";

export async function selectMobileSpacesBlockMove(
  owner: SpaceRootReorder,
  page: SpacePageSummary,
  window: SpaceReadBlocksResult,
  selected: readonly SpaceBlockId[],
) {
  if (
    window.nextCursor !== null ||
    window.revision !== page.revision ||
    selected.some((id) => !window.blocks.some((block) => block.id === id))
  )
    throw new Error("Block moves require the current complete loaded window");
  const proof = await owner.selectBlocks(page.id, window.revision, selected);
  if (!proof.inverse)
    throw new Error(
      "Mixed or noncontiguous origins are unavailable on mobile; select contiguous subtree roots in one container",
    );
  return proof;
}

export function createMobileSpaceStructure(
  environmentId: EnvironmentId,
  ports: Omit<SpaceRootReorderPorts, "store" | "reserve" | "checkDrafts" | "refresh"> & {
    readonly store: SpaceStructureStore;
    readonly drafts: SpaceDraftStore;
    readonly documents: MobileSpaceDocuments;
    readonly media?: Pick<
      import("@t2code/client-runtime/spaces").SpaceImageUploads<
        import("./originals").NativeSpaceOriginal
      >,
      "reserve" | "checkPages"
    >;
  },
) {
  return new SpaceRootReorder(environmentId, {
    ...ports,
    reserve: (pages, restoring) => {
      const releaseMedia = ports.media?.reserve(environmentId, pages);
      try {
        const release = ports.documents.reserve(environmentId, pages, restoring);
        return () => {
          release();
          releaseMedia?.();
        };
      } catch (error) {
        releaseMedia?.();
        throw error;
      }
    },
    checkDrafts: async (pages) => {
      await ports.media?.checkPages(environmentId, pages);
      await checkSpaceStructureDrafts(ports.drafts, environmentId, pages);
    },
    refresh: (pages) => ports.documents.refreshStructure(environmentId, pages),
  });
}
