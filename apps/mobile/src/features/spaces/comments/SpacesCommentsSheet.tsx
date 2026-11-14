import type { EnvironmentId } from "@t2code/contracts";
import { groupSpaceCommentThreads } from "@t2code/client-runtime/spaces";
import type {
  SpaceComment,
  SpaceCommentThread,
  SpaceCursor,
  SpacePageId,
} from "@t2code/contracts/spaces";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { Sheet } from "../../../components/ui/Sheet";
import { useEnvironmentQuery } from "../../../state/query";
import { spacesEnvironment } from "../../../state/spaces";
import { SpacesCommentCard } from "./SpacesCommentCard";
import { SpacesCommentSendSheet } from "./SpacesCommentSendSheet";
import { useCommentActions } from "./useCommentActions";

type Status = "open" | "resolved";

/** A page's comment threads, newest window first, with Open/Resolved and paging. */
export function SpacesCommentsSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly onClose: () => void;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<Status>("open");
  const [cursors, setCursors] = useState<ReadonlyArray<SpaceCursor | undefined>>([undefined]);
  const [sending, setSending] = useState<{
    thread: SpaceCommentThread;
    comment: SpaceComment;
  } | null>(null);
  const firstWindow = useEnvironmentQuery(
    spacesEnvironment.comments.list({
      environmentId: props.environmentId,
      input: { environmentId: props.environmentId, pageId: props.pageId, status },
    }),
  );
  const admission = firstWindow.data?.mutationAdmission;
  const actions = useCommentActions(props.environmentId, props.pageId, admission);
  const switchStatus = (next: Status) => {
    setStatus(next);
    setCursors([undefined]);
  };
  return (
    <Sheet title="Comments" onClose={props.onClose}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row gap-2">
          <ControlPill
            variant={status === "open" ? "primary" : "pill"}
            label="Open"
            onPress={() => switchStatus("open")}
          />
          <ControlPill
            variant={status === "resolved" ? "primary" : "pill"}
            label="Resolved"
            onPress={() => switchStatus("resolved")}
          />
        </View>
        {cursors.map((cursor, index) => (
          <CommentsWindow
            key={`${status}:${cursor ?? "first"}`}
            {...props}
            status={status}
            cursor={cursor}
            last={index === cursors.length - 1}
            actions={actions}
            onMore={(next) => setCursors((held) => [...held, next])}
            onSend={(thread, comment) => setSending({ thread, comment })}
          />
        ))}
      </ScrollView>
      {sending ? (
        <SpacesCommentSendSheet
          environmentId={props.environmentId}
          thread={sending.thread}
          comment={sending.comment}
          actions={actions}
          onClose={() => setSending(null)}
        />
      ) : null}
    </Sheet>
  );
}

function CommentsWindow(props: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly status: Status;
  readonly cursor: SpaceCursor | undefined;
  readonly last: boolean;
  readonly actions: ReturnType<typeof useCommentActions>;
  readonly onMore: (cursor: SpaceCursor) => void;
  readonly onSend: (thread: SpaceCommentThread, comment: SpaceComment) => void;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: string) => void;
}) {
  const { environmentId, pageId, status } = props;
  const query = useEnvironmentQuery(
    spacesEnvironment.comments.list({
      environmentId,
      input: {
        environmentId,
        pageId,
        status,
        ...(props.cursor === undefined ? {} : { cursor: props.cursor }),
      },
    }),
  );
  const data = query.data;
  if (data === null)
    return (
      <Text className="text-foreground-muted">
        {query.error ?? (query.isPending ? "Loading comments…" : "Comments are unavailable.")}
      </Text>
    );
  const grouped = status === "open" ? groupSpaceCommentThreads(data.threads) : null;
  const attached = grouped
    ? data.threads.filter((thread) => thread.resolvedBlockId !== undefined)
    : data.threads;
  const card = (thread: SpaceCommentThread) => (
    <SpacesCommentCard
      key={thread.id}
      environmentId={environmentId}
      thread={thread}
      actions={props.actions}
      onSend={props.onSend}
      onOpenThread={(threadId) => props.onOpenThread(environmentId, threadId)}
    />
  );
  return (
    <>
      {data.threads.length === 0 && props.cursor === undefined ? (
        <Text className="text-foreground-muted">
          {status === "open" ? "No open comments." : "No resolved comments."}
        </Text>
      ) : null}
      {attached.map(card)}
      {grouped && grouped.detached.length > 0 ? (
        <>
          <Text className="text-sm font-t2-medium text-foreground-muted">
            Detached: the block was removed
          </Text>
          {grouped.detached.map(card)}
        </>
      ) : null}
      {props.last && data.nextCursor !== null ? (
        <View className="flex-row">
          <ControlPill
            variant="pill"
            label="Load more"
            onPress={() => data.nextCursor !== null && props.onMore(data.nextCursor)}
          />
        </View>
      ) : null}
    </>
  );
}
