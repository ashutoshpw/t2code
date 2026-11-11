import type { SpaceDatabaseView, SpaceViewId } from "@t2code/contracts/spaces";
import { ScrollView } from "react-native";

import { Chip } from "../../../components/ui/Chip";

/** The saved views of a database block, one chip each. Selecting one changes nothing on the server. */
export function ViewSwitcher(props: {
  readonly views: ReadonlyArray<SpaceDatabaseView>;
  readonly activeId: SpaceViewId | undefined;
  readonly onSelect: (view: SpaceDatabaseView) => void;
}) {
  if (props.views.length < 2) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-2 px-4 py-1"
      accessibilityRole="tablist"
    >
      {props.views.map((view) => (
        <Chip
          key={view.id}
          label={view.name || "Untitled view"}
          selected={view.id === props.activeId}
          onPress={() => props.onSelect(view)}
        />
      ))}
    </ScrollView>
  );
}
