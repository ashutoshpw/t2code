import { CheckIcon } from "lucide-react";
import { memo } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCellValue, SpacePageId, SpaceRelatedPage } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { CellEditor, editorKind } from "../cells/CellEditor";
import { CellValue } from "../primitives/CellValue";
import { cellKey, useCellSession, type GridEditStore } from "./gridEditStore";
import { RowActions } from "./RowActions";
import { widthValue } from "./columnResize";
import { sameRowProps, type GridHandlers, type OptionHint, type TableColumn } from "./tableTypes";

export interface TableCellProps {
  readonly pageId: SpacePageId;
  readonly column: TableColumn;
  /** 1-based, the title is 1. */
  readonly colIndex: number;
  readonly value: SpaceCellValue | undefined;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: OptionHint;
  readonly timeZone: string;
  readonly environmentId: EnvironmentId;
  readonly spaceId: string;
  /** Cell edits are allowed and the type has an editor. */
  readonly editable: boolean;
  readonly canTrash: boolean;
  readonly store: GridEditStore;
  readonly grid: GridHandlers;
}

/** One grid cell. Only the cell whose edit starts or ends re-renders for editing state. */
export const TableCell = memo(function TableCell({
  pageId,
  column,
  colIndex,
  value,
  relatedPages,
  optionHint,
  timeZone,
  environmentId,
  spaceId,
  editable,
  canTrash,
  store,
  grid,
}: TableCellProps) {
  const session = useCellSession(store, cellKey(pageId, column.id));
  const isTitle = column.id === "title";
  const kind = editorKind(column.type);
  return (
    <div
      role="gridcell"
      tabIndex={-1}
      data-row={pageId}
      data-col={column.id}
      aria-colindex={colIndex}
      aria-readonly={editable ? undefined : true}
      ref={(element) => {
        if (element !== null && store.takeWanted(pageId, column.id))
          element.focus({ preventScroll: true });
      }}
      style={{ width: widthValue(column.id) }}
      className={cn(
        "relative flex h-full shrink-0 items-center overflow-hidden border-e border-border/60 px-2 outline-none focus:ring-2 focus:ring-inset focus:ring-ring",
        isTitle && "sticky start-0 z-[1] bg-background",
      )}
      onClick={(event) => {
        // Clicks inside a popover editor bubble through the React tree but are not on this cell.
        if (event.currentTarget.contains(event.target as Node)) grid.activate(pageId, column.id);
      }}
    >
      {kind === "toggle" ? (
        <span
          role="checkbox"
          aria-checked={value === true}
          aria-label={column.name}
          className={cn(
            "flex size-4 items-center justify-center rounded-sm border",
            value === true && "border-primary bg-primary text-primary-foreground",
          )}
        >
          {value === true ? <CheckIcon className="size-3" /> : null}
        </span>
      ) : isTitle && (value === undefined || value === "") ? (
        <span className="truncate text-muted-foreground/60">Untitled</span>
      ) : (
        <CellValue
          known={column.known}
          value={value}
          relatedPages={relatedPages}
          variant="cell"
          optionHint={optionHint}
          timeZone={timeZone}
        />
      )}
      {isTitle && session === null ? (
        <RowActions
          pageId={pageId}
          spaceId={spaceId}
          environmentId={environmentId}
          canTrash={canTrash}
          grid={grid}
        />
      ) : null}
      {session !== null && column.known !== null ? (
        <CellEditor
          known={column.known}
          value={value}
          pageId={pageId}
          {...(session.seed === undefined ? {} : { seed: session.seed })}
          variant="cell"
          relatedPages={relatedPages}
          environmentId={environmentId}
          onCommit={(next, move, reason) => grid.commit(pageId, column.id, next, move, reason)}
          onChange={(next) => grid.change(pageId, column.id, next)}
          onPicked={grid.notePages}
          onClose={() => grid.close(pageId, column.id)}
        />
      ) : null}
    </div>
  );
}, sameRowProps);
