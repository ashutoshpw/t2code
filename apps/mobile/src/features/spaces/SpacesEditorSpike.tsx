import type { SpaceBlock } from "@t2code/contracts/spaces";
import { spaceBlockRuns, spacePlainText } from "@t2code/client-runtime/spaces";
import * as Clipboard from "expo-clipboard";
import { useCallback, useRef, useState, type ComponentProps } from "react";
import { FlatList, Pressable, Text, View, type FlatListProps } from "react-native";

import { nativeDocumentForSpaceBlock } from "./nativeSpacesAdapter";
import { SpacesNativeBlockEditor } from "./SpacesNativeBlockEditor";
import { SpacesNativePublication } from "./nativeSpacesPublication";

type SpacesCellProps = ComponentProps<
  NonNullable<FlatListProps<SpaceBlock>["CellRendererComponent"]>
>;

function SpikeBlockInput({
  block,
  onChange,
  onCompositionChange,
  onPublicationBlockedChange,
}: {
  block: SpaceBlock;
  onChange: (block: SpaceBlock) => void;
  onCompositionChange: (value: boolean) => void;
  onPublicationBlockedChange: (value: boolean) => void;
}) {
  const [publication] = useState(() => new SpacesNativePublication(block, onChange));
  return (
    <SpacesNativeBlockEditor
      publication={publication}
      onCompositionChange={onCompositionChange}
      onPublicationBlockedChange={onPublicationBlockedChange}
    />
  );
}

// Deliberately unregistered: the feasibility harness owns mounting and draft persistence.
export function SpacesEditorSpike({
  blocks,
  onChange,
}: {
  blocks: readonly SpaceBlock[];
  onChange: (block: SpaceBlock) => void;
}) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [publicationBlocked, setPublicationBlocked] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);
  const list = useRef<FlatList<SpaceBlock>>(null);
  const measuredIds = useRef(new Set<string>());
  const pendingFocus = useRef<{
    id: string;
    index: number;
    attempts: number;
    measuredThrough: number;
    failed: boolean;
  } | null>(null);

  const scrollToFocus = useCallback(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pending.failed = false;
    list.current?.scrollToIndex({ index: pending.index, animated: false, viewPosition: 0 });
    if (!pending.failed) {
      setFocusedId(pending.id);
      if (measuredIds.current.has(pending.id)) pendingFocus.current = null;
    }
  }, []);

  const Cell = useCallback(
    ({ children, item, index, onLayout, onFocusCapture, style }: SpacesCellProps) => (
      <View
        style={style}
        onFocusCapture={onFocusCapture}
        onLayout={(event) => {
          onLayout?.(event);
          measuredIds.current.add(item.id);
          const pending = pendingFocus.current;
          if (!pending) return;
          if (index === pending.index) {
            scrollToFocus();
            pendingFocus.current = null;
          } else if (index > pending.measuredThrough) {
            scrollToFocus();
          }
        }}
      >
        {children}
      </View>
    ),
    [scrollToFocus],
  );

  function focusBlock(index: number) {
    const block = blocks[index];
    if (!block || composing || publicationBlocked) return;
    setFocusError(null);
    pendingFocus.current = {
      id: block.id,
      index,
      attempts: 0,
      measuredThrough: -1,
      failed: false,
    };
    scrollToFocus();
  }

  function moveFocus(direction: number) {
    if (composing || publicationBlocked) return;
    const focusedIndex = blocks.findIndex((block) => block.id === focusedId);
    const start = focusedIndex < 0 && direction < 0 ? blocks.length : focusedIndex;
    for (let index = start + direction; index >= 0 && index < blocks.length; index += direction) {
      const next = blocks[index];
      if (next && nativeDocumentForSpaceBlock(next)) {
        focusBlock(index);
        return;
      }
    }
  }

  return (
    <View className="flex-1">
      <View className="flex-row gap-4 p-3">
        <Pressable
          accessibilityRole="button"
          disabled={composing || publicationBlocked}
          onPress={() => moveFocus(-1)}
        >
          <Text className="text-foreground">Previous block</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={composing || publicationBlocked}
          onPress={() => moveFocus(1)}
        >
          <Text className="text-foreground">Next block</Text>
        </Pressable>
      </View>
      {focusError ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {focusError}
        </Text>
      ) : null}
      <FlatList
        ref={list}
        CellRendererComponent={Cell}
        onScrollToIndexFailed={({ highestMeasuredFrameIndex, averageItemLength }) => {
          const pending = pendingFocus.current;
          if (!pending) return;
          pending.failed = true;
          pending.measuredThrough = highestMeasuredFrameIndex;
          pending.attempts += 1;
          if (pending.attempts > 4) {
            pendingFocus.current = null;
            setFocusError(
              "Could not reach that block. Scroll closer and try Previous or Next again.",
            );
            return;
          }
          list.current?.scrollToOffset({
            offset: averageItemLength * pending.index,
            animated: false,
          });
        }}
        data={blocks}
        keyExtractor={(block) => block.id}
        initialNumToRender={12}
        windowSize={5}
        scrollEnabled={!composing && !publicationBlocked}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        extraData={{ focusedId, composing, publicationBlocked }}
        renderItem={({ item: block, index }) => {
          const document = nativeDocumentForSpaceBlock(block);
          const runs = spaceBlockRuns(block);
          const text = runs ? spacePlainText(runs) : JSON.stringify(block.content);
          return (
            <View className="px-4 py-3">
              {focusedId === block.id && document ? (
                <SpikeBlockInput
                  key={block.id}
                  block={block}
                  onChange={onChange}
                  onCompositionChange={(value) => {
                    if (value) pendingFocus.current = null;
                    setComposing(value);
                  }}
                  onPublicationBlockedChange={(value) => {
                    if (value) pendingFocus.current = null;
                    setPublicationBlocked(value);
                  }}
                />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  disabled={composing || publicationBlocked || !document}
                  onPress={() => focusBlock(index)}
                >
                  <Text selectable className="text-foreground">
                    {text || "Empty block"}
                  </Text>
                </Pressable>
              )}
              {!document ? (
                <View className="flex-row gap-4">
                  <Text className="text-muted-foreground">Edit on desktop</Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => void Clipboard.setStringAsync(JSON.stringify(block.content))}
                  >
                    <Text className="text-foreground">Copy original content</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}
