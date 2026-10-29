import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type {
  BlockContextRecord,
  PageContextRecord,
  SpaceContextSelector,
} from "@t2code/contracts";
import { useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { MobileSpaceReferenceNavigation } from "./references";
import { SpacesReferenceOpen } from "./SpacesReferences";

export function SpaceChatContext({
  entry,
  current,
  onIncludeChildPages,
  onOpen,
}: {
  entry: SpaceContextSelector | PageContextRecord | BlockContextRecord;
  current?: () => boolean;
  onIncludeChildPages?: (include: boolean) => void;
  onOpen: () => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const [model] = useState(
    () =>
      new MobileSpaceReferenceNavigation({
        current: () => navigation.isFocused(),
        open: (target) => {
          onOpen();
          navigation.push("SpacesPage", {
            environmentId: target.environmentId,
            spaceId: target.spaceId,
            pageId: target.pageId,
            ...(target.blockId ? { block: target.blockId } : {}),
          });
        },
      }),
  );
  // oxlint-disable-next-line t2code/react-effect-budget -- Navigation metadata belongs to the selected chip, never to its durable document session.
  useEffect(() => {
    let active = true;
    const release = model.mount();
    model.select(
      {
        environmentId: entry.environmentId,
        target:
          entry.kind === "page"
            ? { kind: "page", pageId: entry.pageId }
            : { kind: "block", blockId: entry.blockId },
      },
      () => active && (current?.() ?? true),
    );
    return () => {
      active = false;
      release();
    };
  }, [model, entry, current]);
  return (
    <View className="gap-3">
      {"snapshot" in entry ? (
        <>
          <Text className="text-foreground-muted">
            Stored snapshot ·{" "}
            {entry.snapshot.truncated ? "shortened to fit capture limits" : "preserved as sent"}.
            Opening current source does not change this snapshot.
          </Text>
          <Text selectable className="text-foreground">
            {entry.snapshot.text}
          </Text>
        </>
      ) : (
        <>
          <Text className="text-foreground-muted">
            Current {entry.kind} content is captured when sent. Child pages are{" "}
            {entry.includeChildPages ? "included within capture limits" : "excluded"}.
          </Text>
          {onIncludeChildPages ? (
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-foreground">Include child pages</Text>
              <Switch
                accessibilityLabel="Include child pages"
                value={entry.includeChildPages}
                onValueChange={onIncludeChildPages}
              />
            </View>
          ) : null}
        </>
      )}
      <SpacesReferenceOpen model={model} environmentId={entry.environmentId} />
      <Text className="text-foreground-muted">
        A block outside the loaded window requires manual First/Next browsing.
      </Text>
    </View>
  );
}
