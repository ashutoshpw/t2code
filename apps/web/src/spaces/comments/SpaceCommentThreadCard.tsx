import { Link } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";
import { scopeThreadRef } from "@t2code/client-runtime/environment";
import { commentText } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceComment, SpaceCommentThread, SpacePageId } from "@t2code/contracts/spaces";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { buildThreadRouteParams } from "~/threadRoutes";
import { SpaceCommentComposer } from "./SpaceCommentComposer";
import { SpaceCommentDispatchChip } from "./SpaceCommentDispatchChip";
import { SpaceCommentSendControl } from "./SpaceCommentSendControl";
import { useSpaceCommentActions } from "./useSpaceCommentActions";

const failure = (title: string) => (error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });

function Author({
  environmentId,
  comment,
}: {
  readonly environmentId: EnvironmentId;
  readonly comment: SpaceComment;
}) {
  if (comment.author.kind === "user") return <span className="font-medium">You</span>;
  return (
    <Link
      className="font-medium underline-offset-2 hover:underline"
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, comment.author.threadId))}
    >
      Agent
    </Link>
  );
}

function CommentRow({
  environmentId,
  pageId,
  thread,
  comment,
  first,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly thread: SpaceCommentThread;
  readonly comment: SpaceComment;
  readonly first: boolean;
}) {
  const actions = useSpaceCommentActions(environmentId, pageId);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const own = comment.author.kind === "user" && actions.writable;
  const removesThread = first && thread.comments.length === 1;
  const remove = () => actions.remove(comment.id).catch(failure("Couldn't delete the comment"));
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs">
        <Author environmentId={environmentId} comment={comment} />
        {comment.editedAt === null ? null : <span className="text-muted-foreground">edited</span>}
        {own ? (
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost" size="icon-micro" aria-label="Comment actions" />}
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setEditing(true)}>Edit</MenuItem>
              <MenuItem
                variant="destructive"
                onClick={() => (first ? setConfirming(true) : void remove())}
              >
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {editing ? (
        <SpaceCommentComposer
          environmentId={environmentId}
          placeholder="Edit comment"
          submitLabel="Save"
          initialText={commentText(comment.body)}
          allowSend={false}
          write={(body) => actions.edit(comment.id, body)}
          dispatch={actions.dispatch}
          onDone={() => setEditing(false)}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm">{commentText(comment.body)}</p>
      )}
      {comment.dispatch === undefined ? (
        comment.author.kind === "user" && actions.writable ? (
          <div className="flex">
            <SpaceCommentSendControl
              environmentId={environmentId}
              label="Send to session…"
              onPick={(choice) =>
                void actions.dispatch(comment.id, choice).catch(failure("Couldn't send"))
              }
            />
          </div>
        ) : null
      ) : (
        <div className="flex">
          <SpaceCommentDispatchChip environmentId={environmentId} dispatch={comment.dispatch} />
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removesThread ? "Delete this thread?" : "Delete this comment?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removesThread
                ? "Deleting the first comment deletes the whole thread, including its replies."
                : "This comment will be removed from the thread."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => void remove()}
            >
              Delete
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

/** One comment thread: its comments, replies, and resolve or reopen. */
export function SpaceCommentThreadCard({
  environmentId,
  pageId,
  thread,
  onShowInPage,
  textGone = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly thread: SpaceCommentThread;
  readonly onShowInPage?: (() => void) | undefined;
  /** The quoted text no longer exists in the block, so the comment sits on the whole block. */
  readonly textGone?: boolean;
}) {
  const actions = useSpaceCommentActions(environmentId, pageId);
  const open = thread.status === "open";
  const detached = thread.anchorState === "detached";
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border p-3"
      aria-label="Comment thread"
      data-space-comment-card={thread.id}
    >
      {thread.anchor.kind === "range" ? (
        <blockquote className="truncate border-s-2 ps-2 text-muted-foreground text-xs">
          {`“${thread.anchor.quote}”`}
        </blockquote>
      ) : null}
      {detached || textGone ? (
        <p className="text-muted-foreground text-xs">
          {detached ? "This block was removed" : "The text this comment was on is gone"}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {thread.comments.map((comment, index) => (
          <CommentRow
            key={comment.id}
            environmentId={environmentId}
            pageId={pageId}
            thread={thread}
            comment={comment}
            first={index === 0}
          />
        ))}
      </ul>
      {actions.writable && open ? (
        <SpaceCommentComposer
          environmentId={environmentId}
          placeholder="Reply"
          submitLabel="Reply"
          write={(body) => actions.reply(thread.id, body)}
          dispatch={actions.dispatch}
        />
      ) : null}
      <div className="flex items-center justify-end gap-1">
        {onShowInPage && !detached ? (
          <Button variant="ghost" size="xs" onClick={onShowInPage}>
            Show in page
          </Button>
        ) : null}
        {actions.writable ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              void (open ? actions.resolve(thread.id) : actions.reopen(thread.id)).catch(
                failure(open ? "Couldn't resolve the thread" : "Couldn't reopen the thread"),
              )
            }
          >
            {open ? "Resolve" : "Reopen"}
          </Button>
        ) : null}
      </div>
    </article>
  );
}
