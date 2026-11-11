import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSource, SpaceDatabaseView } from "@t2code/contracts/spaces";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { Sheet } from "../../../components/ui/Sheet";
import { appAtomRegistry } from "../../../state/atom-registry";
import { spacesWritable } from "../../../state/spaces";
import { databaseMutations, databaseWriter, viewerZone } from "../../../state/spacesDatabases";
import { addRow } from "./addRow";

/** One title input; the row is made from the active view so it shows up in that view. */
export function NewRowSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly view: SpaceDatabaseView | undefined;
  readonly dataSource: SpaceDataSource;
  readonly onCreated: () => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await addRow({
      environmentId: props.environmentId,
      registry: appAtomRegistry,
      mutations: databaseMutations,
      writer: databaseWriter(props.environmentId),
      canWrite: () => spacesWritable(props.environmentId),
      view: props.view,
      dataSource: props.dataSource,
      title,
      now: Date.now(),
      zone: viewerZone(),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    props.onCreated();
    props.onClose();
  };
  return (
    <Sheet title="New row" onClose={props.onClose} dismissDisabled={busy}>
      <ScrollView
        className="flex-1 bg-sheet-solid"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          accessibilityLabel="Title"
          placeholder="Title"
          value={title}
          onChangeText={setTitle}
          editable={!busy}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
        />
        {error === null ? null : (
          <Text accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
            {error}
          </Text>
        )}
        <View className="flex-row">
          <ControlPill
            variant="primary"
            label="Add row"
            disabled={busy}
            onPress={() => void submit()}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}
