import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { agendaSections, dayLabel, monthLabel } from "./agenda";
import { renderCell, RowLink, ShowMore, type ViewProps } from "./parts";

/** Calendar and timeline as a month agenda; the date range is the viewer's only input. */
export function SharedAgenda({
  props,
  month,
  range,
  onStep,
}: {
  readonly props: ViewProps;
  readonly month: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly onStep: (delta: -1 | 0 | 1) => void;
}) {
  const { env, view, model, data, source, busy, moreProblem } = props;
  const startId = model.startId;
  const startProperty = startId === undefined ? undefined : source.properties[startId];
  const sections = startId === undefined ? [] : agendaSections(data.rows, startId, range, env.zone);
  const endProperty = model.endId === undefined ? undefined : source.properties[model.endId];
  const dateColumn =
    startProperty === undefined ? null : { property: startProperty, width: undefined, wrap: false };
  const endColumn =
    endProperty === undefined ? null : { property: endProperty, width: undefined, wrap: false };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="min-w-32 font-medium text-sm">{monthLabel(month)}</h3>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous month"
          onClick={() => onStep(-1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onStep(0)}>
          Today
        </Button>
        <Button variant="outline" size="icon-sm" aria-label="Next month" onClick={() => onStep(1)}>
          <ChevronRightIcon />
        </Button>
      </div>
      {sections.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground text-sm">Nothing this month.</p>
      ) : (
        sections.map((section) => (
          <section key={section.day} className="flex flex-col">
            <h4 className="border-b py-1 text-muted-foreground text-xs">{dayLabel(section.day)}</h4>
            <ul className="flex flex-col">
              {section.rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center gap-x-3 px-1 py-1.5 text-sm"
                >
                  <RowLink env={env} viewId={view.id} row={row} />
                  {dateColumn === null ? null : (
                    <span className="flex items-center gap-1 text-muted-foreground text-xs">
                      {renderCell(props, dateColumn, row, "card")}
                      {endColumn === null ? null : (
                        <>
                          <span aria-hidden> → </span>
                          {renderCell(props, endColumn, row, "card")}
                        </>
                      )}
                    </span>
                  )}
                  {model.columns
                    .filter(
                      (column) =>
                        column.property.id !== startId && column.property.id !== model.endId,
                    )
                    .map((column) => (
                      <span key={column.property.id} className="flex text-xs">
                        {renderCell(props, column, row, "card")}
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      <ShowMore
        hasMore={data.nextCursor !== null}
        loaded={data.rows.length}
        busy={busy === "rows"}
        problem={moreProblem}
        onClick={props.loadMore}
      />
    </div>
  );
}
