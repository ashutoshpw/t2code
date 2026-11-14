import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import type { ViewQuery } from "../data/useViewQuery";

export function RowsLoading({
  label,
  height,
}: {
  readonly label: string;
  readonly height: number;
}) {
  return (
    <div role="status" aria-label={label} className="space-y-1 rounded-lg border p-1">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} style={{ height }} className="w-full" />
      ))}
    </div>
  );
}

export function RowsError({
  query,
  fallback,
}: {
  readonly query: ViewQuery;
  readonly fallback: string;
}) {
  return (
    <div role="alert" className="flex items-center gap-2 rounded-lg border px-3 py-4 text-sm">
      <span className="min-w-0 flex-1">{query.error ?? fallback}</span>
      <Button size="xs" variant="outline" onClick={query.retry}>
        Retry
      </Button>
    </div>
  );
}

/** Under the scroller: a failed continuation, or why nothing shows. */
export function RowsFooter({
  query,
  empty,
}: {
  readonly query: ViewQuery;
  readonly empty: string | null;
}) {
  if (query.loadError !== null)
    return (
      <div role="alert" className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1">Couldn't load more.</span>
        <Button size="xs" variant="outline" onClick={query.retryLoad}>
          Retry
        </Button>
      </div>
    );
  return empty === null ? null : (
    <p role="status" className="px-3 py-4 text-sm text-muted-foreground">
      {empty}
    </p>
  );
}
