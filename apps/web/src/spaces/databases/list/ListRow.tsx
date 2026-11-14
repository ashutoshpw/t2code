import { rowTitle } from "@t2code/client-runtime/spaces";
import { memo } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDatabaseRow, SpacePageId } from "@t2code/contracts/spaces";

import { ChevronRightIcon } from "lucide-react";
import { SpacePageGlyph } from "../../SpacePageGlyph";
import { cn } from "~/lib/utils";
import { sameLines, type CardContent, type CardLine } from "../board/BoardCard";
import { CellValue } from "../primitives/CellValue";
import { MAX_TREE_DEPTH } from "../table/gridItems";
import { INDENT } from "../table/tree";
import { LIST_ROW_HEIGHT } from "./listLayout";
import { RowMenu } from "./RowMenu";
import type { RowListHandlers } from "./useRowList";

/** A cell that shows something; empty values leave no gap in the line. */
const hasValue = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

export interface ListLine extends CardLine {
  readonly name: string;
}

interface ListRowProps extends Omit<CardContent, "row" | "lines"> {
  readonly lines: ReadonlyArray<ListLine>;
  readonly row: SpaceDatabaseRow;
  readonly index: number;
  readonly top: number;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly showNames: boolean;
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  readonly handlers: RowListHandlers;
  readonly canTrash: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

const sameProps = (a: ListRowProps, b: ListRowProps) =>
  a.row === b.row &&
  a.index === b.index &&
  a.top === b.top &&
  a.depth === b.depth &&
  a.expandable === b.expandable &&
  a.expanded === b.expanded &&
  a.showNames === b.showNames &&
  a.relatedPages === b.relatedPages &&
  a.timeZone === b.timeZone &&
  a.handlers === b.handlers &&
  a.canTrash === b.canTrash &&
  a.canMoveUp === b.canMoveUp &&
  a.canMoveDown === b.canMoveDown &&
  a.environmentId === b.environmentId &&
  sameLines(a.lines, b.lines) &&
  a.lines.every((line, at) => line.name === b.lines[at]!.name);

/** One 32px line: icon, title, then the non-empty visible properties, cut with an ellipsis. */
export const ListRow = memo(function ListRow({
  row,
  lines,
  index,
  top,
  depth,
  expandable,
  expanded,
  showNames,
  relatedPages,
  optionHint,
  timeZone,
  environmentId,
  spaceId,
  handlers,
  canTrash,
  canMoveUp,
  canMoveDown,
}: ListRowProps) {
  const title = rowTitle(row);
  const pageId: SpacePageId = row.page.id;
  return (
    <div
      role="listitem"
      data-item-index={index}
      data-row-id={pageId}
      className="group/row absolute inset-x-0 flex items-center gap-1 px-1.5"
      style={{
        top,
        height: LIST_ROW_HEIGHT,
        paddingInlineStart: 6 + Math.min(depth, MAX_TREE_DEPTH) * INDENT,
      }}
    >
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse sub-items" : "Expand sub-items"}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => handlers.toggleRow(pageId)}
        >
          <ChevronRightIcon className={cn("size-3.5", expanded && "rotate-90")} />
        </button>
      ) : depth > 0 || expanded ? (
        <span aria-hidden className="size-5 shrink-0" />
      ) : null}
      <button
        type="button"
        data-nav=""
        onClick={() => handlers.open(pageId)}
        className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <SpacePageGlyph icon={row.page.icon} className="size-4 text-center text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 truncate text-sm font-medium",
            title === "" && "text-muted-foreground",
          )}
        >
          {title === "" ? "Untitled" : title}
        </span>
        <span className="ms-auto flex min-w-0 shrink items-center justify-end gap-3 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
          {lines.map((line) =>
            hasValue(row.cells[line.id]) ? (
              <span key={line.id} className="flex min-w-0 shrink-0 items-center gap-1">
                {showNames ? <span className="text-muted-foreground/70">{line.name}</span> : null}
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
        </span>
      </button>
      <RowMenu
        pageId={pageId}
        title={title}
        spaceId={spaceId}
        environmentId={environmentId}
        handlers={handlers}
        canTrash={canTrash}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
      />
    </div>
  );
}, sameProps);
