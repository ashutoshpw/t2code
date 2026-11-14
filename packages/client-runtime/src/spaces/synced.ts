import type { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, type SpaceReadSubtreeResult } from "@t2code/contracts/spaces";

const SPACE_SYNCED_CLIPBOARD_PREFIX = "t2-synced-block:";

/** The text a "Copy and sync" action puts on the clipboard; pasting it on a page creates a copy. */
export function encodeSyncedClipboard(environmentId: EnvironmentId, blockId: SpaceBlockId): string {
  return `${SPACE_SYNCED_CLIPBOARD_PREFIX}${encodeURIComponent(environmentId)}:${encodeURIComponent(blockId)}`;
}

/** The original's block id, or null for other text or another environment's marker. */
export function parseSyncedClipboard(
  text: string,
  environmentId: EnvironmentId,
): SpaceBlockId | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SPACE_SYNCED_CLIPBOARD_PREFIX)) return null;
  const parts = trimmed.slice(SPACE_SYNCED_CLIPBOARD_PREFIX.length).split(":");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  try {
    if (decodeURIComponent(parts[0]!) !== environmentId) return null;
    return SpaceBlockId.make(decodeURIComponent(parts[1]!));
  } catch {
    return null;
  }
}

type SyncedRefState = "loading" | "editable" | "readonly" | "deleted" | "unavailable";

/** What a copy shows: editable only for a complete original while the viewer may write to Spaces. */
export function syncedRefState(
  result: SpaceReadSubtreeResult | undefined,
  writable: boolean,
): SyncedRefState {
  if (result === undefined) return "loading";
  if (result.status !== "found") return result.status;
  return writable && result.complete ? "editable" : "readonly";
}
