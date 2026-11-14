import { useSyncExternalStore } from "react";

import { Popover, PopoverPopup } from "~/components/ui/popover";
import type { SpaceCommentsController } from "./commentsController";
import { SpaceCommentComposer } from "./SpaceCommentComposer";
import { SpaceCommentThreadCard } from "./SpaceCommentThreadCard";
import { useSpaceCommentActions } from "./useSpaceCommentActions";

/** The comment popover of one editor: a block's threads, or a new comment being written. */
export function SpaceCommentsLayer({
  controller,
}: {
  readonly controller: SpaceCommentsController;
}) {
  const { threads, popover } = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { environmentId, pageId } = controller;
  const actions = useSpaceCommentActions(environmentId, pageId);
  if (popover === null) return null;
  const blockThreads = threads.filter((thread) => thread.resolvedBlockId === popover.blockId);
  return (
    <Popover open onOpenChange={(open) => !open && controller.close()}>
      <PopoverPopup
        anchor={controller.anchorOf(popover)}
        align="end"
        side="bottom"
        width="lg"
        aria-label="Comments"
      >
        {popover.kind === "compose" && popover.anchor ? (
          <div className="flex flex-col gap-2">
            {popover.anchor.kind === "range" ? (
              <blockquote className="truncate border-s-2 ps-2 text-muted-foreground text-xs">
                {`“${popover.anchor.quote}”`}
              </blockquote>
            ) : null}
            <SpaceCommentComposer
              environmentId={environmentId}
              placeholder="Add a comment"
              write={(body) =>
                actions.create(popover.blockId, popover.anchor ?? { kind: "block" }, body)
              }
              dispatch={actions.dispatch}
              onDone={() => controller.close()}
            />
          </div>
        ) : (
          <div className="flex max-h-96 flex-col gap-3 overflow-y-auto">
            {blockThreads.map((thread) => (
              <SpaceCommentThreadCard
                key={thread.id}
                environmentId={environmentId}
                pageId={pageId}
                thread={thread}
                textGone={controller.rangeGone(thread)}
              />
            ))}
            {actions.writable ? (
              <SpaceCommentComposer
                environmentId={environmentId}
                placeholder="Add a comment"
                write={(body) => actions.create(popover.blockId, { kind: "block" }, body)}
                dispatch={actions.dispatch}
              />
            ) : null}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
