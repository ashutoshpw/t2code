import { rowTitle, type ChartDatum, type ViewColumn } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseView, SpacePropertyId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useViewQuery } from "../data/useViewQuery";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { CellValue } from "../primitives/CellValue";
import { RowsError } from "../list/ListStates";

const PEEK_ROWS = 50;
const VIEWER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The rows behind one bar or slice, as a small table. Mounted only while open, so it never queries idle. */
export function ChartPeek({
  datum,
  search,
  yProperty,
  onClose,
}: {
  readonly datum: ChartDatum;
  readonly search: string;
  readonly yProperty: SpacePropertyId | null;
  readonly onClose: () => void;
}) {
  const { view, columns, optionHint } = useDatabase();
  const actions = useDatabaseActions();
  const shown: ReadonlyArray<ViewColumn> = columns
    .filter((column) => column.property.id === "title" || column.property.id === yProperty)
    .map((column) => ({ ...column, visible: true }));
  const yColumn = shown.find((column) => column.property.id === yProperty);
  const table: SpaceDatabaseView = { ...view, type: "table" };
  const query = useViewQuery(table, shown, {
    mode: "rows",
    search,
    bucket: datum.key,
    limit: PEEK_ROWS,
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {datum.label} · {datum.count} {datum.count === 1 ? "row" : "rows"}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {query.status === "error" && query.rows.length === 0 ? (
            <RowsError query={query} fallback="Couldn't load the rows." />
          ) : query.status === "loading" ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading rows
            </p>
          ) : (
            <ul className="flex flex-col">
              {query.rows.map((row) => (
                <li
                  key={row.page.id}
                  className="flex items-center gap-3 border-b py-1.5 last:border-0"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                    onClick={() => {
                      onClose();
                      actions.openRow(row.page.id);
                    }}
                  >
                    {rowTitle(row) || "Untitled"}
                  </button>
                  {yColumn === undefined ? null : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <CellValue
                        known={yColumn.known}
                        value={row.cells[yColumn.property.id]}
                        relatedPages={query.relatedPages}
                        variant="cell"
                        optionHint={optionHint}
                        timeZone={VIEWER_ZONE}
                      />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {query.hasMore ? (
            <Button
              size="xs"
              variant="outline"
              disabled={query.loadingMore}
              onClick={query.loadMore}
            >
              Load more
            </Button>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
