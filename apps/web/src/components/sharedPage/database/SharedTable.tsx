import { SPACE_TITLE_PROPERTY_ID } from "@t2code/contracts/spaces";
import { Fragment } from "react";

import { GroupTitle, renderCell, RowLink, ShowMore, BUCKET_CAP, type ViewProps } from "./parts";
import { bucketId } from "./paging";
import { orderBuckets } from "./viewModel";

const DEFAULT_WIDTH = 160;

export function SharedTable(props: ViewProps) {
  const { env, view, model, data, busy, moreProblem } = props;
  const columns = model.columns;
  const span = columns.length + 1;
  const buckets = data.groups === null ? null : orderBuckets(data.groups, view.group?.order);
  const rows = (list: typeof data.rows) =>
    list.map((row) => (
      <tr key={row.id} className="border-b">
        <td className="max-w-80 px-2 py-1.5 align-top">
          <RowLink env={env} viewId={view.id} row={row} />
        </td>
        {columns.map((column) => (
          <td
            key={column.property.id}
            className="px-2 py-1.5 align-top"
            style={{ maxWidth: column.width ?? DEFAULT_WIDTH }}
          >
            {renderCell(props, column, row, "cell")}
          </td>
        ))}
      </tr>
    ));
  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground text-xs">
              <th scope="col" className="px-2 py-1.5 font-normal">
                {props.source.properties[SPACE_TITLE_PROPERTY_ID]?.name ?? "Name"}
              </th>
              {columns.map((column) => (
                <th
                  key={column.property.id}
                  scope="col"
                  className="px-2 py-1.5 font-normal"
                  style={{ minWidth: column.width ?? DEFAULT_WIDTH }}
                >
                  {column.property.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets === null
              ? rows(data.rows)
              : buckets.map((bucket) => (
                  <Fragment key={bucketId(bucket)}>
                    <tr className="border-b bg-muted/40">
                      <th scope="colgroup" colSpan={span} className="px-2 py-1.5 text-left">
                        <GroupTitle props={props} bucket={bucket} />
                      </th>
                    </tr>
                    {rows(bucket.rows)}
                    {bucket.nextCursor === null ? null : (
                      <tr className="border-b">
                        <td colSpan={span} className="px-2">
                          <ShowMore
                            hasMore
                            loaded={bucket.rows.length}
                            cap={BUCKET_CAP}
                            busy={busy === bucketId(bucket)}
                            problem={busy === null ? moreProblem : null}
                            onClick={() => props.loadBucket(bucket)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
          </tbody>
        </table>
      </div>
      {buckets === null ? (
        <ShowMore
          hasMore={data.nextCursor !== null}
          loaded={data.rows.length}
          busy={busy === "rows"}
          problem={moreProblem}
          onClick={props.loadMore}
        />
      ) : data.groupsTruncated ? (
        <p className="py-2 text-muted-foreground text-xs">Some groups are not shown.</p>
      ) : null}
    </div>
  );
}
