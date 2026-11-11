import { RowLink, renderCell, Sections, type ViewProps } from "./parts";

export function SharedList(props: ViewProps) {
  const { env, view, model } = props;
  return (
    <Sections props={props}>
      {(rows) => (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-1 py-1.5 text-sm [contain-intrinsic-size:auto_34px] [content-visibility:auto]"
            >
              <RowLink env={env} viewId={view.id} row={row} />
              {model.columns.map((column) => (
                <span
                  key={column.property.id}
                  className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs"
                >
                  {model.showPropertyNames ? <span>{column.property.name}:</span> : null}
                  {renderCell(props, column, row, "card")}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Sections>
  );
}
