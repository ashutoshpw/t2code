import type { SpaceDatabaseBlock } from "@t2code/contracts/spaces";
import type { AtomRegistry } from "effect/reactivity";

import { toastManager } from "../../../components/ui/toast";
import type { SpaceDocumentController } from "../../documentController";
import { databaseErrorMessage } from "@t2code/client-runtime/spaces";
import { databasePorts } from "../data/ports";

/**
 * Creates the database, places its block through `place`, and saves the page. A failed save
 * leaves a dead database that comes alive when the draft lands (the server adopts it with the block).
 */
export async function createDatabaseBlock({
  registry,
  controller,
  place,
}: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly controller: SpaceDocumentController;
  readonly place: (content: SpaceDatabaseBlock["content"]) => boolean;
}): Promise<void> {
  const spaceId = controller.getSnapshot().metadata?.page.spaceId;
  if (spaceId === undefined) {
    toastManager.add({ type: "error", title: "Couldn't create the database" });
    return;
  }
  let created;
  try {
    created = await databasePorts.run.create(registry, controller.session.key.environmentId, {
      spaceId,
      title: "",
    });
  } catch (failure) {
    toastManager.add({
      type: "error",
      title: "Couldn't create the database",
      description: databaseErrorMessage(failure),
    });
    return;
  }
  if (!place({ databaseId: created.databaseId, viewIds: [created.viewId] })) {
    toastManager.add({ type: "error", title: "Couldn't place the database on this page" });
    return;
  }
  try {
    await controller.save();
  } catch {
    toastManager.add({ type: "error", title: "The database will appear once this page saves" });
  }
}
