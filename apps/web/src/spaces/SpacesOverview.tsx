import { lazy, Suspense, useState } from "react";
import { Link } from "@tanstack/react-router";
import { FileIcon, ImageIcon, VideoIcon } from "lucide-react";
import { SpacePageGlyph } from "./SpacePageGlyph";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCursor } from "@t2code/contracts/spaces";
import { useEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment } from "../state/spaces";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { SpacePinButton } from "./SpacePinButton";

const SpaceSearch = lazy(() => import("./SpaceSearch"));

const mediaFilters = [
  [undefined, "All"],
  ["image", "Images"],
  ["pdf", "PDFs"],
  ["video", "Videos"],
] as const;

export function SpacesOverview({
  environmentId,
  view,
}: {
  environmentId: EnvironmentId;
  view: "all" | "media";
}) {
  const [cursor, setCursor] = useState<SpaceCursor>();
  const limit = Math.min(
    50,
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces?.limits
      .maxListRows ?? 50,
  );
  const [mediaType, setMediaType] = useState<"image" | "pdf" | "video" | undefined>();
  const all = useEnvironmentQuery(
    view === "all"
      ? spacesEnvironment.allPages({
          environmentId,
          input: { environmentId, limit, ...(cursor ? { cursor } : {}) },
        })
      : null,
  );
  const media = useEnvironmentQuery(
    view === "media"
      ? spacesEnvironment.assets({
          environmentId,
          input: {
            environmentId,
            limit,
            ...(mediaType ? { mediaType } : {}),
            ...(cursor ? { cursor } : {}),
          },
        })
      : null,
  );
  const query = view === "all" ? all : media;
  return (
    <section
      aria-label={view === "all" ? "All pages" : "Media"}
      className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <h1 className="text-3xl font-semibold">{view === "all" ? "All pages" : "Media"}</h1>
        {view === "all" ? (
          <Suspense fallback={null}>
            <SpaceSearch environmentId={environmentId} />
          </Suspense>
        ) : (
          <ToggleGroup
            aria-label="Media type"
            value={[mediaType ?? "all"]}
            onValueChange={(next) => {
              const value = next[0];
              if (!value) return;
              setMediaType(value === "all" ? undefined : (value as "image" | "pdf" | "video"));
              setCursor(undefined);
            }}
          >
            {mediaFilters.map(([type, label]) => (
              <Toggle key={type ?? "all"} value={type ?? "all"}>
                {label}
              </Toggle>
            ))}
          </ToggleGroup>
        )}
        {query.error ? (
          <div role="alert">
            {query.error}{" "}
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
        ) : null}
        {!query.data && !query.error ? <p role="status">Loading…</p> : null}
        {view === "all" && all.data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Space</TableHead>
                <TableHead>Last activity</TableHead>
                <TableHead className="w-12">Pinned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {all.data.items.map(({ page, spaceTitle }) => (
                <TableRow key={page.id}>
                  <TableCell>
                    <Link
                      className="flex items-center gap-2 hover:underline"
                      to="/spaces/$environmentId/$spaceId/$pageId"
                      params={{ environmentId, spaceId: page.spaceId, pageId: page.id }}
                      search={{}}
                    >
                      <SpacePageGlyph icon={page.icon} className="size-4 text-center" />
                      {page.title || "Untitled page"}
                    </Link>
                  </TableCell>
                  <TableCell>{spaceTitle}</TableCell>
                  <TableCell>{formatRelativeTimeLabel(page.updatedAt)}</TableCell>
                  <TableCell>
                    <SpacePinButton environmentId={environmentId} page={page} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {view === "media" && media.data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {media.data.items.map((asset) => {
                const Icon = asset.mimeType.startsWith("image/")
                  ? ImageIcon
                  : asset.mimeType.startsWith("video/")
                    ? VideoIcon
                    : FileIcon;
                return (
                  <TableRow key={`${asset.assetId}:${asset.pageId}`}>
                    <TableCell>
                      <Link
                        className="flex items-center gap-2 hover:underline"
                        to="/spaces/$environmentId/$spaceId/$pageId"
                        params={{ environmentId, spaceId: asset.spaceId, pageId: asset.pageId }}
                        search={{}}
                      >
                        <Icon className="size-4" />
                        {asset.name}
                      </Link>
                    </TableCell>
                    <TableCell>{asset.mimeType}</TableCell>
                    <TableCell>{formatRelativeTimeLabel(asset.createdAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
        {query.data && !query.data.items.length && !cursor ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>
                {view === "all"
                  ? "No pages yet"
                  : mediaType
                    ? "No media of this type"
                    : "No media yet"}
              </EmptyTitle>
              <EmptyDescription>
                {view === "all"
                  ? "Create a page from the sidebar and it will show up here."
                  : "Add an image, PDF or video to a page to see it here."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {cursor || query.data?.nextCursor ? (
          <div className="flex gap-2">
            {cursor ? (
              <Button variant="ghost" size="sm" onClick={() => setCursor(undefined)}>
                First
              </Button>
            ) : null}
            {query.data?.nextCursor ? (
              <Button variant="ghost" size="sm" onClick={() => setCursor(query.data!.nextCursor!)}>
                Next
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
