import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { EnvironmentId } from "@t2code/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { type SpacesReadAccess, spacesAvailabilityMessage } from "./reader";

export function Notice({ children }: { children: string }) {
  return (
    <Text accessibilityLiveRegion="polite" className="px-4 py-3 text-base text-foreground-muted">
      {children}
    </Text>
  );
}

export function AccessNotice({
  access,
  environmentId,
}: {
  access: SpacesReadAccess;
  environmentId: EnvironmentId;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  return (
    <View className="gap-3 p-4">
      <Notice>{spacesAvailabilityMessage[access.availability]}</Notice>
      <ControlPill
        variant="pill"
        label="Environment settings"
        onPress={() => navigation.navigate("SettingsEnvironmentDetail", { environmentId })}
      />
    </View>
  );
}
