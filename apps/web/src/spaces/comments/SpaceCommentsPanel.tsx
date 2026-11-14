import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceBlockId,
  SpaceCommentThreadId,
  SpaceCursor,
  SpacePageId,
} from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { SpaceCommentThreadCard } from "./SpaceCommentThreadCard";
import { spaceCommentsPanelAtom, type SpaceCommentsPanelTarget } from "./spaceCommentsPanelState";
import { useSpaceCommentList } from "./useSpaceCommentList";

export function SpaceCommentsPanelHost() {
  const target = useAtomValue(spaceCommentsPanelAtom);
  if (target === null) return null;
  return (
    <SpaceCommentsPanel
      key={`${target.environmentId}:${target.pageId}`}
      target={target}
      onClose={() => appAtomRegistry.set(spaceCommentsPanelAtom, null)}
    />
  );
}

function Window({
  environmentId,
  pageId,
  status,
  cursor,
  focusId,
  last,
  onLoadMore,
  onShow,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly status: "open" | "resolved";
  readonly cursor: SpaceCursor | undefined;
  readonly focusId: SpaceCommentThreadId | undefined;
  readonly last: boolean;
  readonly onLoadMore: (cursor: SpaceCursor) => void;
  readonly onShow: ((blockId: SpaceBlockId) => void) | null;
}) {
  const list = useSpaceCommentList(environmentId, pageId, status, { cursor });
  const attached = list.threads.filter((thread) => thread.resolvedBlockId !== undefined);
  const detached = list.threads.filter((thread) => thread.resolvedBlockId === undefined);
  const card = (thread: (typeof list.threads)[number]) => (
    <div
      key={thread.id}
      ref={(element) => {
        if (thread.id === focusId) element?.scrollIntoView?.({ block: "nearest" });
      }}
    >
      <SpaceCommentThreadCard
        environmentId={environmentId}
        pageId={pageId}
        thread={thread}
        onShowInPage={
          onShow && thread.resolvedBlockId ? () => onShow(thread.resolvedBlockId!) : undefined
        }
      />
    </div>
  );
  return (
    <>
      {list.error ? (
        <p role="alert" className="text-destructive-foreground text-sm">
          {list.error}
        </p>
      ) : null}
      {!list.supported ? (
        <p role="status" className="text-muted-foreground text-sm">
          This server doesn't support comments.
        </p>
      ) : null}
      {list.supported && !list.loaded && !list.error ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading comments…
        </p>
      ) : null}
      {attached.map(card)}
      {detached.length > 0 ? (
        <section aria-label="Detached" className="flex flex-col gap-3">
          <h3 className="font-medium text-muted-foreground text-xs">Detached</h3>
          {detached.map(card)}
        </section>
      ) : null}
      {last && list.nextCursor ? (
        <Button variant="outline" size="sm" onClick={() => onLoadMore(list.nextCursor!)}>
          Load more
        </Button>
      ) : null}
      {last && list.loaded && list.threads.length === 0 && cursor === undefined ? (
        <p className="text-muted-foreground text-sm">
          {status === "open" ? "No open comments on this page." : "No resolved comments."}
        </p>
      ) : null}
    </>
  );
}

function SpaceCommentsPanel({
  target,
  onClose,
}: {
  readonly target: SpaceCommentsPanelTarget;
  readonly onClose: () => void;
}) {
  const { environmentId, pageId } = target;
  const router = useRouter();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [cursors, setCursors] = useState<readonly (SpaceCursor | undefined)[]>([undefined]);
  const spaceId = router.state.matches.at(-1)?.params;
  const routeSpaceId = spaceId && "spaceId" in spaceId ? spaceId.spaceId : undefined;
  const show =
    routeSpaceId === undefined
      ? null
      : (blockId: SpaceBlockId) => {
          onClose();
          void router.navigate({
            to: "/spaces/$environmentId/$spaceId/$pageId",
            params: { environmentId, spaceId: routeSpaceId, pageId },
            search: { block: blockId },
          });
        };
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetPopup side="right" className="w-[min(88vw,26rem)]">
        <SheetHeader>
          <SheetTitle>Comments</SheetTitle>
          <SheetDescription>Threads on this page.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-6">
          <ToggleGroup
            value={[status]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "open" || next === "resolved") {
                setStatus(next);
                setCursors([undefined]);
              }
            }}
            aria-label="Thread status"
          >
            <ToggleGroupItem value="open">Open</ToggleGroupItem>
            <ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
          </ToggleGroup>
          {cursors.map((cursor, index) => (
            <Window
              key={`${status}:${cursor ?? "first"}`}
              environmentId={environmentId}
              pageId={pageId}
              status={status}
              cursor={cursor}
              focusId={target.commentThreadId}
              last={index === cursors.length - 1}
              onLoadMore={(next) => setCursors((held) => [...held, next])}
              onShow={show}
            />
          ))}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
