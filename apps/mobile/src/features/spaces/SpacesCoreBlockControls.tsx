import { useState } from "react";
import { View } from "react-native";
import { SpaceBlockId } from "@t2code/contracts/spaces";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import type { MobileCoreBlockKind } from "./editing";
import type { SpacesPageReader } from "./reader";

const choices: readonly { kind: MobileCoreBlockKind; label: string }[] = [
  { kind: "paragraph", label: "Add paragraph" },
  { kind: "heading1", label: "Add heading 1" },
  { kind: "heading2", label: "Add heading 2" },
  { kind: "heading3", label: "Add heading 3" },
  { kind: "bulleted_item", label: "Add bulleted item" },
  { kind: "numbered_item", label: "Add numbered item" },
  { kind: "todo_item", label: "Add to-do" },
  { kind: "divider", label: "Add divider" },
];

interface CoreBlockProps {
  readonly reader: SpacesPageReader;
  readonly current: () => boolean;
}

export function SpacesCoreBlockControls({ reader, current }: CoreBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = reader.editing.coreAvailability(current);
  const add = async (kind: MobileCoreBlockKind) => {
    setError(null);
    try {
      await reader.editing.insertCore(kind, SpaceBlockId.make(uuidv4()), current);
      setExpanded(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this block");
    }
  };
  return (
    <View className="gap-2">
      <ControlPill
        variant="pill"
        label={expanded ? "Cancel add block" : "Add block at page end"}
        disabled={!expanded && reason !== null}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <View className="flex-row flex-wrap gap-2">
          {choices.map(({ kind, label }) => (
            <ControlPill
              key={kind}
              variant="pill"
              label={label}
              disabled={reason !== null}
              onPress={() => void add(kind)}
            />
          ))}
        </View>
      ) : null}
      <Text className="text-sm text-foreground-muted">
        {reason ?? "New blocks are added to the local draft. Edit text, then use Save."}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function SpacesCoreBlockDelete({
  reader,
  current,
  blockId,
}: CoreBlockProps & {
  readonly blockId: SpaceBlockId;
}) {
  const [error, setError] = useState<string | null>(null);
  const editing = reader.editing;
  if (!editing.canDeleteCoreBlock(blockId)) return null;
  const confirm = () => {
    setError(null);
    let plan: ReturnType<typeof editing.prepareCoreDeletion>;
    try {
      plan = editing.prepareCoreDeletion(blockId, current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare deletion");
      return;
    }
    Dialog.confirm({
      title: plan.ids.length > 1 ? "Delete this list subtree?" : "Delete this block?",
      message: `${plan.label}\nRemove ${plan.ids.length} block${plan.ids.length === 1 ? "" : "s"} from the local draft. Save commits the deletion. Saved content Undo does not restore deleted blocks.`,
      confirmText: "Delete from draft",
      destructive: true,
      onConfirm: async () => {
        try {
          await editing.deleteCore(plan);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not delete this block");
        }
      },
    });
  };
  return (
    <View className="gap-1 px-4 pb-3">
      <ControlPill
        variant="pill"
        label="Delete core block"
        disabled={editing.coreAvailability(current) !== null}
        onPress={confirm}
      />
      {error ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
