import type { EnvironmentId } from "@t2code/contracts";
import {
  commentRunsFromText,
  spaceCommentThreadChoices,
  submitSpaceComment,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceComment,
  SpaceCommentDispatchInput,
  SpaceCommentDispatchMode,
  SpaceCommentThread,
} from "@t2code/contracts/spaces";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Sheet } from "../../../components/ui/Sheet";
import { useProjects, useVisibleThreadShells } from "../../../state/entities";
import { commentErrorMessage, type CommentActions } from "./useCommentActions";

type Target = SpaceCommentDispatchInput["target"];

async function sendComment(input: {
  readonly note: string;
  readonly written: SpaceComment["id"] | null;
  readonly comment: SpaceComment;
  readonly thread: SpaceCommentThread;
  readonly actions: CommentActions;
  readonly mode: SpaceCommentDispatchMode;
  readonly target: Target;
  readonly onWritten: (id: SpaceComment["id"]) => void;
}): Promise<unknown> {
  const { actions, mode, target } = input;
  const dispatch = (commentId: SpaceComment["id"]) => actions.dispatch({ commentId, mode, target });
  try {
    const body = commentRunsFromText(input.note);
    if (input.written !== null || body.length === 0) {
      await dispatch(input.written ?? input.comment.id);
      return null;
    }
    const { result, dispatchError } = await submitSpaceComment({
      write: () => actions.reply(input.thread.id, body),
      dispatch: ({ commentId }) => dispatch(commentId),
    });
    if (dispatchError === null) return null;
    if (result.commentId !== undefined) input.onWritten(result.commentId);
    return dispatchError;
  } catch (cause) {
    return cause;
  }
}

/** Sends a comment to an existing session or a new one, optionally with a fresh reply as the message. */
export function SpacesCommentSendSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: SpaceCommentThread;
  readonly comment: SpaceComment;
  readonly actions: CommentActions;
  readonly onClose: () => void;
}) {
  const { environmentId, actions } = props;
  const insets = useSafeAreaInsets();
  const shells = useVisibleThreadShells();
  const projects = useProjects();
  const [mode, setMode] = useState<SpaceCommentDispatchMode>("edit");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A reply that was written but not sent is retried by id, not written twice.
  const [written, setWritten] = useState<typeof props.comment.id | null>(null);
  const [now] = useState(() => Date.now());
  const choices = spaceCommentThreadChoices({ shells, environmentId, query, now });
  const environmentProjects = projects.filter(
    (project) => project.environmentId === environmentId && !project.archivedAt,
  );
  const send = async () => {
    if (target === null) return;
    setBusy(true);
    setError(null);
    const failure = await sendComment({
      note,
      written,
      comment: props.comment,
      thread: props.thread,
      actions,
      mode,
      target,
      onWritten: setWritten,
    });
    setBusy(false);
    if (failure === null) props.onClose();
    else setError(commentErrorMessage(failure));
  };
  const selected = (candidate: Target) =>
    target !== null &&
    (target.kind === "thread"
      ? candidate.kind === "thread" && candidate.threadId === target.threadId
      : candidate.kind === "new" && candidate.projectId === target.projectId);
  return (
    <Sheet title="Send to session" onClose={props.onClose} dismissDisabled={busy}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row gap-2">
          <ControlPill
            variant={mode === "edit" ? "primary" : "pill"}
            label="Ask to edit"
            onPress={() => setMode("edit")}
          />
          <ControlPill
            variant={mode === "message" ? "primary" : "pill"}
            label="Just message"
            onPress={() => setMode("message")}
          />
        </View>
        <TextInput
          accessibilityLabel="Add a note"
          placeholder={written === null ? "Add a note (optional)" : "Note saved as a reply"}
          value={note}
          onChangeText={setNote}
          editable={written === null && !busy}
          multiline
        />
        <TextInput
          accessibilityLabel="Search sessions"
          placeholder="Search sessions"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <ListSection title="Existing session">
          {choices.map((choice, index) => (
            <ListChoiceRow
              key={choice.id}
              label={choice.label}
              selected={selected({ kind: "thread", threadId: choice.thread.threadId })}
              separated={index > 0}
              onPress={() => setTarget({ kind: "thread", threadId: choice.thread.threadId })}
            />
          ))}
        </ListSection>
        <ListSection title="New session in">
          {environmentProjects.map((project, index) => (
            <ListChoiceRow
              key={project.id}
              label={project.title}
              selected={selected({ kind: "new", projectId: project.id })}
              separated={index > 0}
              onPress={() => setTarget({ kind: "new", projectId: project.id })}
            />
          ))}
        </ListSection>
        {error === null ? null : (
          <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
            {error}
          </Text>
        )}
        <View className="flex-row">
          <ControlPill
            variant="primary"
            label={busy ? "Sending" : "Send"}
            disabled={busy || target === null}
            onPress={() => void send()}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}
