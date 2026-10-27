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
}: {
  publication: SpacesNativePublication;
  editable?: boolean;
  onDone?: () => Promise<void>;
  onCompositionChange?: (composing: boolean) => void;
  onPublicationBlockedChange?: (blocked: boolean) => void;
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
      .then(() => run(handle))
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
    const position = current.selection.start;
    let offset = 0;
    const selected =
      current.runs.find((run) => {
        const start = offset;
        offset += run.text.length;
        return position >= start && position < offset;
      }) ?? current.runs.at(-1);
    const active = current.selection.start === current.selection.end ? current.typing : selected;
    return command((handle) =>
      handle.format(
        JSON.stringify({
          revision: current.revision,
          selection: current.selection,
          mark,
          enabled: !active?.[mark],
        }),
      ),
    );
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
      .then(() => handle.freeze())
      .then(async (frozen) => {
        if (!frozen) {
          setError("Finish the current composition before closing this input");
          return;
        }
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
            accessibilityLabel={`Toggle ${mark}`}
            disabled={disabled}
            onPress={() => void format(mark)}
          >
            <Text className="text-foreground">{mark}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={() =>
            void command((handle) =>
              handle.history(true, publication.getSnapshot().observed.revision),
            )
          }
        >
          <Text className="text-foreground">Undo</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          onPress={() =>
            void command((handle) =>
              handle.history(false, publication.getSnapshot().observed.revision),
            )
          }
        >
          <Text className="text-foreground">Redo</Text>
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
