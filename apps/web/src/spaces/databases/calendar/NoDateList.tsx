import { rowTitle } from "@t2code/client-runtime/spaces";
import type {
  SpaceCellValue,
  SpaceDatabaseView,
  SpaceKnownDatabaseProperty,
  SpacePageId,
  SpacePropertyId,
} from "@t2code/contracts/spaces";
import { useState } from "react";
import type { ViewColumn } from "@t2code/client-runtime/spaces";
import { emptyDateFilter } from "@t2code/client-runtime/spaces";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useViewQuery } from "../data/useViewQuery";
import { DateEditor } from "../cells/DateEditor";

function Rows({
  view,
  columns,
  search,
  propertyId,
  dateKnown,
  canEdit,
  onOpen,
  onSet,
}: {
  readonly view: SpaceDatabaseView;
  readonly columns: ReadonlyArray<ViewColumn>;
  readonly search: string;
  readonly propertyId: SpacePropertyId;
  readonly dateKnown: SpaceKnownDatabaseProperty | null;
  readonly canEdit: boolean;
  readonly onOpen: (pageId: SpacePageId) => void;
  readonly onSet: (pageId: SpacePageId, value: SpaceCellValue | null) => void;
}) {
  const query = useViewQuery(view, columns, {
    mode: "rows",
    search,
    extraFilter: emptyDateFilter(propertyId),
    extraPropertyIds: [propertyId],
  });
  const [editing, setEditing] = useState<SpacePageId | null>(null);
  if (query.status === "error")
    return (
      <div role="alert" className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1">{query.error ?? "Couldn't load the rows."}</span>
        <Button size="xs" variant="outline" onClick={query.retry}>
          Retry
        </Button>
      </div>
    );
  if (query.status === "loading" && query.rows.length === 0)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  if (query.rows.length === 0)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Every item has a date
      </p>
    );
  return (
    <div className="flex w-72 flex-col gap-1">
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {query.rows.map((row) => {
          const pageId = row.page.id;
          return (
            <li key={pageId} className="relative flex items-center gap-1">
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => onOpen(pageId)}
              >
                {rowTitle(row) || "Untitled"}
              </button>
              {canEdit && dateKnown !== null ? (
                <Button size="xs" variant="outline" onClick={() => setEditing(pageId)}>
                  Set date
                </Button>
              ) : null}
              {editing === pageId && dateKnown !== null ? (
                <DateEditor
                  known={dateKnown}
                  value={row.cells[dateKnown.id]}
                  pageId={pageId}
                  variant="field"
                  relatedPages={query.relatedPages}
                  onChange={(value) => onSet(pageId, value)}
                  onCommit={(value) => {
                    onSet(pageId, value);
                    setEditing(null);
                  }}
                  onClose={() => setEditing(null)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
        <span>
          {query.total === undefined ? query.rows.length : query.total}{" "}
          {query.total === 1 ? "item" : "items"} without a date
        </span>
        {query.hasMore ? (
          <Button size="xs" variant="outline" disabled={query.loadingMore} onClick={query.loadMore}>
            Load more
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Rows without a date. The query lives only while the popover is open. */
export function NoDateButton(props: Parameters<typeof Rows>[0]) {
  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>No date</PopoverTrigger>
      <PopoverPopup align="end" aria-label="Items without a date">
        <Rows {...props} />
      </PopoverPopup>
    </Popover>
  );
}
