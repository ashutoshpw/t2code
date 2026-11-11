import {
  SPACE_PAGE_SHARE_ASSET_PARAM,
  SPACE_PAGE_SHARE_ASSET_ROUTE,
  SPACE_PAGE_SHARE_BLOCK_PARAM,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_PARAM,
  SPACE_PAGE_SHARE_ROW_PARAM,
  SPACE_PAGE_SHARE_VIEW_PARAM,
} from "@t2code/contracts";
import { useState, type MouseEvent } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { SpacePageGlyph } from "~/spaces/SpacePageGlyph";
import { Button } from "../../ui/button";
import { ProblemNote, type SharedEnv } from "./parts";
import { SharedView } from "./SharedView";
import { useSharedDatabase } from "./useSharedDatabase";

export interface SharedDatabaseProps {
  readonly blockId: string;
  /** The page that holds the block. */
  readonly pageId: string;
  readonly credential: string;
  /** A full-page database leaves the title to the page. */
  readonly layout: "inline" | "page";
  readonly rowHref: (blockId: string, viewId: string, rowId: string) => string;
  readonly openRow: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}

export function assetUrlFor(
  credential: string,
  pageId: string,
  blockId: string,
  assetId: string,
  viewId: string,
  rowId: string,
) {
  return `${SPACE_PAGE_SHARE_ASSET_ROUTE}?${new URLSearchParams({
    [SPACE_PAGE_SHARE_PARAM]: credential,
    [SPACE_PAGE_SHARE_PAGE_PARAM]: pageId,
    [SPACE_PAGE_SHARE_ASSET_PARAM]: assetId,
    [SPACE_PAGE_SHARE_BLOCK_PARAM]: blockId,
    [SPACE_PAGE_SHARE_VIEW_PARAM]: viewId,
    [SPACE_PAGE_SHARE_ROW_PARAM]: rowId,
  })}`;
}

export const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function SharedDatabase(props: SharedDatabaseProps) {
  const { blockId, pageId, credential, layout } = props;
  const described = useSharedDatabase(credential, pageId, blockId);
  const [chosen, setChosen] = useState<string | null>(null);
  const [zone] = useState(viewerZone);

  if (described === null)
    return (
      <div role="status" aria-label="Loading database" className="flex flex-col gap-2 py-2">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    );
  if (!described.ok) return <ProblemNote problem={described.problem} />;

  const { database, dataSources, views } = described.value;
  const active = views.find((view) => view.id === chosen) ?? views[0];
  const source = dataSources.find((entry) => entry.id === active?.dataSourceId);
  const env: SharedEnv = {
    credential,
    pageId,
    blockId,
    zone,
    rowHref: (viewId, rowId) => props.rowHref(blockId, viewId, rowId),
    openRow: (event, viewId, rowId) => props.openRow(event, props.rowHref(blockId, viewId, rowId)),
    assetUrl: (assetId, viewId, rowId) =>
      assetUrlFor(credential, pageId, blockId, assetId, viewId, rowId),
  };
  return (
    <section
      data-shared-database=""
      aria-label={database.title || "Database"}
      className="flex flex-col gap-2"
    >
      {layout === "inline" ? (
        <h2 className="flex items-center gap-2 font-semibold text-lg">
          {database.icon ? (
            <SpacePageGlyph icon={database.icon} className="size-5 text-center" />
          ) : null}
          {database.title || "Untitled"}
        </h2>
      ) : null}
      {active === undefined || source === undefined ? (
        <p className="py-4 text-muted-foreground text-sm">
          Nothing in this database is available on this link.
        </p>
      ) : (
        <>
          {views.length > 1 ? (
            <div role="tablist" aria-label="Views" className="flex flex-wrap gap-1 border-b pb-1">
              {views.map((view) => (
                <Button
                  key={view.id}
                  role="tab"
                  aria-selected={view.id === active.id}
                  variant={view.id === active.id ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setChosen(view.id)}
                >
                  {view.name || view.type}
                </Button>
              ))}
            </div>
          ) : null}
          <SharedView key={active.id} env={env} view={active} source={source} />
        </>
      )}
    </section>
  );
}
