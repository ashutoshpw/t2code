import { lazy, Suspense, useState } from "react";
import { Link } from "@tanstack/react-router";
import { FileTextIcon, RefreshCwIcon } from "lucide-react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCursor, SpaceId } from "@t2code/contracts/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Button } from "../components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { SpacesUnavailable } from "./SpacesUnavailable";

const CreatePageButton = lazy(() =>
  import("./SpaceCreateControls").then((module) => ({ default: module.CreatePageButton })),
);

export function SpacePageTable({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}) {
  const availability = useSpacesAvailability(environmentId);
  const limit =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces?.limits
      .maxListRows;
  if (!canBrowseSpaces(availability) || !limit)
    return <SpacesUnavailable availability={availability} />;
  return <Pages environmentId={environmentId} spaceId={spaceId} limit={limit} />;
}

function Pages({
  environmentId,
  spaceId,
  limit,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
  limit: number;
}) {
  const [cursor, setCursor] = useState<SpaceCursor>();
  const query = useEnvironmentQuery(
    spacesEnvironment.pages({
      environmentId,
      input: { environmentId, spaceId, limit, ...(cursor ? { cursor } : {}) },
    }),
  );
  const items = query.data?.items;
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh pages"
          onClick={() => query.refresh()}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {query.error ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="text-sm text-destructive-foreground">
            {query.error}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCursor(undefined);
              query.refresh();
            }}
          >
            Retry
          </Button>
        </div>
      ) : !items ? (
        <div role="status" aria-label="Loading pages" className="space-y-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : !items.length && !cursor ? (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>No pages in this space.</EmptyTitle>
          </EmptyHeader>
          <Suspense fallback={null}>
            <CreatePageButton environmentId={environmentId} spaceId={spaceId} label="New page" />
          </Suspense>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-40 text-right">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((page) => (
              <TableRow key={page.id}>
                <TableCell className="max-w-0 w-full">
                  <Link
                    to="/spaces/$environmentId/$spaceId/$pageId"
                    params={{ environmentId, spaceId, pageId: page.id }}
                    search={{}}
                    className="flex min-w-0 items-center gap-2 hover:underline"
                  >
                    <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{page.title || "Untitled page"}</span>
                  </Link>
                </TableCell>
                <TableCell className="text-right">
                  <span className="text-muted-foreground">
                    {formatRelativeTimeLabel(page.updatedAt)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {cursor || (query.data?.nextCursor && !query.error) ? (
        <div className="flex gap-2">
          {cursor ? (
            <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
              First pages
            </Button>
          ) : null}
          {query.data?.nextCursor && !query.error ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={query.isPending}
              onClick={() => setCursor(query.data!.nextCursor!)}
            >
              Next pages
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
