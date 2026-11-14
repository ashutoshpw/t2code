import type { SpaceDatabaseColor, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";
import type {
  SpaceSharedDataSource,
  SpaceSharedDatabaseRow,
  SpaceSharedDatabaseView,
} from "@t2code/contracts";
import { groupLabel } from "@t2code/client-runtime/spaces";
import type { MouseEvent, ReactNode } from "react";

import { SpacePageGlyph } from "~/spaces/SpacePageGlyph";
import { CellValue, type CellValueVariant } from "~/spaces/databases/primitives/CellValue";
import { isDatabaseColor } from "~/spaces/databases/primitives/colors";
import { OptionChip } from "~/spaces/databases/primitives/OptionChip";
import { Button } from "../../ui/button";
import { optionHintFor } from "./cells";
import { bucketId, MAX_BUCKET_ROWS, MAX_ROWS, type WindowData } from "./paging";
import type { Problem } from "./request";
import { orderBuckets, type ViewColumn, type ViewModel } from "./viewModel";

/** What a view needs from the page around it. Nothing here can write. */
export interface SharedEnv {
  readonly credential: string;
  readonly pageId: string | undefined;
  readonly blockId: string;
  readonly zone: string;
  readonly rowHref: (viewId: string, rowId: string) => string;
  readonly openRow: (event: MouseEvent<HTMLAnchorElement>, viewId: string, rowId: string) => void;
  /** The row form of the asset route: the file must belong to an openable row. */
  readonly assetUrl: (assetId: string, viewId: string, rowId: string) => string;
}

export interface ViewProps {
  readonly env: SharedEnv;
  readonly view: SpaceSharedDatabaseView;
  readonly source: SpaceSharedDataSource;
  readonly model: ViewModel;
  readonly data: WindowData;
  readonly known: ReadonlyMap<string, SpaceKnownDatabaseProperty | null>;
  readonly busy: string | null;
  readonly moreProblem: Problem | null;
  readonly loadMore: () => void;
  readonly loadBucket: (bucket: NonNullable<WindowData["groups"]>[number]) => void;
}

export function renderCell(
  props: ViewProps,
  column: ViewColumn,
  row: SpaceSharedDatabaseRow,
  variant: CellValueVariant,
): ReactNode {
  return (
    <CellValue
      known={props.known.get(column.property.id) ?? null}
      value={row.cells[column.property.id]}
      relatedPages={props.data.relatedPages}
      variant={variant}
      optionHint={optionHintFor(props.data.options)}
      timeZone={props.env.zone}
      wrap={column.wrap}
    />
  );
}

export function RowLink({
  env,
  viewId,
  row,
  showIcon = true,
}: {
  readonly env: SharedEnv;
  readonly viewId: string;
  readonly row: Pick<SpaceSharedDatabaseRow, "id" | "title" | "icon">;
  readonly showIcon?: boolean;
}) {
  return (
    <a
      href={env.rowHref(viewId, row.id)}
      onClick={(event) => env.openRow(event, viewId, row.id)}
      className="flex min-w-0 items-center gap-1.5 font-medium hover:underline"
    >
      {showIcon && row.icon ? (
        <SpacePageGlyph icon={row.icon} className="size-4 shrink-0 text-center" />
      ) : null}
      <span className="truncate">{row.title || "Untitled"}</span>
    </a>
  );
}

/** Appends the next window; stops offering it once a list is as long as the viewer keeps. */
export function ShowMore({
  hasMore,
  loaded,
  cap = MAX_ROWS,
  busy,
  problem,
  onClick,
}: {
  readonly hasMore: boolean;
  readonly loaded: number;
  readonly cap?: number;
  readonly busy: boolean;
  readonly problem: Problem | null;
  readonly onClick: () => void;
}) {
  if (!hasMore) return null;
  if (loaded >= cap)
    return <p className="py-2 text-muted-foreground text-xs">Showing the first {cap} rows.</p>;
  return (
    <div className="flex items-center gap-3 py-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={onClick}>
        {busy ? "Loading…" : "Show more"}
      </Button>
      {problem ? (
        <span role="alert" className="text-muted-foreground text-xs">
          {problem === "ended" ? PROBLEM_TEXT.ended : "Couldn't load more rows."}
        </span>
      ) : null}
    </div>
  );
}

export const BUCKET_CAP = MAX_BUCKET_ROWS;

function bucketLabel(props: ViewProps, bucket: NonNullable<WindowData["groups"]>[number]) {
  const propertyId = props.view.group?.property;
  const property = propertyId === undefined ? undefined : props.source.properties[propertyId];
  return groupLabel(
    bucket,
    propertyId === undefined ? null : (props.known.get(propertyId) ?? null),
    property?.name ?? "value",
    optionHintFor(props.data.options),
  );
}

/** The palette color of a group header, when the bucket has one. */
export function bucketColor(
  props: ViewProps,
  bucket: NonNullable<WindowData["groups"]>[number],
): SpaceDatabaseColor | undefined {
  const color = bucketLabel(props, bucket).color;
  return color !== undefined && isDatabaseColor(color) ? color : undefined;
}

export function GroupTitle({
  props,
  bucket,
}: {
  readonly props: ViewProps;
  readonly bucket: NonNullable<WindowData["groups"]>[number];
}) {
  const label = bucketLabel(props, bucket);
  return (
    <span className="flex min-w-0 items-center gap-2">
      {label.color === undefined ? (
        <span className="truncate font-medium">{label.text}</span>
      ) : (
        <OptionChip name={label.text} color={label.color} />
      )}
      <span className="text-muted-foreground text-xs">{bucket.count}</span>
    </span>
  );
}

/** Flat or bucketed rows with their "Show more" controls; `rows` draws one list of rows. */
export function Sections({
  props,
  children: rows,
}: {
  readonly props: ViewProps;
  readonly children: (list: ReadonlyArray<SpaceSharedDatabaseRow>) => ReactNode;
}) {
  const { data, busy, moreProblem } = props;
  if (data.groups === null)
    return (
      <div className="flex flex-col">
        {rows(data.rows)}
        <ShowMore
          hasMore={data.nextCursor !== null}
          loaded={data.rows.length}
          busy={busy === "rows"}
          problem={moreProblem}
          onClick={props.loadMore}
        />
      </div>
    );
  const buckets = orderBuckets(data.groups, props.view.group?.order);
  return (
    <div className="flex flex-col gap-4">
      {buckets.map((bucket) => (
        <section key={bucketId(bucket)} className="flex flex-col">
          <h3 className="px-1 py-1.5 text-sm">
            <GroupTitle props={props} bucket={bucket} />
          </h3>
          {rows(bucket.rows)}
          <ShowMore
            hasMore={bucket.nextCursor !== null}
            loaded={bucket.rows.length}
            cap={BUCKET_CAP}
            busy={busy === bucketId(bucket)}
            problem={busy === null ? moreProblem : null}
            onClick={() => props.loadBucket(bucket)}
          />
        </section>
      ))}
      {data.groupsTruncated ? (
        <p className="text-muted-foreground text-xs">Some groups are not shown.</p>
      ) : null}
    </div>
  );
}

const PROBLEM_TEXT: Record<Problem, string> = {
  ended: "This link no longer works. It was stopped, replaced or has expired.",
  invalid: "This link isn't valid.",
  unavailable: "This database isn't part of this link.",
  offline: "Can't reach the owner right now. Their computer may be offline or asleep.",
};

export function ProblemNote({
  problem,
  text,
}: {
  readonly problem: Problem;
  readonly text?: string | undefined;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 py-4 text-muted-foreground text-sm"
    >
      <p>{text ?? PROBLEM_TEXT[problem]}</p>
      {problem === "offline" ? (
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
