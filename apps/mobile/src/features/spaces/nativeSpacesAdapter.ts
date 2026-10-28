import {
  canEditSpaceBlockOnMobile,
  isKnownSpaceBlock,
  isSafeSpaceLink,
  spaceBlockRuns,
} from "@t2code/client-runtime/spaces";
import type { SpaceBlock, SpaceMark, SpaceRichText } from "@t2code/contracts/spaces";

import {
  decodeSpacesNativeSnapshot,
  type SpacesNativeDocument,
  type SpacesNativeRun,
  type SpacesNativeSnapshot,
} from "./nativeSpacesProtocol";

// Provisional per-focused-block limits; larger blocks remain intact in the read-only renderer.
export const SPACES_NATIVE_MAX_UTF16 = 16_384;
export const SPACES_NATIVE_MAX_RUNS = 1_024;

function validateNativeRuns(snapshot: SpacesNativeSnapshot) {
  if (
    snapshot.runs.length > SPACES_NATIVE_MAX_RUNS ||
    snapshot.runs.reduce((length, run) => length + run.text.length, 0) > SPACES_NATIVE_MAX_UTF16
  ) {
    throw new Error("Native block exceeds the spike budget");
  }
  if (snapshot.runs.some((run) => run.link !== undefined && !isSafeSpaceLink(run.link))) {
    throw new Error("Unsupported native link");
  }
}

function supported(block: SpaceBlock): SpaceRichText | null {
  if (!canEditSpaceBlockOnMobile(block)) return null;
  const runs = spaceBlockRuns(block);
  if (
    !runs ||
    runs.length > SPACES_NATIVE_MAX_RUNS ||
    runs.reduce((length, run) => length + run.text.length, 0) > SPACES_NATIVE_MAX_UTF16 ||
    runs.some((run) => new Set(run.marks.map((mark) => mark.type)).size !== run.marks.length)
  )
    return null;
  return runs;
}

function mergeRuns(runs: readonly SpacesNativeRun[]): readonly SpacesNativeRun[] {
  const result: SpacesNativeRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = result.at(-1);
    if (
      last &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.code === run.code &&
      last.link === run.link
    ) {
      result[result.length - 1] = { ...last, text: last.text + run.text };
    } else {
      result.push(run);
    }
  }
  return result;
}

export function nativeDocumentForSpaceBlock(block: SpaceBlock): SpacesNativeDocument | null {
  const runs = supported(block);
  if (!runs) return null;
  return {
    version: 1,
    revision: 0,
    runs: mergeRuns(
      runs.map((run) => {
        const link = run.marks.find((mark) => mark.type === "link");
        return {
          text: run.text,
          bold: run.marks.some((mark) => mark.type === "bold"),
          italic: run.marks.some((mark) => mark.type === "italic"),
          code: run.marks.some((mark) => mark.type === "code"),
          ...(link && typeof link.href === "string" ? { link: link.href } : {}),
        };
      }),
    ),
    selection: { start: 0, end: 0 },
  };
}

export function applySpacesNativeSnapshot(block: SpaceBlock, value: unknown): SpaceBlock {
  if (!supported(block) || !isKnownSpaceBlock(block) || !("runs" in block.content)) {
    throw new Error("Block is read-only on mobile");
  }
  const snapshot = decodeSpacesNativeSnapshot(value);
  if (snapshot.composing) throw new Error("Cannot publish an uncommitted composition");
  validateNativeRuns(snapshot);
  const runs = mergeRuns(snapshot.runs).map((run) => {
    const marks: SpaceMark[] = [];
    if (run.bold) marks.push({ type: "bold", version: 1 });
    if (run.italic) marks.push({ type: "italic", version: 1 });
    if (run.code) marks.push({ type: "code", version: 1 });
    if (run.link !== undefined) {
      marks.push({ type: "link", version: 1, href: run.link });
    }
    return { text: run.text, marks };
  });
  return { ...block, content: { ...block.content, runs } };
}

export function receiveSpacesNativeSnapshot(
  previous: SpacesNativeSnapshot,
  value: unknown,
): SpacesNativeSnapshot {
  const snapshot = decodeSpacesNativeSnapshot(value);
  if (snapshot.revision < previous.revision) return previous;
  validateNativeRuns(snapshot);
  return snapshot;
}
