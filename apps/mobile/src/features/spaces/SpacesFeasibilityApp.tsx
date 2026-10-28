import { SpaceBlockId, type SpaceBlock } from "@t2code/contracts/spaces";
import { useState } from "react";
import { Text } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { SpacesEditorSpike } from "./SpacesEditorSpike";

import "../../../global.css";

export function SpacesFeasibilityApp() {
  const [blocks, setBlocks] = useState((): readonly SpaceBlock[] => [
    {
      id: SpaceBlockId.make("feasibility-heading"),
      parentId: null,
      order: "a",
      type: "heading",
      version: 1,
      content: { level: 1, runs: [{ text: "Native Spaces editor", marks: [] }] },
    },
    {
      id: SpaceBlockId.make("feasibility-paragraph"),
      parentId: null,
      order: "b",
      type: "paragraph",
      version: 1,
      content: {
        runs: [
          { text: "Edit text and emoji 👩🏽‍💻 with ", marks: [] },
          {
            text: "combined styles",
            marks: [
              { type: "bold", version: 1 },
              { type: "italic", version: 1 },
              { type: "code", version: 1 },
            ],
          },
          {
            text: " and a link",
            marks: [{ type: "link", version: 1, href: "https://t2.codes" }],
          },
        ],
      },
    },
    {
      id: SpaceBlockId.make("feasibility-todo"),
      parentId: null,
      order: "c",
      type: "todo_item",
      version: 1,
      content: { checked: false, runs: [{ text: "Keep block metadata", marks: [] }] },
    },
    {
      id: SpaceBlockId.make("feasibility-opaque"),
      parentId: null,
      order: "d",
      type: "future_block",
      version: 2,
      content: { text: "Unsupported content stays read-only" },
    },
  ]);

  return (
    <SafeAreaProvider>
      <SafeAreaView className="flex-1 bg-background">
        <Text className="px-4 py-3 text-foreground">
          Spaces feasibility · Edits stay in memory and reset on reload
        </Text>
        <SpacesEditorSpike
          blocks={blocks}
          onChange={(updated) => {
            setBlocks((current) =>
              current.map((block) => (block.id === updated.id ? updated : block)),
            );
          }}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
