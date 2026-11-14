// @effect-diagnostics nodeBuiltinImport:off -- snapshot hashes use the platform SHA-256 implementation.
import * as NodeCrypto from "node:crypto";
import {
  SPACE_CONTEXT_LIMITS,
  SpaceContextCaptureResult,
  type SpaceContextCaptureInput,
  type SpaceContextSnapshot,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import {
  sanitizeComposerContextLabel,
  serializeSpaceContextSnapshotForHash,
} from "@t2code/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/sql/SqlError";
import * as BlockStore from "./BlockStore.ts";
import * as PageStore from "./PageStore.ts";
import * as ReferenceStore from "./ReferenceStore.ts";
import * as SpacesSql from "./SpacesSql.ts";
import { byteLength } from "./CorePolicy.ts";

const captureLimits = { pages: 8, blocks: 256, depth: 16, bytes: 2_097_152 } as const;
const marker = "\n… truncated …";
const knownBlock = Schema.decodeUnknownOption(C.SpaceKnownBlock);
const validResult = Schema.is(SpaceContextCaptureResult);

function clip(text: string, chars: number, bytes: number) {
  let end = 0;
  let size = 0;
  for (const point of text) {
    const nextSize = Buffer.byteLength(point, "utf8");
    if (end + point.length > chars || size + nextSize > bytes) break;
    end += point.length;
    size += nextSize;
  }
  return { text: text.slice(0, end), truncated: end < text.length };
}

function blockText(block: C.SpaceBlock) {
  const known = Option.getOrUndefined(knownBlock(block));
  if (!known) return "[Unsupported block]";
  const content = known.content;
  if ("runs" in content) return content.runs.map((run) => run.text).join("");
  if ("text" in content) return content.text;
  if ("assetId" in content)
    return `[${known.type} ${content.assetId}]${content.caption ? ` ${content.caption.map((run) => run.text).join("")}` : ""}`;
  if ("pageId" in content) return `[child_page ${content.pageId}]`;
  return "---";
}

type Source = Omit<SpaceContextSnapshot["sources"][number], "blockIds"> & {
  blockIds: C.SpaceBlockId[];
};
interface Frame {
  pageId: C.SpacePageId;
  parentId: C.SpaceBlockId | null;
  after: { rank: string; id: string } | null;
  depth: number;
  only?: C.SpaceBlockId;
}
interface Header {
  readonly block_id: string;
  readonly rank: string;
  readonly payload_bytes: number;
}

export const capture = Effect.fn("SpacesContextSnapshot.capture")(function* (
  input: SpaceContextCaptureInput,
): Effect.fn.Return<
  SpaceContextCaptureResult,
  C.SpaceServiceError | SqlError.SqlError,
  SpacesSql.SpacesSql
> {
  const resolved = yield* ReferenceStore.resolve(input.target);
  if (resolved.status !== "resolved" && resolved.status !== "merged")
    return { status: resolved.status === "deleted" ? "deleted" : "unavailable" };
  const sql = yield* SpacesSql.SpacesSql;
  const root = resolved.page;
  const title = clip(root.title, 200, 800).text;
  const sources: Source[] = [
    {
      environmentId: input.environmentId,
      spaceId: root.spaceId,
      pageId: root.id,
      revision: root.revision,
      blockIds: [],
    },
  ];
  const pages = new Set([root.id]);
  const blocks = new Set<C.SpaceBlockId>();
  let inspected = 0;
  let inspectedBytes = 0;
  let text = "";
  let truncated = false;
  const stack: Frame[] = [
    {
      pageId: root.id,
      parentId: null,
      after: null,
      depth: 1,
      ...(input.target.kind === "block" && resolved.blockId ? { only: resolved.blockId } : {}),
    },
  ];
  const record = () => {
    const base = {
      version: 1 as const,
      contextId: input.contextId,
      label: sanitizeComposerContextLabel(title || "Untitled page", input.target.kind),
      title,
      environmentId: input.environmentId,
      spaceId: root.spaceId,
      pageId: root.id,
      snapshot: {
        version: 1 as const,
        includeChildPages: input.includeChildPages ?? false,
        truncated,
        text,
        sources,
        contentHash: `sha256:${"0".repeat(64)}`,
      },
    };
    return input.target.kind === "page"
      ? { ...base, kind: "page" as const }
      : {
          ...base,
          kind: "block" as const,
          blockId: input.target.blockId,
          resolvedBlockId: resolved.blockId!,
        };
  };
  while (stack.length > 0) {
    if (inspected >= captureLimits.blocks) {
      truncated = true;
      break;
    }
    const frame = stack[stack.length - 1]!;
    const after = frame.after
      ? sql`AND (rank,block_id) > (${frame.after.rank},${frame.after.id})`
      : sql``;
    // octet_length reads only the record header; a cast would fetch overflow pages.
    // Root-block liveness was resolved in this transaction; deleted is stored after payload.
    const [header] = frame.only
      ? yield* sql<Header>`SELECT block_id,rank,octet_length(payload) AS payload_bytes
          FROM spaces_blocks WHERE block_id=${frame.only} AND page_id=${frame.pageId}`
      : yield* sql<Header>`SELECT block_id,rank,octet_length(payload) AS payload_bytes
          FROM spaces_blocks INDEXED BY spaces_blocks_children
          WHERE page_id=${frame.pageId} AND deleted=0 AND parent_id IS ${frame.parentId} ${after}
          ORDER BY rank,block_id LIMIT 1`;
    if (!header) {
      stack.pop();
      continue;
    }
    inspected++;
    if (
      frame.depth > captureLimits.depth ||
      blocks.size >= SPACE_CONTEXT_LIMITS.maxBlockIds ||
      header.payload_bytes > captureLimits.bytes - inspectedBytes
    ) {
      truncated = true;
      break;
    }
    const [row] =
      yield* sql<BlockStore.BlockRow>`SELECT * FROM spaces_blocks WHERE block_id=${header.block_id}`;
    if (!row) return yield* new C.SpacesUnavailableError({ stage: "storage" });
    inspectedBytes += header.payload_bytes;
    if (frame.only) stack.pop();
    else frame.after = { rank: header.rank, id: header.block_id };
    const value = yield* BlockStore.blockFromRow(row);
    if (blocks.has(value.id)) return yield* new C.SpacesUnavailableError({ stage: "storage" });
    blocks.add(value.id);
    const source = sources.find((source) => source.pageId === frame.pageId)!;
    source.blockIds.push(value.id);
    const next = clip(
      `${text}${blocks.size > 1 ? "\n" : ""}${blockText(value)}`,
      SPACE_CONTEXT_LIMITS.maxTextChars,
      SPACE_CONTEXT_LIMITS.maxTextBytes,
    );
    text = next.text;
    if (next.truncated || byteLength(record()) > SPACE_CONTEXT_LIMITS.maxRecordBytes) {
      truncated = true;
      break;
    }
    if (value.type === "child_page" && input.includeChildPages) {
      const known = Option.getOrUndefined(knownBlock(value));
      if (!known || !("pageId" in known.content)) continue;
      if (pages.size >= captureLimits.pages) {
        truncated = true;
        break;
      }
      const child = yield* PageStore.read(known.content.pageId);
      if (pages.has(child.page_id))
        return yield* new C.SpacesUnavailableError({ stage: "storage" });
      pages.add(child.page_id);
      sources.push({
        environmentId: input.environmentId,
        spaceId: child.space_id,
        pageId: child.page_id,
        revision: child.revision,
        blockIds: [],
      });
      stack.push({ pageId: child.page_id, parentId: null, after: null, depth: frame.depth + 1 });
    } else if (BlockStore.isListContainer(value)) {
      stack.push({ pageId: frame.pageId, parentId: value.id, after: null, depth: frame.depth + 1 });
    }
  }
  const rawText = text;
  const markTruncated = () => {
    truncated = true;
    text =
      clip(
        rawText,
        SPACE_CONTEXT_LIMITS.maxTextChars - marker.length,
        SPACE_CONTEXT_LIMITS.maxTextBytes - Buffer.byteLength(marker, "utf8"),
      ).text + marker;
  };
  if (truncated) markTruncated();
  if (byteLength(record()) > SPACE_CONTEXT_LIMITS.maxRecordBytes) {
    markTruncated();
    const points = Array.from(text.slice(0, -marker.length));
    let low = 0;
    let high = points.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      text = points.slice(0, mid).join("") + marker;
      if (byteLength(record()) <= SPACE_CONTEXT_LIMITS.maxRecordBytes) low = mid;
      else high = mid - 1;
    }
    text = points.slice(0, low).join("") + marker;
  }
  const result = record();
  result.snapshot.contentHash = `sha256:${NodeCrypto.createHash("sha256")
    .update(serializeSpaceContextSnapshotForHash(result), "utf8")
    .digest("hex")}`;
  const output = { status: "captured" as const, record: result };
  if (!validResult(output)) return yield* new C.SpacesUnavailableError({ stage: "capacity" });
  return output;
});
