import { Option, Schema } from "effect";
import {
  SpaceKnownBlock,
  SpaceKnownMark,
  type SpaceBlock,
  type SpaceBlockId,
  type SpaceMark,
  type SpacePageTarget,
  type SpaceRichText,
} from "@t2code/contracts/spaces";

const decodeKnownBlock = Schema.decodeUnknownOption(SpaceKnownBlock, { onExcessProperty: "error" });
const decodeKnownMark = Schema.decodeUnknownOption(SpaceKnownMark, { onExcessProperty: "error" });
export function isKnownSpaceBlock(value: unknown): value is SpaceKnownBlock {
  return Option.isSome(decodeKnownBlock(value));
}
function isKnownSpaceMark(value: unknown): value is SpaceKnownMark {
  return Option.isSome(decodeKnownMark(value));
}

export function isSafeSpaceLink(href: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

export function isSpaceListItem(block: SpaceBlock): boolean {
  return (
    isKnownSpaceBlock(block) && ["bulleted_item", "numbered_item", "todo_item"].includes(block.type)
  );
}

export function spaceBlockRuns(block: SpaceBlock): SpaceRichText | null {
  if (!isKnownSpaceBlock(block)) return null;
  const known: SpaceKnownBlock = block;
  return "runs" in known.content ? known.content.runs : null;
}

function hasSupportedRuns(runs: SpaceRichText, mobile: boolean): boolean {
  return runs.every(
    (run) =>
      Object.keys(run).every((key) => key === "text" || key === "marks") &&
      run.marks.every(
        (mark) =>
          isKnownSpaceMark(mark) &&
          (mark.type !== "link" || isSafeSpaceLink(mark.href)) &&
          (!mobile || ["bold", "italic", "code", "link"].includes(mark.type)),
      ),
  );
}

export function canEditSpaceBlock(block: SpaceBlock): boolean {
  if (!isKnownSpaceBlock(block)) return false;
  const known: SpaceKnownBlock = block;
  return (
    (!("runs" in known.content) || hasSupportedRuns(known.content.runs, false)) &&
    (!("caption" in known.content) ||
      known.content.caption === undefined ||
      hasSupportedRuns(known.content.caption, false))
  );
}

export function canEditSpaceBlockOnMobile(block: SpaceBlock): boolean {
  const runs = spaceBlockRuns(block);
  return runs !== null && block.type !== "callout" && hasSupportedRuns(runs, true);
}

export function spacePlainText(runs: SpaceRichText): string {
  return runs.map((run) => run.text).join("");
}

function assertOffset(text: string, offset: number) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > text.length ||
    (offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[offset]!))
  ) {
    throw new Error("Invalid UTF-16 text boundary");
  }
}

function sliceSpaceRuns(runs: SpaceRichText, start: number, end: number): SpaceRichText {
  const text = spacePlainText(runs);
  assertOffset(text, start);
  assertOffset(text, end);
  if (end < start) throw new Error("Invalid text range");
  let offset = 0;
  return runs.flatMap((run) => {
    const from = Math.max(0, start - offset);
    const to = Math.min(run.text.length, end - offset);
    offset += run.text.length;
    return to > from ? [{ ...run, text: run.text.slice(from, to) }] : [];
  });
}

function coalesceMobileRuns(runs: SpaceRichText): SpaceRichText {
  const result: SpaceRichText[number][] = [];
  let previousMarks: string | undefined;
  for (const run of runs) {
    const marks = JSON.stringify(
      run.marks
        .map((mark) => `${mark.type}:${mark.version}:${mark.type === "link" ? mark.href : ""}`)
        .sort(),
    );
    const previous = result.at(-1);
    if (previous && marks === previousMarks) {
      result[result.length - 1] = { ...previous, text: previous.text + run.text };
    } else {
      result.push(run);
      previousMarks = marks;
    }
  }
  return result;
}

export function editSpaceMobileText(
  block: SpaceBlock,
  edit: {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly marks?: readonly SpaceMark[];
  },
): SpaceBlock {
  if (
    !canEditSpaceBlockOnMobile(block) ||
    !isKnownSpaceBlock(block) ||
    !("runs" in block.content)
  ) {
    throw new Error("Block is read-only on mobile");
  }
  const known: SpaceKnownBlock = block;
  if (!("runs" in known.content)) throw new Error("Block has no rich text");
  const runs = known.content.runs;
  const length = spacePlainText(runs).length;
  const before = sliceSpaceRuns(runs, 0, edit.start);
  const after = sliceSpaceRuns(runs, edit.end, length);
  if (edit.end < edit.start) throw new Error("Invalid text range");
  const marks =
    edit.marks ??
    sliceSpaceRuns(runs, edit.start, edit.end)[0]?.marks ??
    before.at(-1)?.marks ??
    [];
  if (!hasSupportedRuns([{ text: edit.text, marks }], true))
    throw new Error("Unsupported mobile marks");
  return {
    ...known,
    content: {
      ...known.content,
      runs: coalesceMobileRuns([
        ...before,
        ...(edit.text ? [{ text: edit.text, marks }] : []),
        ...after,
      ]),
    },
  };
}

export function splitSpaceTextBlock(
  block: SpaceBlock,
  offset: number,
  next: { readonly id: SpaceBlockId; readonly order: string },
): readonly [SpaceBlock, SpaceBlock] {
  if (!isKnownSpaceBlock(block)) throw new Error("Block cannot be split losslessly");
  const known: SpaceKnownBlock = block;
  if (!("runs" in known.content) || !hasSupportedRuns(known.content.runs, false))
    throw new Error("Block cannot be split losslessly");
  if (next.id === block.id) throw new Error("Split requires a new block ID");
  const text = spacePlainText(known.content.runs);
  if (known.type === "heading" && offset >= text.length)
    return [
      known,
      { ...next, version: 1, parentId: known.parentId, type: "paragraph", content: { runs: [] } },
    ];
  return [
    {
      ...known,
      content: { ...known.content, runs: sliceSpaceRuns(known.content.runs, 0, offset) },
    },
    {
      ...known,
      ...next,
      content: {
        ...known.content,
        runs: sliceSpaceRuns(known.content.runs, offset, spacePlainText(known.content.runs).length),
      },
    },
  ];
}

export function joinSpaceTextBlocks(
  first: SpaceBlock,
  second: SpaceBlock,
): {
  readonly block: SpaceBlock;
  readonly tombstone: { readonly blockId: SpaceBlockId; readonly mergedInto: SpaceBlockId };
} {
  if (
    first.id === second.id ||
    first.parentId !== second.parentId ||
    !isKnownSpaceBlock(first) ||
    !isKnownSpaceBlock(second)
  )
    throw new Error("Blocks cannot be joined losslessly");
  const a: SpaceKnownBlock = first;
  const b: SpaceKnownBlock = second;
  if (
    !("runs" in a.content) ||
    !("runs" in b.content) ||
    !hasSupportedRuns(a.content.runs, false) ||
    !hasSupportedRuns(b.content.runs, false)
  )
    throw new Error("Blocks cannot be joined losslessly");
  return {
    block: { ...a, content: { ...a.content, runs: [...a.content.runs, ...b.content.runs] } },
    tombstone: { blockId: second.id, mergedInto: first.id },
  };
}

export function copySpaceBlocks(
  blocks: readonly SpaceBlock[],
  source: SpacePageTarget,
  allocateId: () => SpaceBlockId,
): readonly SpaceBlock[] {
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length)
    throw new Error("Duplicate block ID");
  if (
    blocks.some((block) => {
      if (!isKnownSpaceBlock(block) || block.type === "child_page") return true;
      const known: SpaceKnownBlock = block;
      return (
        ("runs" in known.content && !hasSupportedRuns(known.content.runs, false)) ||
        ("caption" in known.content &&
          known.content.caption !== undefined &&
          !hasSupportedRuns(known.content.caption, false))
      );
    })
  ) {
    throw new Error("Copy needs known content and explicit server duplication for child pages");
  }
  const ids = new Map(blocks.map((block) => [block.id, allocateId()]));
  if (
    new Set(ids.values()).size !== blocks.length ||
    [...ids.values()].some((id) => blocks.some((block) => block.id === id))
  )
    throw new Error("Copy requires fresh unique IDs");
  const remap = (runs: SpaceRichText): SpaceRichText =>
    runs.map((run) => ({
      ...run,
      marks: run.marks.map((mark) => {
        if (
          !isKnownSpaceMark(mark) ||
          mark.type !== "block_mention" ||
          mark.target.environmentId !== source.environmentId ||
          mark.target.pageId !== source.pageId
        )
          return mark;
        const blockId = ids.get(mark.target.blockId);
        return blockId ? { ...mark, target: { ...mark.target, blockId } } : mark;
      }),
    }));
  return blocks.map((block) => {
    if (!isKnownSpaceBlock(block)) throw new Error("Unknown block");
    const known: SpaceKnownBlock = block;
    const content =
      "runs" in known.content
        ? { ...known.content, runs: remap(known.content.runs) }
        : "caption" in known.content && known.content.caption
          ? { ...known.content, caption: remap(known.content.caption) }
          : known.content;
    return {
      ...known,
      id: ids.get(block.id)!,
      parentId: block.parentId === null ? null : (ids.get(block.parentId) ?? block.parentId),
      content,
    };
  });
}
