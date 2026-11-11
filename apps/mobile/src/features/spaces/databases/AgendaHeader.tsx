import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { monthLabel } from "./agenda";

/** Month stepping for the calendar and timeline agenda. */
export function AgendaHeader(props: {
  readonly month: string;
  readonly onStep: (direction: -1 | 1) => void;
  readonly onToday: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-2 px-4 py-2">
      <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
        {monthLabel(props.month)}
      </Text>
      <View className="flex-row gap-2">
        <ControlPill variant="pill" label="Previous" onPress={() => props.onStep(-1)} />
        <ControlPill variant="pill" label="Today" onPress={props.onToday} />
        <ControlPill variant="pill" label="Next" onPress={() => props.onStep(1)} />
      </View>
    </View>
  );
}
