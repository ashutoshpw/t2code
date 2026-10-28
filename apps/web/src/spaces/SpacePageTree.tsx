import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId, SpacePageId } from "@t2code/contracts/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironment } from "../state/environments";
import { spacePageNavigation, useSpacesAvailability } from "../state/spaces";
import { Button } from "../components/ui/button";
import { useSidebar } from "../components/ui/sidebar";
import { SpacesUnavailable } from "./SpacesUnavailable";
import { spacePageTreeRows, type SpacePageTreeRow } from "./SpacePageTree.logic";
import { SpacePageFocusOwner } from "./SpacePageTree.focus";

export function SpacePageTree({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}) {
  const availability = useSpacesAvailability(environmentId);
  const environment = useEnvironment(environmentId);
  const capability = environment?.serverConfig?.environment.capabilities.spaces;
  if (
    !canBrowseSpaces(availability) ||
    !capability ||
    (capability.version !== 1 && capability.version !== 2)
  )
    return <SpacesUnavailable availability={availability} />;
  return (
    <PageTree
      key={JSON.stringify([
        environmentId,
        spaceId,
        capability.version,
        capability.limits.maxListRows,
      ])}
      environmentId={environmentId}
      spaceId={spaceId}
      version={capability.version}
      maxRows={capability.limits.maxListRows}
    />
  );
}

function PageTree({
  environmentId,
  spaceId,
  version,
  maxRows,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
  version: 1 | 2;
  maxRows: number;
}) {
  const [navigation] = useState(() =>
    spacePageNavigation({ environmentId, spaceId, version, maxRows }),
  );
  const snapshot = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
  const { isMobile, setOpenMobile } = useSidebar();
  const rows = spacePageTreeRows(snapshot.windows);
  const listRef = useRef<LegendListRef | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [focusOwner] = useState(
    () => new SpacePageFocusOwner({ epoch: navigation.getSnapshot, pending: setPendingKey }),
  );
  const [attachList] = useState(() => (list: LegendListRef | null) => {
    listRef.current = list;
    focusOwner.attach(
      list
        ? {
            rows: () => list.getState().data,
            scrollToItem: (item) => list.scrollToItem({ item, animated: false }),
            cancelScroll: () => {
              // The pinned LegendList patch retires active targets before assigning a replacement resolver.
              void list.scrollToOffset({ offset: list.getState().scroll, animated: false });
            },
            containsFocus: () => list.getScrollableNode().contains(document.activeElement),
            focus: (key, last) => {
              const index = list
                .getState()
                .data.findIndex((row: SpacePageTreeRow) => row.key === key);
              if (index < 0) return;
              const element = list.getState().elementAtIndex(index);
              if (!(element instanceof HTMLElement)) return;
              const target = element.matches("[data-space-row]")
                ? element
                : element.querySelector<HTMLElement>("[data-space-row]");
              const actions = target?.querySelectorAll<HTMLElement>(
                "[data-space-action]:not(:disabled)",
              );
              const action = actions?.[last ? actions.length - 1 : 0];
              (action ?? target)?.focus({ preventScroll: true });
            },
          }
        : null,
    );
  });
  // oxlint-disable-next-line t2code/react-effect-budget -- synchronize focus scroll ownership with the virtualizer's committed data and cancel obsolete requests.
  useLayoutEffect(() => {
    void focusOwner.revalidate(snapshot, rows);
    return focusOwner.invalidate;
  }, [focusOwner, rows, snapshot]);
  const focusRow = (index: number, last = false) => {
    const row = rows[index];
    if (row) void focusOwner.request(row.key, last);
  };
  const focusList = () => {
    focusOwner.cancel();
    setFocusedKey(null);
    listRef.current?.getScrollableNode().focus({ preventScroll: true });
  };
  const first = (parentPageId: SpacePageId | null) => {
    focusList();
    navigation.first(parentPageId);
  };
  const next = (parentPageId: SpacePageId | null) => {
    focusList();
    navigation.next(parentPageId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const element = target.closest<HTMLElement>("[data-space-row]");
    const index = rows.findIndex((row) => row.key === element?.dataset.spaceRow);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = index < 0 ? rows.length - 1 : Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "Tab") {
      if (index < 0) {
        if (event.shiftKey) return;
        next = 0;
      } else {
        const actions = element?.querySelectorAll<HTMLElement>(
          "[data-space-action]:not(:disabled)",
        );
        const boundary = actions?.[event.shiftKey ? 0 : actions.length - 1];
        if (boundary && target !== boundary) return;
        next = index + (event.shiftKey ? -1 : 1);
      }
    } else return;
    if (next < 0 || next >= rows.length) return;
    event.preventDefault();
    void focusRow(next, event.key === "Tab" && event.shiftKey);
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <h2 className="min-w-0 break-words text-sm font-semibold">
          {snapshot.windows.find((window) => window.parentPageId === null)?.data?.space.title ??
            "Pages"}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            focusList();
            navigation.refresh();
          }}
        >
          Refresh pages
        </Button>
      </div>
      {snapshot.error ? (
        <p role="alert" className="shrink-0 text-sm">
          {snapshot.error}
        </p>
      ) : null}
      <LegendList<SpacePageTreeRow>
        ref={attachList}
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        extraData={{ focusedKey, version, isMobile, setOpenMobile }}
        estimatedItemSize={40}
        drawDistance={320}
        {...(focusedKey || pendingKey
          ? { alwaysRender: { keys: [focusedKey, pendingKey].filter((key) => key !== null) } }
          : {})}
        role="list"
        aria-label="Pages. Use Up and Down to move between rows."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            focusOwner.cancel();
            setFocusedKey(null);
            setPendingKey(null);
          }
        }}
        renderItem={({ item: row, index }) => (
          <div
            role="listitem"
            aria-posinset={index + 1}
            aria-setsize={rows.length}
            aria-label={
              row.kind === "window"
                ? row.parentTitle
                  ? `Child pages of ${row.parentTitle}`
                  : "Page navigation"
                : undefined
            }
            data-space-row={row.key}
            tabIndex={-1}
            className="min-w-0 py-1"
            style={{ paddingInlineStart: `min(${row.depth * 12}px, 25%)` }}
            onFocusCapture={() => {
              focusOwner.cancel();
              setFocusedKey(row.key);
              setPendingKey(null);
            }}
          >
            {row.kind === "page" ? (
              <div className="flex min-w-0 items-start gap-2">
                {version === 2 ? (
                  <Button
                    data-space-action
                    tabIndex={focusedKey === row.key ? 0 : -1}
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`${row.expanded ? "Hide" : "Show"} child pages of ${row.page.title || "Untitled page"}`}
                    aria-expanded={row.expanded}
                    disabled={row.window.pending && !row.expanded}
                    onClick={() => navigation.expand(row.window.parentPageId, row.page.id)}
                  >
                    {row.expanded ? "−" : "+"}
                  </Button>
                ) : null}
                <Link
                  data-space-action
                  tabIndex={focusedKey === row.key ? 0 : -1}
                  to="/spaces/$environmentId/$spaceId/$pageId"
                  params={{ environmentId, spaceId: row.page.spaceId, pageId: row.page.id }}
                  search={{}}
                  aria-label={
                    row.parentTitle
                      ? `${row.page.title || "Untitled page"}, child of ${row.parentTitle}`
                      : undefined
                  }
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                  }}
                  className="min-w-0 break-words text-sm underline"
                >
                  {row.page.title || "Untitled page"}
                </Link>
              </div>
            ) : (
              <PageWindowRow row={row} next={next} first={first} focused={focusedKey === row.key} />
            )}
          </div>
        )}
        className="min-h-0 flex-1 overflow-x-hidden overscroll-contain"
      />
    </div>
  );
}

function PageWindowRow({
  row,
  next,
  first,
  focused,
}: {
  row: Extract<SpacePageTreeRow, { kind: "window" }>;
  next: (parentPageId: SpacePageId | null) => void;
  first: (parentPageId: SpacePageId | null) => void;
  focused: boolean;
}) {
  const { window } = row;
  const label = row.parentTitle ? `Child pages of ${row.parentTitle}` : "Pages";
  return (
    <div className="min-w-0 space-y-2">
      {window.error ? (
        <div>
          <p role="alert" className="text-sm">
            {window.error}
          </p>
          <Button
            data-space-action
            tabIndex={focused ? 0 : -1}
            variant="outline"
            aria-label={`Retry from first pages: ${label}`}
            onClick={() => first(window.parentPageId)}
          >
            Retry from first pages
          </Button>
        </div>
      ) : !window.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading pages…
        </p>
      ) : window.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {window.cursor !== undefined || window.data.nextCursor !== null
            ? "No pages in this window."
            : window.parentPageId === null
              ? "No pages in this space."
              : "No child pages."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {window.cursor ? (
          <Button
            data-space-action
            tabIndex={focused ? 0 : -1}
            variant="outline"
            aria-label={`First pages: ${label}`}
            disabled={window.pending}
            onClick={() => first(window.parentPageId)}
          >
            First pages
          </Button>
        ) : null}
        {window.data?.nextCursor && !window.error ? (
          <Button
            data-space-action
            tabIndex={focused ? 0 : -1}
            variant="outline"
            aria-label={`Next pages: ${label}`}
            disabled={window.pending}
            onClick={() => next(window.parentPageId)}
          >
            Next pages
          </Button>
        ) : null}
      </div>
    </div>
  );
}
