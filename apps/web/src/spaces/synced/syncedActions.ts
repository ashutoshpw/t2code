import { encodeSyncedClipboard } from "@t2code/client-runtime/spaces";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";
import type { EnvironmentId } from "@t2code/contracts";
import { SpaceMutationId, type SpaceBlockId } from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import type { AtomRegistry } from "effect/reactivity";

import { toastManager } from "../../components/ui/toast";
import { randomUUID } from "../../lib/utils";
import { spacesEnvironment } from "../../state/spaces";

/** Copies at most this many copies per call; the server bounds each unsync, so a long list takes several. */
const MAX_ROUNDS = 20;

/** Puts the marker on the clipboard that pasting turns into a copy of `blockId`. */
export async function copySyncedMarker(environmentId: EnvironmentId, blockId: SpaceBlockId) {
  try {
    await navigator.clipboard.writeText(encodeSyncedClipboard(environmentId, blockId));
    toastManager.add({
      type: "success",
      title: "Synced block copied",
      description: "Paste it on any page.",
    });
  } catch {
    toastManager.add({ type: "error", title: "Couldn't copy to the clipboard" });
  }
}

/**
 * Turns copies of an original into ordinary blocks: the listed copies, or every copy. Reads the
 * original each round, so the receipt epoch and the remaining copies are current.
 */
export async function unsyncCopies(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  sourceBlockId: SpaceBlockId,
  refBlockIds?: readonly SpaceBlockId[],
) {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const read = await executeAtomQuery(
      registry,
      spacesEnvironment.readSubtree({
        environmentId,
        input: { environmentId, blockId: sourceBlockId },
      }),
      { refresh: true, reportFailure: false },
    );
    if (read._tag !== "Success") throw Cause.squash(read.cause);
    const found = read.value;
    if (found.status !== "found") throw new Error("The original synced block is unavailable");
    if (refBlockIds === undefined && found.refCount === 0) return;
    const result = await spacesEnvironment.unsync.run(registry, {
      environmentId,
      input: {
        environmentId,
        mutationId: SpaceMutationId.make(randomUUID()),
        receiptEpoch: found.mutationAdmission.epoch,
        sourceBlockId,
        ...(refBlockIds === undefined ? {} : { refBlockIds }),
      },
    });
    if (result._tag !== "Success") throw Cause.squash(result.cause);
    if (refBlockIds !== undefined) return;
  }
}
