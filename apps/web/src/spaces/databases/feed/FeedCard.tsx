import { rowTitle } from "@t2code/client-runtime/spaces";
import { memo } from "react";
import type { SpaceDatabaseRow, SpacePageId, SpaceRowPreviewBlock } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { SpacePageGlyph } from "../../SpacePageGlyph";
import { sameLines, type CardContent, type CardLine } from "../board/BoardCard";
import { CellValue } from "../primitives/CellValue";
import { TextRuns } from "../primitives/TextRuns";
import { FEED_MAX_WIDTH } from "./feedLayout";

export interface FeedLine extends CardLine {
  readonly name: string;
}

interface FeedCardProps extends Omit<CardContent, "row" | "lines"> {
  readonly row: SpaceDatabaseRow;
  readonly lines: ReadonlyArray<FeedLine>;
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly onOpen: (pageId: SpacePageId) => void;
}

const LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  pdf: "PDF",
  database: "Database",
  divider: "Divider",
};

const sameProps = (a: FeedCardProps, b: FeedCardProps) =>
  a.row === b.row &&
  a.index === b.index &&
  a.top === b.top &&
  a.height === b.height &&
  a.relatedPages === b.relatedPages &&
  a.timeZone === b.timeZone &&
  a.onOpen === b.onOpen &&
  sameLines(a.lines, b.lines) &&
  a.lines.every((line, at) => line.name === b.lines[at]!.name);

/** Consecutive numbered items directly above `at`. */
const countBefore = (blocks: ReadonlyArray<SpaceRowPreviewBlock>, at: number) => {
  let count = 0;
  while (at - count - 1 >= 0 && blocks[at - count - 1]!.type === "numbered_item") count += 1;
  return count;
};

const hasValue = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

function Block({
  block,
  marker,
}: {
  readonly block: SpaceRowPreviewBlock;
  readonly marker: string | null;
}) {
  if (block.runs.length === 0 && block.type !== "code") {
    if (block.type === "paragraph") return null;
    return <p className="text-muted-foreground text-xs">{LABELS[block.type] ?? "Block"}</p>;
  }
  const text = <TextRuns runs={block.runs} />;
  switch (block.type) {
    case "heading":
      return <p className="line-clamp-2 font-semibold text-sm">{text}</p>;
    case "todo_item":
      return (
        <p className="line-clamp-2 text-sm">
          <span aria-hidden className="me-1.5 text-muted-foreground">
            {block.checked === true ? "☑" : "☐"}
          </span>
          {text}
        </p>
      );
    case "quote":
      return <p className="line-clamp-2 border-s-2 ps-2 text-muted-foreground text-sm">{text}</p>;
    case "code":
      return <p className="line-clamp-2 break-all font-mono text-xs">{text}</p>;
    case "bulleted_item":
    case "numbered_item":
      return (
        <p className="line-clamp-2 text-sm">
          <span aria-hidden className="me-1.5 text-muted-foreground">
            {marker}
          </span>
          {text}
        </p>
      );
    default:
      return <p className="line-clamp-2 text-sm">{text}</p>;
  }
}

/** A fixed-height card: title, the visible properties and the first blocks of the row's page. */
export const FeedCard = memo(function FeedCard({
  row,
  lines,
  index,
  top,
  height,
  relatedPages,
  optionHint,
  timeZone,
  onOpen,
}: FeedCardProps) {
  const title = rowTitle(row);
  const blocks = row.preview?.blocks ?? [];
  const numbers = blocks.map((block, at) =>
    block.type === "numbered_item" ? 1 + countBefore(blocks, at) : 0,
  );
  return (
    <div
      role="listitem"
      data-item-index={index}
      data-row-id={row.page.id}
      className="absolute inset-x-0 mx-auto overflow-hidden rounded-md border bg-background p-2 shadow-xs/5 hover:bg-accent/30"
      style={{ top, height, maxWidth: FEED_MAX_WIDTH }}
    >
      <button
        type="button"
        data-nav=""
        onClick={() => onOpen(row.page.id)}
        className="flex h-7 w-full items-center gap-2 rounded-sm text-start outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
      >
        <SpacePageGlyph icon={row.page.icon} className="size-4 text-center text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 truncate font-medium text-sm",
            title === "" && "text-muted-foreground",
          )}
        >
          {title === "" ? "Untitled" : title}
        </span>
      </button>
      <div className="flex h-11 flex-wrap content-start gap-x-3 gap-y-1 overflow-hidden px-0.5 pt-1 text-muted-foreground text-xs">
        {lines.map((line) =>
          hasValue(row.cells[line.id]) ? (
            <span key={line.id} className="flex min-h-5 max-w-full items-center gap-1">
              <span className="text-muted-foreground/70">{line.name}</span>
              <CellValue
                known={line.known}
                value={row.cells[line.id]}
                relatedPages={relatedPages}
                variant="card"
                optionHint={optionHint}
                timeZone={timeZone}
              />
            </span>
          ) : null,
        )}
      </div>
      {blocks.length > 0 ? (
        <div className="mt-2 space-y-0 overflow-hidden px-0.5">
          {blocks.map((block, at) => {
            return (
              <Block
                // oxlint-disable-next-line react/no-array-index-key -- Preview blocks carry no id.
                key={at}
                block={block}
                marker={block.type === "numbered_item" ? `${numbers[at]}.` : "•"}
              />
            );
          })}
          {row.preview?.more === true ? <p className="text-muted-foreground text-xs">…</p> : null}
        </div>
      ) : null}
    </div>
  );
}, sameProps);
