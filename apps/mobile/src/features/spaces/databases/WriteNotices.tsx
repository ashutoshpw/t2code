import type { EnvironmentId } from "@t2code/contracts";
import { useSyncExternalStore } from "react";
import { View } from "react-native";

import { ControlPill } from "../../../components/ui/ControlPill";
import { Notice } from "../../../components/ui/Notice";
import { databaseWriter, writeFailures } from "../../../state/spacesDatabases";

export const UNSAVED_WARNING = "Changes that are not saved are lost if you close the app.";

export const unsavedMessage = (count: number): string =>
  `${count} ${count === 1 ? "change" : "changes"} not saved`;

/** Refused values, and edits that could not be sent: each with what the person can do about it. */
export function WriteNotices(props: { readonly environmentId: EnvironmentId }) {
  const writer = databaseWriter(props.environmentId);
  const { failed } = useSyncExternalStore(writer.subscribe, writer.getSnapshot);
  const refused = useSyncExternalStore(writeFailures.subscribe, writeFailures.getSnapshot);
  if (failed === 0 && refused.length === 0) return null;
  return (
    <View className="gap-2 pb-2">
      {refused.map((entry) => (
        <Notice
          key={entry.id}
          tone="danger"
          icon="exclamationmark.triangle"
          message={entry.message}
          onDismiss={() => writeFailures.dismiss(entry.id)}
        />
      ))}
      {failed > 0 ? (
        <View className="gap-2">
          <Notice
            tone="danger"
            icon="exclamationmark.triangle"
            message={`${unsavedMessage(failed)}. ${UNSAVED_WARNING}`}
          />
          <View className="flex-row gap-2">
            <ControlPill variant="pill" label="Retry" onPress={() => writer.retry()} />
            <ControlPill variant="pill" label="Discard" onPress={() => writer.discardFailed()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
