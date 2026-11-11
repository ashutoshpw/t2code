import type { SpaceSharedDatabaseRow } from "@t2code/contracts";

import { SharedCover } from "./SharedCover";
import { renderCell, RowLink, type ViewProps } from "./parts";

/** A read-only card: cover, title, then the view's visible properties. */
export function SharedCard({
  props,
  row,
}: {
  readonly props: ViewProps;
  readonly row: SpaceSharedDatabaseRow;
}) {
  const { env, view, model } = props;
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-md border bg-card text-card-foreground [contain-intrinsic-size:auto_120px] [content-visibility:auto]">
      <SharedCover env={env} viewId={view.id} row={row} model={model} />
      <div className="flex min-w-0 flex-col gap-1 p-2 text-sm">
        <RowLink env={env} viewId={view.id} row={row} />
        {model.columns.map((column) => (
          <div key={column.property.id} className="flex min-w-0 text-xs">
            {renderCell(props, column, row, "card")}
          </div>
        ))}
      </div>
    </article>
  );
}
