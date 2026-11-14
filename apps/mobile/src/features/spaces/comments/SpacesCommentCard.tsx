import type { EnvironmentId } from "@t2code/contracts";
import {
  commentRunsFromText,
  commentText,
  spaceCommentDispatchLabel,
} from "@t2code/client-runtime/spaces";
import type { SpaceComment, SpaceCommentThread } from "@t2code/contracts/spaces";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { ControlPill } from "../../../components/ui/ControlPill";
import * as Dialog from "../../../components/ui/Dialog";
import { commentErrorMessage, type CommentActions } from "./useCommentActions";

export interface CommentCardProps {
  readonly environmentId: EnvironmentId;
  readonly thread: SpaceCommentThread;
  readonly actions: CommentActions;
  readonly onSend: (thread: SpaceCommentThread, comment: SpaceComment) => void;
  readonly onOpenThread: (threadId: string) => void;
}

async function guardedRun(
  setBusy: (busy: boolean) => void,
  setError: (message: string | null) => void,
  work: () => Promise<unknown>,
) {
  setBusy(true);
  setError(null);
  try {
    await work();
  } catch (cause) {
    setError(commentErrorMessage(cause));
  } finally {
    setBusy(false);
  }
}

/** One comment thread: quoted text, its comments, a reply box and the thread's actions. */
export function SpacesCommentCard(props: CommentCardProps) {
  const { thread, actions } = props;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<unknown>) => guardedRun(setBusy, setError, work);
  const sendReply = () => {
    const body = commentRunsFromText(draft);
    if (body.length === 0) return;
    void run(async () => {
      await actions.reply(thread.id, body);
      setDraft("");
    });
  };
  const own = (comment: SpaceComment) => comment.author.kind === "user" && actions.canWrite;
  const menu = (comment: SpaceComment) => {
    if (!own(comment)) return;
    const first = thread.comments[0]?.id === comment.id;
    Dialog.alert("Comment", undefined, [
      {
        text: "Edit",
        onPress: () =>
          Dialog.prompt({
            title: "Edit comment",
            initialValue: commentText(comment.body),
            confirmText: "Save",
            onConfirm: (value) => {
              const body = commentRunsFromText(value);
              if (body.length > 0) void run(() => actions.edit(comment.id, body));
            },
          }),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          const remove = () => void run(() => actions.remove(comment.id));
          if (!first) remove();
          else
            Dialog.confirm({
              title: "Delete this comment?",
              message: "Deleting the first comment deletes the whole thread.",
              confirmText: "Delete",
              destructive: true,
              onConfirm: remove,
            });
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };
  const resolved = thread.status === "resolved";
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-4">
      {thread.anchor.kind === "range" ? (
        <Text
          numberOfLines={3}
          className="border-l-2 border-border pl-3 text-sm text-foreground-muted"
        >
          {thread.anchor.quote}
        </Text>
      ) : null}
      {thread.comments.map((comment) => (
        <Pressable
          key={comment.id}
          accessibilityHint={own(comment) ? "Long press to edit or delete" : undefined}
          onLongPress={() => menu(comment)}
          className="gap-1"
        >
          <Text className="text-xs font-t2-medium text-foreground-muted">
            {comment.author.kind === "user" ? "You" : "Agent"}
            {comment.editedAt === null ? "" : " · edited"}
          </Text>
          <Text className="text-foreground">{commentText(comment.body)}</Text>
          <View className="flex-row flex-wrap gap-2">
            {comment.dispatch ? (
              <Chip
                size="small"
                icon="arrow.up.right"
                label={`${comment.dispatch.mode === "edit" ? "Edit" : "Message"} · ${spaceCommentDispatchLabel(comment.dispatch.status)}`}
                accessibilityLabel="Open session"
                onPress={() => comment.dispatch && props.onOpenThread(comment.dispatch.threadId)}
              />
            ) : comment.author.kind === "user" && actions.canWrite ? (
              <ControlPill
                variant="pill"
                label="Send to session"
                onPress={() => props.onSend(thread, comment)}
              />
            ) : null}
          </View>
        </Pressable>
      ))}
      {actions.canWrite ? (
        <>
          <TextInput
            accessibilityLabel="Reply"
            placeholder="Reply"
            value={draft}
            onChangeText={setDraft}
            multiline
            editable={!busy}
          />
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              variant="primary"
              label="Reply"
              disabled={busy || draft.trim().length === 0}
              onPress={sendReply}
            />
            <ControlPill
              variant="pill"
              label={resolved ? "Reopen" : "Resolve"}
              disabled={busy}
              onPress={() => void run(() => actions.setResolved(thread.id, !resolved))}
            />
          </View>
        </>
      ) : null}
      {error === null ? null : (
        <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
          {error}
        </Text>
      )}
    </View>
  );
}
