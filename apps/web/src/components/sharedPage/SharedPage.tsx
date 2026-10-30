import {
  EnvironmentId,
  SPACE_PAGE_SHARE_ASSET_PARAM,
  SPACE_PAGE_SHARE_ASSET_ROUTE,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_PAGE_ROUTE,
  SPACE_PAGE_SHARE_PARAM,
  SpaceSharedPage,
  SpaceSharedPageFailure,
} from "@t2code/contracts";

import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import { useLocation, useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";

import { SpaceEditorAdapter } from "~/spaces/adapter";
import { SpaceEditor } from "~/spaces/SpaceEditor";
import { SpacePageGlyph } from "~/spaces/SpacePageGlyph";
import { Button } from "../ui/button";

const decodePage = Schema.decodeUnknownSync(Schema.toCodecJson(SpaceSharedPage));
const decodeFailure = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedPageFailure));

type Problem = "ended" | "invalid" | "unavailable" | "offline";
type Loaded =
  | { readonly key: string; readonly page: SpaceSharedPage; readonly problem?: undefined }
  | { readonly key: string; readonly problem: Problem; readonly page?: undefined };

const PROBLEM_COPY: Record<Problem, { title: string; body: string }> = {
  ended: {
    title: "This link no longer works",
    body: "It was stopped, replaced or has expired. Ask the owner for a new link.",
  },
  invalid: {
    title: "This link isn't valid",
    body: "Check that you copied the whole link, or ask the owner to share it again.",
  },
  unavailable: {
    title: "This page isn't available",
    body: "It may have been moved or deleted by its owner.",
  },
  offline: {
    title: "Can't reach the owner right now",
    body: "Their computer may be offline or asleep. Try again in a moment.",
  },
};

function credentialFromHash(hash: string): string {
  const raw = hash.replace(/^#/, "");
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return "";
  }
}

function loadKey(credential: string, pageId: string | null) {
  return `${credential}\n${pageId ?? ""}`;
}

function pageQuery(credential: string, pageId: string | null) {
  const query = new URLSearchParams({ [SPACE_PAGE_SHARE_PARAM]: credential });
  if (pageId !== null) query.set(SPACE_PAGE_SHARE_PAGE_PARAM, pageId);
  return query;
}

async function loadSharedPage(
  credential: string,
  pageId: string | null,
  signal: AbortSignal,
): Promise<Pick<Loaded, "page" | "problem">> {
  if (credential === "") return { problem: "invalid" };
  try {
    const response = await fetch(
      `${SPACE_PAGE_SHARE_PAGE_ROUTE}?${pageQuery(credential, pageId)}`,
      { signal, cache: "no-store" },
    );
    if (response.ok) return { page: decodePage(await response.json()) };
    const failure = Option.getOrNull(decodeFailure(await response.json().catch(() => null)));
    if (response.status >= 500) return { problem: "offline" };
    if (failure?.reason === "inactive") return { problem: "ended" };
    if (failure?.reason === "unavailable") return { problem: "unavailable" };
    return { problem: "invalid" };
  } catch {
    return { problem: "offline" };
  }
}

export function SharedPage() {
  const router = useRouter();
  const location = useLocation();
  const credential = credentialFromHash(location.hash);
  const requestedPage = new URLSearchParams(location.searchStr).get(SPACE_PAGE_SHARE_PAGE_PARAM);
  const key = loadKey(credential, requestedPage);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // oxlint-disable-next-line t2code/react-effect-budget -- Fetches the shared page from the network whenever the link or page changes.
  useEffect(() => {
    const controller = new AbortController();
    void loadSharedPage(credential, requestedPage, controller.signal).then((result) => {
      if (!controller.signal.aborted)
        setLoaded({ key: loadKey(credential, requestedPage), ...result } as Loaded);
    });
    return () => controller.abort();
  }, [credential, requestedPage]);

  const current = loaded?.key === key ? loaded : null;
  const open = (event: MouseEvent<HTMLAnchorElement>, pageId: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void router.navigate({ href: pageHref(location.pathname, credential, pageId) });
  };

  return (
    <main className="min-h-dvh overflow-y-auto bg-background text-foreground">
      {current?.page ? (
        <SharedDocument
          key={`${current.page.page.id}:${current.page.window.revision}`}
          shared={current.page}
          credential={credential}
          hrefFor={(pageId) => pageHref(location.pathname, credential, pageId)}
          onOpen={open}
        />
      ) : current?.problem ? (
        <Notice
          problem={current.problem}
          onRetry={current.problem === "offline" ? () => window.location.reload() : undefined}
        />
      ) : (
        <p role="status" className="px-6 py-24 text-center text-muted-foreground text-sm">
          Loading page…
        </p>
      )}
    </main>
  );
}

function pageHref(pathname: string, credential: string, pageId: string) {
  return `${pathname}?${SPACE_PAGE_SHARE_PAGE_PARAM}=${encodeURIComponent(pageId)}#${encodeURIComponent(credential)}`;
}

function Notice({ problem, onRetry }: { problem: Problem; onRetry: (() => void) | undefined }) {
  const copy = PROBLEM_COPY[problem];
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-24">
      <h1 className="font-semibold text-xl">{copy.title}</h1>
      <p className="text-center text-muted-foreground text-sm">{copy.body}</p>
      {onRetry ? (
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function SharedDocument({
  shared,
  credential,
  hrefFor,
  onOpen,
}: {
  shared: SpaceSharedPage;
  credential: string;
  hrefFor: (pageId: string) => string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, pageId: string) => void;
}) {
  const { page, window: blocks, breadcrumb, children } = shared;
  const [adapter] = useState(() => staticAdapter(shared));
  const childById = new Map(children.map((child) => [child.id, child]));
  const assetUrl = (assetId: string) =>
    `${SPACE_PAGE_SHARE_ASSET_ROUTE}?${new URLSearchParams({
      [SPACE_PAGE_SHARE_PARAM]: credential,
      [SPACE_PAGE_SHARE_PAGE_PARAM]: page.id,
      [SPACE_PAGE_SHARE_ASSET_PARAM]: assetId,
    })}`;
  const renderBlock = (block: SpaceBlock) => {
    if (!isKnownSpaceBlock(block)) return null;
    if (block.type === "child_page") {
      const id = block.content.pageId;
      return (
        <PageRow
          title={childById.get(id)?.title ?? ""}
          icon={childById.get(id)?.icon}
          href={hrefFor(id)}
          onOpen={(e) => onOpen(e, id)}
        />
      );
    }
    if (block.type === "image" || block.type === "video" || block.type === "pdf") {
      const src = assetUrl(block.content.assetId);
      if (block.type === "image")
        return <img src={src} alt="" loading="lazy" className="h-auto max-w-full rounded-md" />;
      if (block.type === "video")
        return <video src={src} controls preload="metadata" className="max-w-full rounded-md" />;
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
        >
          <FileTextIcon className="size-4" />
          Open PDF
        </a>
      );
    }
    return null;
  };
  const listed = new Set(
    blocks.blocks.flatMap((block) =>
      isKnownSpaceBlock(block) && block.type === "child_page" ? [block.content.pageId] : [],
    ),
  );
  const unlisted = children.filter((child) => !listed.has(child.id));

  return (
    <article className="mx-auto w-full max-w-3xl px-6 pt-10 pb-24 sm:px-10">
      <title>{`${page.icon ? `${page.icon} ` : ""}${page.title || "Untitled page"}`}</title>
      {breadcrumb.length > 1 ? (
        <nav aria-label="Breadcrumb" className="mb-6 flex flex-wrap items-center gap-1 text-sm">
          {breadcrumb.map((crumb, index) => {
            const last = index === breadcrumb.length - 1;
            return (
              <span key={crumb.id} className="flex items-center gap-1">
                {index > 0 ? <ChevronRightIcon className="size-3.5 text-muted-foreground" /> : null}
                {last ? (
                  <span aria-current="page" className="text-foreground">
                    {crumb.icon ? `${crumb.icon} ` : ""}
                    {crumb.title || "Untitled page"}
                  </span>
                ) : (
                  <a
                    href={hrefFor(crumb.id)}
                    onClick={(e) => onOpen(e, crumb.id)}
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
      {page.icon ? (
        <p aria-hidden className="mb-2 text-6xl leading-tight">
          {page.icon}
        </p>
      ) : null}
      <h1 className="mb-6 font-bold text-4xl leading-tight">{page.title || "Untitled page"}</h1>
      <SpaceEditor adapter={adapter} editable={false} renderChild={renderBlock} />
      {unlisted.length > 0 ? (
        <section aria-label="Sub-pages" className="mt-8 flex flex-col">
          {unlisted.map((child) => (
            <PageRow
              key={child.id}
              title={child.title}
              icon={child.icon}
              href={hrefFor(child.id)}
              onOpen={(e) => onOpen(e, child.id)}
            />
          ))}
        </section>
      ) : null}
    </article>
  );
}

function PageRow({
  title,
  icon,
  href,
  onOpen,
}: {
  title: string;
  icon: string | undefined;
  href: string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      href={href}
      onClick={onOpen}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
    >
      <SpacePageGlyph icon={icon} className="size-4 text-center text-muted-foreground" />
      <span className="truncate">{title || "Untitled page"}</span>
    </a>
  );
}

function staticAdapter(shared: SpaceSharedPage) {
  const refuse = (): never => {
    throw new Error("Shared pages are read only");
  };
  return new SpaceEditorAdapter({
    target: { environmentId: EnvironmentId.make("shared"), pageId: shared.page.id },
    window: {
      ...shared.window,
      completeParents: [null, ...shared.window.blocks.map((block) => block.id)],
    },
    maxBlocks: Math.max(shared.window.blocks.length, 1),
    maxDepth: 64,
    maxTextLength: 1_000_000,
    maxClipboardBytes: 1_000_000,
    allocateId: () => refuse() as SpaceBlockId,
    allocateOrder: refuse,
    canEdit: () => false,
    canChangeStructure: () => false,
    canUndo: () => false,
    canEditMedia: () => false,
  });
}
