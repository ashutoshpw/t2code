import * as Clipboard from "expo-clipboard";
import { isKnownSpaceBlock, isSafeSpaceLink } from "@t2code/client-runtime/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { SpaceKnownMark, type SpaceBlock, type SpaceRichText } from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View, useColorScheme } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import type { MobileSpaceReference } from "./references";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

const textColors = {
  light: {
    gray: "#787774",
    brown: "#9f6b53",
    orange: "#d9730d",
    yellow: "#b8860b",
    green: "#448361",
    blue: "#337ea9",
    purple: "#9065b0",
    pink: "#c14c8a",
    red: "#d44c47",
  },
  dark: {
    gray: "#9b9b9b",
    brown: "#ba856f",
    orange: "#c77d48",
    yellow: "#ca9849",
    green: "#529e72",
    blue: "#5e87c9",
    purple: "#9d68d3",
    pink: "#d15796",
    red: "#df5452",
  },
} as const;

const decodeMark = Schema.decodeUnknownOption(SpaceKnownMark, { onExcessProperty: "error" });

function RichText(props: {
  runs: SpaceRichText;
  heading?: 1 | 2 | 3;
  target: SpacePageNavigationTarget;
  onOpen: (target: MobileSpaceReference) => void;
}) {
  const palette = textColors[useColorScheme() === "dark" ? "dark" : "light"];
  const runs: { run: SpaceRichText[number]; start: number }[] = [];
  let offset = 0;
  for (const run of props.runs) {
    if (run.text) runs.push({ run, start: offset });
    offset += run.text.length;
  }
  return (
    <Text
      selectable
      accessibilityRole={props.heading ? "header" : undefined}
      className={
        props.heading === 1
          ? "text-2xl font-bold text-foreground"
          : props.heading === 2
            ? "text-xl font-bold text-foreground"
            : props.heading === 3
              ? "text-lg font-bold text-foreground"
              : "text-base text-foreground"
      }
    >
      {runs.map(({ run, start }) => {
        const marks = run.marks.flatMap((mark) => {
          const known = decodeMark(mark);
          return known._tag === "Some" ? [known.value] : [];
        });
        const colorOf = (type: "color" | "highlight") =>
          marks.flatMap((mark) => (mark.type === type && "value" in mark ? [mark.value] : []))[0];
        const color = colorOf("color");
        const highlight = colorOf("highlight");
        const decorations = [
          marks.some((mark) => mark.type === "underline") ? "underline" : null,
          marks.some((mark) => mark.type === "strike") ? "line-through" : null,
        ].filter((value) => value !== null);
        const link = marks.find((mark) => mark.type === "link" && isSafeSpaceLink(mark.href));
        const mention = marks.find(
          (mark) => mark.type === "page_mention" || mark.type === "block_mention",
        );
        return (
          <Text
            key={start}
            accessibilityRole={link || mention ? "link" : undefined}
            style={{
              fontWeight: marks.some((mark) => mark.type === "bold") ? "bold" : undefined,
              fontStyle: marks.some((mark) => mark.type === "italic") ? "italic" : undefined,
              textDecorationLine: decorations.length
                ? (decorations.join(" ") as "underline line-through")
                : undefined,
              color: color ? palette[color] : undefined,
              backgroundColor: highlight ? `${palette[highlight]}38` : undefined,
            }}
            className={marks.some((mark) => mark.type === "code") ? "font-mono" : undefined}
            onPress={
              mention && (mention.type === "page_mention" || mention.type === "block_mention")
                ? () =>
                    props.onOpen({
                      environmentId: mention.target.environmentId,
                      target:
                        mention.type === "block_mention"
                          ? { kind: "block", blockId: mention.target.blockId }
                          : { kind: "page", pageId: mention.target.pageId },
                    })
                : link?.type === "link"
                  ? () => void tryOpenExternalUrl(link.href, "markdown-link")
                  : undefined
            }
          >
            {run.text}
          </Text>
        );
      })}
    </Text>
  );
}

export function SpaceBlockReader(props: {
  block: SpaceBlock;
  target: SpacePageNavigationTarget;
  depth: number;
  selected: boolean;
  onImage: (block: SpaceBlock) => void;
  onOpen: (target: MobileSpaceReference) => void;
}) {
  const { block } = props;
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const known = isKnownSpaceBlock(block);
  async function copy() {
    try {
      await Clipboard.setStringAsync(JSON.stringify(block));
      setCopyStatus("Original block copied.");
    } catch {
      setCopyStatus("Could not copy this block.");
    }
  }
  return (
    <View
      className={
        props.selected ? "gap-2 border-l-2 border-border px-4 py-3 bg-subtle" : "gap-2 px-4 py-3"
      }
      style={{ marginLeft: props.depth * 16 }}
    >
      {!known ? (
        <Text selectable className="text-foreground-muted">
          Unsupported {block.type} block · version {block.version}. Original content retained.
        </Text>
      ) : block.type === "divider" ? (
        <View accessibilityRole="separator" className="border-t border-border" />
      ) : block.type === "code" ? (
        <>
          <Text className="text-sm text-foreground-muted">{block.content.language || "Code"}</Text>
          <Text selectable className="font-mono text-foreground">
            {block.content.text}
          </Text>
        </>
      ) : block.type === "child_page" ? (
        <ControlPill
          variant="pill"
          label="Open child page"
          onPress={() =>
            props.onOpen({
              environmentId: props.target.environmentId,
              target: { kind: "page", pageId: block.content.pageId },
            })
          }
        />
      ) : "runs" in block.content ? (
        <>
          {block.type === "callout" ? (
            <Text className="text-foreground">{block.content.icon}</Text>
          ) : null}
          {block.type === "todo_item" ? (
            <Text className="text-foreground-muted">
              {block.content.checked ? "☑ Completed" : "☐ To do"}
            </Text>
          ) : null}
          {block.type === "bulleted_item" ||
          block.type === "numbered_item" ||
          block.type === "toggle" ||
          block.type === "quote" ? (
            <Text className="text-foreground-muted">
              {block.type === "quote"
                ? "Quote"
                : block.type === "numbered_item"
                  ? "Numbered item"
                  : block.type === "toggle"
                    ? "▸ Toggle"
                    : "•"}
            </Text>
          ) : null}
          <RichText
            runs={block.content.runs}
            heading={block.type === "heading" ? block.content.level : undefined}
            target={props.target}
            onOpen={props.onOpen}
          />
        </>
      ) : "assetId" in block.content ? (
        <>
          <Text selectable className="text-foreground">
            {block.type} · {block.content.assetId}
          </Text>
          {block.type === "image" || block.type === "pdf" || block.type === "video" ? (
            <ControlPill
              variant="pill"
              label={`Open ${block.type}`}
              onPress={() => props.onImage(block)}
            />
          ) : (
            <Text className="text-sm text-foreground-muted">
              PDF and video viewing is not yet available in mobile Spaces.
            </Text>
          )}
          {block.content.caption ? (
            <RichText runs={block.content.caption} target={props.target} onOpen={props.onOpen} />
          ) : null}
        </>
      ) : null}
      <View className="items-start">
        <ControlPill variant="pill" label="Copy original block" onPress={() => void copy()} />
      </View>
      {copyStatus ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {copyStatus}
        </Text>
      ) : null}
    </View>
  );
}
