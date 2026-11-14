import { cn } from "~/lib/utils";
import { SharedCard } from "./SharedCard";
import { SharedList } from "./SharedList";
import { OPTION_COLUMN_CLASS } from "~/spaces/databases/primitives/colors";
import { BUCKET_CAP, GroupTitle, bucketColor, ShowMore, type ViewProps } from "./parts";
import { bucketId } from "./paging";
import { orderBuckets } from "./viewModel";

const COLUMN_WIDTH = { small: "14rem", medium: "18rem", large: "22rem" } as const;

export function SharedBoard(props: ViewProps) {
  const { data, view, model, busy, moreProblem } = props;
  // Without a grouping a board is one pile of cards: show it as the list.
  if (data.groups === null) return <SharedList {...props} />;
  const width = COLUMN_WIDTH[model.cardSize];
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 overflow-x-auto pb-2">
        {orderBuckets(data.groups, view.group?.order).map((bucket) => {
          const color = model.colorColumns ? bucketColor(props, bucket) : undefined;
          return (
            <section
              key={bucketId(bucket)}
              className={cn(
                "flex shrink-0 flex-col gap-2 rounded-md p-2",
                color === undefined ? "bg-muted/30" : OPTION_COLUMN_CLASS[color],
              )}
              style={{ width }}
            >
              <h3 className="px-1 text-sm">
                <GroupTitle props={props} bucket={bucket} />
              </h3>
              {bucket.rows.map((row) => (
                <SharedCard key={row.id} props={props} row={row} />
              ))}
              <ShowMore
                hasMore={bucket.nextCursor !== null}
                loaded={bucket.rows.length}
                cap={BUCKET_CAP}
                busy={busy === bucketId(bucket)}
                problem={busy === null ? moreProblem : null}
                onClick={() => props.loadBucket(bucket)}
              />
            </section>
          );
        })}
      </div>
      {data.groupsTruncated ? (
        <p className="text-muted-foreground text-xs">Some groups are not shown.</p>
      ) : null}
    </div>
  );
}
