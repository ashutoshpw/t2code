import { requireNativeView, requireOptionalNativeModule } from "expo";
import { useEffect, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { Pressable, Text, View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import type { SpacesNativePublication } from "./nativeSpacesPublication";
import type { SpacesNativeMark, SpacesNativeSnapshot } from "./nativeSpacesProtocol";

interface EditorHandle {
  format: (commandJson: string) => Promise<boolean>;
  history: (backwards: boolean, revision: number) => Promise<boolean>;
  focus: () => Promise<void>;
  blur: () => Promise<void>;
  freeze: () => Promise<string | null>;
  resume: (revision: number) => Promise<boolean>;
}

interface NativeProps extends ViewProps {
  ref?: Ref<EditorHandle>;
  documentJson: string;
  editable: boolean;
  onSpacesChange: (event: NativeSyntheticEvent<SpacesNativeSnapshot>) => void;
  onSpacesSelection: (event: NativeSyntheticEvent<SpacesNativeSnapshot>) => void;
  onSpacesLimit: () => void;
}

function resolveNativeEditor() {
  try {
    const module = requireOptionalNativeModule<{ readonly richRunBridgeRevision?: number }>(
      "T2SpacesEditor",
    );
    return module?.richRunBridgeRevision === 2
      ? requireNativeView<NativeProps>("T2SpacesEditor")
      : null;
  } catch {
    return null;
  }
}
const NativeEditor = resolveNativeEditor();
export const spacesNativeEditorAvailable = NativeEditor !== null;

export function SpacesNativeBlockEditor({
  publication,
  editable = true,
  onDone,
  onCompositionChange,
  onPublicationBlockedChange,
  assertCurrent,
}: {
  publication: SpacesNativePublication;
  editable?: boolean;
  onDone?: () => Promise<void>;
  onCompositionChange?: (composing: boolean) => void;
  onPublicationBlockedChange?: (blocked: boolean) => void;
  assertCurrent?: () => void;
}) {
  const editor = useRef<EditorHandle>(null);
  const state = useSyncExternalStore(publication.subscribe, publication.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [paused, setPaused] = useState(false);

  // oxlint-disable-next-line t2code/react-effect-budget -- Focus the native view after its ref attaches on mount.
  useEffect(() => {
    void editor.current?.focus().catch(() => setError("Could not focus the native editor"));
  }, []);

  function receive(event: NativeSyntheticEvent<SpacesNativeSnapshot>, change: boolean) {
    publication.receive(event.nativeEvent, change);
    const current = publication.getSnapshot();
    onCompositionChange?.(current.observed.composing);
    onPublicationBlockedChange?.(current.blocked);
  }

  function command(run: (handle: EditorHandle) => Promise<boolean>) {
    const handle = editor.current;
    if (!editable || !handle) {
      setError("Restore edit access before changing this input");
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => {
        if (editor.current !== handle) throw new Error("This native input is no longer mounted");
        assertCurrent?.();
        return run(handle);
      })
      .then(
        (accepted) =>
          setError(
            accepted ? null : "Selection changed, input is paused or the block limit was reached",
          ),
        (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Could not update native input"),
      );
  }

  function format(mark: SpacesNativeMark) {
    const current = publication.getSnapshot().observed;
    return command((handle) => handle.format(publication.formatCommand(mark, current)));
  }

  function history(backwards: boolean) {
    const expected = publication.getSnapshot().observed;
    return command((handle) => handle.history(backwards, publication.historyRevision(expected)));
  }

  function done() {
    if (!onDone || finishing) return;
    const handle = editor.current;
    if (!handle) {
      setError("The native input is unavailable");
      return;
    }
    setFinishing(true);
    const completion = Promise.resolve()
      .then(() => {
        if (editor.current !== handle) throw new Error("This native input is no longer mounted");
        return handle.freeze();
      })
      .then(async (frozen) => {
        if (!frozen) {
          setError("Finish the current composition before closing this input");
          return;
        }
        if (editor.current !== handle) throw new Error("This native input is no longer mounted");
        setPaused(true);
        publication.receive(JSON.parse(frozen), true);
        const current = publication.getSnapshot();
        if (current.blocked || current.observed.composing) {
          setError(current.error ?? "The native input is still composing");
          return;
        }
        await onDone();
      });
    void completion.then(
      () => setFinishing(false),
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not retain this input");
        setFinishing(false);
      },
    );
  }

  const { composing: _composing, typing: _typing, ...document } = state.admitted;
  const disabled = !editable || state.observed.composing || paused || finishing;
  return (
    <View>
      <View className="flex-row flex-wrap gap-4 pb-2">
        {(["bold", "italic", "code"] as const).map((mark) => (
          <Pressable
            key={mark}
            accessibilityRole="button"
            accessibilityLabel={`Toggle ${mark === "code" ? "inline code" : mark}`}
            accessibilityState={{
              checked: publication.markState(mark),
              disabled: disabled || state.blocked,
            }}
            disabled={disabled || state.blocked}
            onPress={() => void format(mark)}
          >
            <Text className="text-foreground">
              {mark === "code" ? "Inline code" : mark === "bold" ? "Bold" : "Italic"}
              {publication.markState(mark) === "mixed" ? " (mixed)" : ""}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          accessibilityLabel="Undo local input"
          onPress={() => void history(true)}
        >
          <Text className="text-foreground">Undo input</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          accessibilityLabel="Redo local input"
          onPress={() => void history(false)}
        >
          <Text className="text-foreground">Redo input</Text>
        </Pressable>
        {onDone ? (
          <Pressable
            accessibilityRole="button"
            disabled={finishing || state.observed.composing}
            onPress={() => void done()}
          >
            <Text className="text-foreground">Done editing</Text>
          </Pressable>
        ) : null}
        {paused ? (
          <Pressable
            accessibilityRole="button"
            disabled={!editable || finishing}
            onPress={() =>
              void command(async (handle) => {
                const resumed = await handle.resume(publication.getSnapshot().observed.revision);
                if (resumed) setPaused(false);
                return resumed;
              })
            }
          >
            <Text className="text-foreground">Resume input</Text>
          </Pressable>
        ) : null}
      </View>
      {NativeEditor ? (
        <NativeEditor
          ref={editor}
          style={{ height: 220 }}
          editable={editable}
          documentJson={JSON.stringify(document)}
          onSpacesChange={(event) => receive(event, true)}
          onSpacesSelection={(event) => receive(event, false)}
          onSpacesLimit={() => setError("Block limit reached. Try a smaller text replacement.")}
        />
      ) : (
        <Text className="text-foreground">
          Update this device’s app to use the native Spaces editor.
        </Text>
      )}
      <Text className="text-foreground-muted">
        Limit: 16,384 UTF-16 units and 1,024 styled runs. Large pastes may need to be split.
      </Text>
      {state.error || error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {state.error ?? error}
        </Text>
      ) : null}
    </View>
  );
}
