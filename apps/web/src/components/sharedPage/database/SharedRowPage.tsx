import {
  SPACE_PAGE_SHARE_BLOCK_PARAM,
  SPACE_PAGE_SHARE_CURSOR_PARAM,
  SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_ROW_PARAM,
  SPACE_PAGE_SHARE_VIEW_PARAM,
  SPACE_PAGE_SHARE_ZONE_PARAM,
  SpaceSharedDatabaseRowPage,
  type SpaceSharedDatabase,
} from "@t2code/contracts";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import type { SpaceBlock } from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { SpaceEditor } from "~/spaces/SpaceEditor";
import { SpacePageGlyph } from "~/spaces/SpacePageGlyph";
import { CellValue } from "~/spaces/databases/primitives/CellValue";
import { staticAdapter } from "../staticAdapter";
import { optionHintFor, sharedKnownProperty } from "./cells";
import { walkRowBody } from "./paging";
import { ProblemNote } from "./parts";
import { sharedGet, type Fetched } from "./request";
import { assetUrlFor, viewerZone } from "./SharedDatabase";
import { fetchSharedDatabase } from "./useSharedDatabase";
import { viewModel } from "./viewModel";

const decodeRow = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedDatabaseRowPage));

export interface SharedRowTarget {
  readonly credential: string;
  /** The page that holds the database block. */
  readonly pageId: string;
  readonly blockId: string;
  readonly viewId: string;
  readonly rowId: string;
}

interface Loaded {
  readonly row: SpaceSharedDatabaseRowPage;
  readonly database: SpaceSharedDatabase;
}

async function loadRow(target: SharedRowTarget, zone: string, signal: AbortSignal) {
  const [row, database] = await Promise.all([
    walkRowBody((cursor) =>
      sharedGet(
        SPACE_PAGE_SHARE_DATABASE_ROW_ROUTE,
        {
          [SPACE_PAGE_SHARE_PAGE_PARAM]: target.pageId,
          [SPACE_PAGE_SHARE_BLOCK_PARAM]: target.blockId,
          [SPACE_PAGE_SHARE_VIEW_PARAM]: target.viewId,
          [SPACE_PAGE_SHARE_ROW_PARAM]: target.rowId,
          [SPACE_PAGE_SHARE_ZONE_PARAM]: zone,
          [SPACE_PAGE_SHARE_CURSOR_PARAM]: cursor,
        },
        target.credential,
        decodeRow,
        signal,
      ),
    ),
    fetchSharedDatabase(target.credential, target.pageId, target.blockId, signal),
  ]);
  if (!row.ok) return row;
  if (!database.ok) return database;
  return { ok: true, value: { row: row.value, database: database.value } } as const;
}

const SUB_PAGE_NOTE = "Sub-page (not part of this link)";
const DATABASE_NOTE = "Database (not part of this link)";

function Placeholder({ children }: { readonly children: ReactNode }) {
  return <p className="rounded-md border px-3 py-2 text-muted-foreground text-sm">{children}</p>;
}

export function SharedRowPage({
  target,
  hrefFor,
  onOpen,
}: {
  readonly target: SharedRowTarget;
  readonly hrefFor: (pageId: string) => string;
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>, pageId: string) => void;
}) {
  const key = `${target.credential}\n${target.pageId}\n${target.blockId}\n${target.viewId}\n${target.rowId}`;
  const [loaded, setLoaded] = useState<{ key: string; result: Fetched<Loaded> } | null>(null);
  const [zone] = useState(viewerZone);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Fetches the row page from the network whenever the link or row changes.
  useEffect(() => {
    const abort = new AbortController();
    void loadRow(target, zone, abort.signal).then((result) => {
      if (!abort.signal.aborted) setLoaded({ key, result });
    });
    return () => abort.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `key` is every field of `target` the load reads; the object itself is new on each render.
  }, [key, zone]);

  const current = loaded?.key === key ? loaded.result : null;
  return (
    <article className="mx-auto w-full max-w-3xl px-6 pt-10 pb-24 sm:px-10">
      {current === null ? (
        <p role="status" className="py-24 text-center text-muted-foreground text-sm">
          Loading page…
        </p>
      ) : !current.ok ? (
        <ProblemNote
          problem={current.problem}
          text={
            current.problem === "unavailable"
              ? "This page isn't available on this link."
              : undefined
          }
        />
      ) : (
        <RowDocument
          key={key}
          loaded={current.value}
          target={target}
          zone={zone}
          hrefFor={hrefFor}
          onOpen={onOpen}
        />
      )}
    </article>
  );
}

function RowDocument({
  loaded,
  target,
  zone,
  hrefFor,
  onOpen,
}: {
  readonly loaded: Loaded;
  readonly target: SharedRowTarget;
  readonly zone: string;
  readonly hrefFor: (pageId: string) => string;
  readonly onOpen: (event: MouseEvent<HTMLAnchorElement>, pageId: string) => void;
}) {
  const { row: page, database } = loaded;
  const { row, breadcrumb } = page;
  const view = database.views.find((entry) => entry.id === target.viewId);
  const source = database.dataSources.find((entry) => entry.id === view?.dataSourceId);
  const [adapter] = useState(() => staticAdapter(row.id, page.window));
  const asset = (assetId: string) =>
    assetUrlFor(target.credential, target.pageId, target.blockId, assetId, target.viewId, row.id);

  // View columns first, then whatever else the server sent a value for.
  const model = view === undefined || source === undefined ? null : viewModel(view, source);
  const ordered =
    model === null || source === undefined ? [] : model.columns.map((c) => c.property);
  const listed = new Set(ordered.map((property) => property.id));
  const extras = Object.values(source?.properties ?? {}).filter(
    (property) =>
      !listed.has(property.id) && property.type !== "title" && row.cells[property.id] !== undefined,
  );
  const hint = optionHintFor(page.options);

  const renderBlock = (block: SpaceBlock) => {
    if (!isKnownSpaceBlock(block)) return null;
    if (block.type === "child_page") return <Placeholder>{SUB_PAGE_NOTE}</Placeholder>;
    if (block.type === "image")
      return (
        <img
          src={asset(block.content.assetId)}
          alt=""
          loading="lazy"
          className="h-auto max-w-full rounded-md"
        />
      );
    if (block.type === "video")
      return (
        <video
          src={asset(block.content.assetId)}
          controls
          preload="metadata"
          className="max-w-full rounded-md"
        />
      );
    if (block.type === "pdf")
      return (
        <a
          href={asset(block.content.assetId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
        >
          <FileTextIcon className="size-4" />
          Open PDF
        </a>
      );
    return null;
  };
  const renderChild = (block: SpaceBlock) =>
    isDatabase(block) ? <Placeholder>{DATABASE_NOTE}</Placeholder> : renderBlock(block);

  return (
    <>
      <title>{`${row.icon ? `${row.icon} ` : ""}${row.title || "Untitled"}`}</title>
      {breadcrumb.length > 1 ? (
        <nav aria-label="Breadcrumb" className="mb-6 flex flex-wrap items-center gap-1 text-sm">
          {breadcrumb.map((crumb, index) => {
            const last = index === breadcrumb.length - 1;
            return (
              <span key={crumb.id} className="flex items-center gap-1">
                {index > 0 ? <ChevronRightIcon className="size-3.5 text-muted-foreground" /> : null}
                {last ? (
                  <span aria-current="page">{crumb.title || "Untitled"}</span>
                ) : (
                  <a
                    href={hrefFor(crumb.id)}
                    onClick={(event) => onOpen(event, crumb.id)}
                    className="text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {crumb.icon ? `${crumb.icon} ` : ""}
                    {crumb.title || "Untitled page"}
                  </a>
                )}
              </span>
            );
          })}
        </nav>
      ) : null}
      {row.icon ? <SpacePageGlyph icon={row.icon} className="mb-2 text-6xl leading-tight" /> : null}
      <h1 className="mb-4 font-bold text-4xl leading-tight">{row.title || "Untitled"}</h1>
      {ordered.length + extras.length > 0 ? (
        <dl className="mb-6 grid grid-cols-[minmax(6rem,10rem)_1fr] items-start gap-x-4 gap-y-1.5 text-sm">
          {[...ordered, ...extras].map((property) => (
            <div key={property.id} className="col-span-2 grid grid-cols-subgrid items-start">
              <dt className="text-muted-foreground">{property.name}</dt>
              <dd className="min-w-0">
                <CellValue
                  known={sharedKnownProperty(property, page.options)}
                  value={row.cells[property.id]}
                  relatedPages={page.relatedPages}
                  variant="field"
                  optionHint={hint}
                  timeZone={zone}
                  wrap
                />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <SpaceEditor adapter={adapter} editable={false} renderChild={renderChild} />
    </>
  );
}

const isDatabase = (block: SpaceBlock) => block.type === "database";
