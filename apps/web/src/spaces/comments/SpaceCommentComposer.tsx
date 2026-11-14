import { useState } from "react";
import { commentRunsFromText, submitSpaceComment } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceCommentId,
  SpaceCommentMutationResult,
  SpaceRichText,
} from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { SpaceCommentSendControl } from "./SpaceCommentSendControl";
import type { SpaceCommentSendChoice } from "./useSpaceCommentActions";

type Armed = SpaceCommentSendChoice & { readonly title: string };

const messageOf = (error: unknown) =>
  error instanceof Error && error.message.length > 0 ? error.message : "Something went wrong.";

async function guarded(
  setBusy: (busy: boolean) => void,
  setError: (message: string | null) => void,
  work: () => Promise<void>,
) {
  setBusy(true);
  setError(null);
  try {
    await work();
  } catch (failure) {
    setError(messageOf(failure));
  } finally {
    setBusy(false);
  }
}

/** Writes a comment or reply, and can send it to a session in the same step. */
export function SpaceCommentComposer({
  environmentId,
  placeholder,
  submitLabel = "Comment",
  initialText = "",
  allowSend = true,
  write,
  dispatch,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly placeholder: string;
  readonly submitLabel?: string;
  readonly initialText?: string;
  readonly allowSend?: boolean;
  readonly write: (body: SpaceRichText) => Promise<Pick<SpaceCommentMutationResult, "commentId">>;
  readonly dispatch: (
    commentId: SpaceCommentId,
    choice: SpaceCommentSendChoice,
  ) => Promise<unknown>;
  readonly onDone?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsent, setUnsent] = useState<SpaceCommentId | null>(null);
  const body = commentRunsFromText(text);
  const canSubmit = body.length > 0 && !busy;

  const finish = () => {
    setText("");
    setArmed(null);
    setUnsent(null);
    onDone?.();
  };
  const submit = () => {
    if (!canSubmit) return;
    void guarded(setBusy, setError, async () => {
      const { result, dispatchError } = await submitSpaceComment<
        Pick<SpaceCommentMutationResult, "commentId">
      >({
        write: () => write(body),
        ...(armed === null ? {} : { dispatch: (saved) => dispatch(saved.commentId, armed) }),
      });
      if (dispatchError === null) return finish();
      setText("");
      setUnsent(result.commentId ?? null);
      setError(messageOf(dispatchError));
    });
  };
  const retrySend = () => {
    if (unsent === null || armed === null) return;
    void guarded(setBusy, setError, async () => {
      await dispatch(unsent, armed);
      finish();
    });
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={placeholder}
        placeholder={placeholder}
        rows={2}
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            if (event.key === "Escape" || event.key === "Enter") event.stopPropagation();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {error === null ? null : (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1">
        {armed === null ? null : (
          <span className="mr-auto truncate text-muted-foreground text-xs">
            {armed.mode === "edit" ? "Ask to edit" : "Message"}: {armed.title}
          </span>
        )}
        {unsent !== null && armed !== null ? (
          <>
            <Button size="xs" variant="ghost" disabled={busy} onClick={finish}>
              Don't send
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => retrySend()}>
              Retry sending
            </Button>
          </>
        ) : null}
        {allowSend && unsent === null ? (
          <SpaceCommentSendControl
            environmentId={environmentId}
            label="Send to session"
            onPick={setArmed}
          />
        ) : null}
        {unsent === null ? (
          <Button size="xs" disabled={!canSubmit} onClick={() => submit()}>
            {armed === null ? submitLabel : `${submitLabel} and send`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
