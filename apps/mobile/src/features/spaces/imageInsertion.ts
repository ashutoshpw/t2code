import { SpaceBlockId } from "@t2code/contracts/spaces";
import { mediaAssetId, type SpaceImageInsertion } from "@t2code/client-runtime/spaces";
import type { SpacesPageReader } from "./reader";

import { allocateMobileSpaceRootOrder } from "./blockOrder";

export function mobileSpaceImageInsertion(
  reader: SpacesPageReader,
  current: () => boolean,
  newId: () => string,
): SpaceImageInsertion {
  const state = () => reader.session.getSnapshot();
  const assertReady = () => {
    const editing = reader.editing.getSnapshot();
    reader.assertContentReady();
    if (
      !current() ||
      editing.focus ||
      editing.busy ||
      !reader.completeImageWindow() ||
      state().pending ||
      state().persistenceError ||
      state().status === "conflict"
    )
      throw new Error("Media insertion needs the current complete first window and finished input");
  };
  return {
    key: reader.session.key,
    current,
    state,
    complete: () => reader.completeImageWindow(),
    persist: async () => {
      if (reader.editing.getSnapshot().focus || reader.editing.getSnapshot().busy)
        throw new Error("Finish native input before binding or releasing an original");
      await reader.session.persistDraft();
    },
    plan: (assetId, kind = "image") => {
      assertReady();
      const snapshot = state();
      if (
        !["image", "pdf", "video"].includes(kind) ||
        snapshot.dirty ||
        snapshot.history.action ||
        snapshot.blocks.length >= 99 ||
        snapshot.baseRevision === null
      )
        throw new Error("Save other edits and use a complete page with room for one media block");
      const last = snapshot.blocks.findLast((block) => block.parentId === null);
      return {
        block: {
          id: SpaceBlockId.make(newId()),
          parentId: null,
          order: allocateMobileSpaceRootOrder(last?.order ?? null),
          type: kind,
          version: 1,
          content: { assetId },
        },
        revision: snapshot.baseRevision,
        generation: snapshot.generation,
        windowIds: snapshot.blocks.map((block) => block.id),
      };
    },
    apply: (placement) => {
      assertReady();
      const snapshot = state();
      const last = snapshot.blocks.findLast((block) => block.parentId === null);
      if (
        snapshot.baseRevision !== placement.revision ||
        snapshot.generation !== placement.generation ||
        snapshot.blocks.length >= 99 ||
        JSON.stringify(snapshot.blocks.map((b) => b.id)) !== JSON.stringify(placement.windowIds) ||
        snapshot.blocks.some((b) => b.id === placement.block.id) ||
        placement.block.parentId !== null ||
        mediaAssetId(placement.block) === null ||
        placement.block.order !== allocateMobileSpaceRootOrder(last?.order ?? null)
      )
        throw new Error("The frozen media placement changed; original retained");
      reader.session.apply([{ kind: "insert", block: placement.block }]);
    },
  };
}
