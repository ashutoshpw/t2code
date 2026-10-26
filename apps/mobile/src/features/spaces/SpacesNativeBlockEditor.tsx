import { requireNativeView } from "expo";
import { useEffect, useRef, useState, type Ref } from "react";
import { Pressable, Text, View, type NativeSyntheticEvent, type ViewProps } from "react-native";
import type { SpaceBlock } from "@t2code/contracts/spaces";

import { applySpacesNativeSnapshot, receiveSpacesNativeSnapshot } from "./nativeSpacesAdapter";
import {
  decodeSpacesNativeSnapshot,
  type SpacesNativeDocument,
  type SpacesNativeMark,
  type SpacesNativeSnapshot,
} from "./nativeSpacesProtocol";

interface EditorHandle {
  format: (commandJson: string) => Promise<boolean>;
  history: (backwards: boolean, revision: number) => Promise<boolean>;
  focus: () => Promise<void>;
  blur: () => Promise<void>;
}

interface NativeProps extends ViewProps {
  ref?: Ref<EditorHandle>;
  documentJson: string;
  onSpacesChange: (event: NativeSyntheticEvent<SpacesNativeSnapshot>) => void;
  onSpacesSelection: (event: NativeSyntheticEvent<SpacesNativeSnapshot>) => void;
  onSpacesLimit: () => void;
}

const NativeEditor = requireNativeView<NativeProps>("T2SpacesEditor");

export function SpacesNativeBlockEditor({
  initialBlock,
  initialDocument,
  onChange,
  onCompositionChange,
  onPublicationBlockedChange,
}: {
  initialBlock: SpaceBlock;
  initialDocument: SpacesNativeDocument;
  onChange: (block: SpaceBlock) => void;
  onCompositionChange: (composing: boolean) => void;
  onPublicationBlockedChange: (blocked: boolean) => void;
}) {
  const editor = useRef<EditorHandle>(null);
  // External replacements require an explicit remount after draft/conflict resolution.
  const [baseBlock] = useState(initialBlock);
  const [snapshot, setSnapshot] = useState<SpacesNativeSnapshot>({
    ...initialDocument,
    composing: false,
    typing: initialDocument.runs[0] ?? { bold: false, italic: false, code: false },
  });
  const latest = useRef(snapshot);
  const commands = useRef(snapshot);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publicationError, setPublicationError] = useState<string | null>(null);

  // oxlint-disable-next-line t2code/react-effect-budget -- Focus the native view after its ref attaches on mount.
  useEffect(() => {
    void editor.current?.focus().catch(() => setError("Could not focus the native editor"));
  }, []);

  function receive(event: NativeSyntheticEvent<SpacesNativeSnapshot>, change: boolean) {
    try {
      const observed = decodeSpacesNativeSnapshot(event.nativeEvent);
      if (observed.revision < commands.current.revision) return;
      commands.current = observed;
      setComposing(observed.composing);
      onCompositionChange(observed.composing);
      const next = receiveSpacesNativeSnapshot(latest.current, observed);
      if (next === latest.current) return;
      if (change) {
        if (!next.composing) {
          onChange(applySpacesNativeSnapshot(baseBlock, next));
          onPublicationBlockedChange(false);
          setPublicationError(null);
          if (next.revision > latest.current.revision) setError(null);
        }
      }
      latest.current = next;
      setSnapshot(next);
    } catch (cause) {
      onPublicationBlockedChange(true);
      setPublicationError(
        cause instanceof Error ? cause.message : "Native editor rejected this change",
      );
    }
  }

  async function format(mark: SpacesNativeMark) {
    const current = commands.current;
    const position = current.selection.start;
    let offset = 0;
    const selected =
      current.runs.find((run) => {
        const start = offset;
        offset += run.text.length;
        return position >= start && position < offset;
      }) ?? current.runs.at(-1);
    const active = current.selection.start === current.selection.end ? current.typing : selected;
    const accepted = await editor.current?.format(
      JSON.stringify({
        revision: current.revision,
        selection: current.selection,
        mark,
        enabled: !active?.[mark],
      }),
    );
    if (!accepted) setError("Selection changed or block limit reached; try a smaller selection");
  }

  async function history(backwards: boolean) {
    const accepted = await editor.current?.history(backwards, commands.current.revision);
    if (!accepted) setError("No matching local edit to undo or redo");
  }

  const { composing: _composing, typing: _typing, ...document } = snapshot;
  return (
    <View>
      <View className="flex-row gap-4 pb-2">
        {(["bold", "italic", "code"] as const).map((mark) => (
          <Pressable
            key={mark}
            accessibilityRole="button"
            accessibilityLabel={`Toggle ${mark}`}
            disabled={composing}
            onPress={() => void format(mark)}
          >
            <Text className="text-foreground">{mark}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          disabled={composing}
          onPress={() => void history(true)}
        >
          <Text className="text-foreground">Undo</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={composing}
          onPress={() => void history(false)}
        >
          <Text className="text-foreground">Redo</Text>
        </Pressable>
      </View>
      <NativeEditor
        ref={editor}
        style={{ minHeight: 120 }}
        documentJson={JSON.stringify(document)}
        onSpacesChange={(event) => receive(event, true)}
        onSpacesSelection={(event) => receive(event, false)}
        onSpacesLimit={() => setError("Block limit reached. Try a smaller text replacement.")}
      />
      <Text className="text-muted-foreground">
        Limit: 16,384 UTF-16 units and 1,024 styled runs. Large pastes may need to be split.
      </Text>
      {publicationError || error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {publicationError ?? error}
        </Text>
      ) : null}
    </View>
  );
}
