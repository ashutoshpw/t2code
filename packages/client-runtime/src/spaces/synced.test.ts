import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageId,
  SpaceReceiptEpoch,
  type SpaceReadSubtreeResult,
} from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { encodeSyncedClipboard, parseSyncedClipboard, syncedRefState } from "./synced.ts";

const environmentId = EnvironmentId.make("environment-1");
const blockId = SpaceBlockId.make("block:1");

const found = (complete: boolean): SpaceReadSubtreeResult => ({
  status: "found",
  complete,
  page: {
    id: SpacePageId.make("page-1"),
    spaceId: SpaceId.make("space-1"),
    title: "Source",
    revision: 1,
    rootOrder: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  mutationAdmission: {
    epoch: SpaceReceiptEpoch.make("epoch"),
    acceptsUntil: "2026-01-01T00:00:00.000Z",
    retainUntil: "2026-01-01T00:00:00.000Z",
  },
  revision: 1,
  blocks: [],
  refs: [],
  refCount: 0,
});

describe("synced block clipboard marker", () => {
  it("round-trips ids with separators and ignores other text or environments", () => {
    const text = encodeSyncedClipboard(environmentId, blockId);
    expect(parseSyncedClipboard(text, environmentId)).toBe(blockId);
    expect(parseSyncedClipboard(`  ${text}\n`, environmentId)).toBe(blockId);
    expect(parseSyncedClipboard(text, EnvironmentId.make("environment-2"))).toBeNull();
    for (const other of [
      "",
      "hello",
      "t2-synced-block:",
      "t2-synced-block:a",
      "t2-synced-block:a:b:c",
      "t2-synced-block:%E0%A4%A:b",
    ])
      expect(parseSyncedClipboard(other, environmentId)).toBeNull();
  });
});

describe("syncedRefState", () => {
  it.each([
    [undefined, true, "loading"],
    [{ status: "deleted" }, true, "deleted"],
    [{ status: "unavailable" }, true, "unavailable"],
    [found(true), true, "editable"],
    [found(true), false, "readonly"],
    [found(false), true, "readonly"],
  ] satisfies ReadonlyArray<readonly [SpaceReadSubtreeResult | undefined, boolean, string]>)(
    "%j with write=%s is %s",
    (result, writable, state) => {
      expect(syncedRefState(result, writable)).toBe(state);
    },
  );
});
