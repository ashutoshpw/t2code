import { useEffect, useSyncExternalStore } from "react";
import { Image, Modal, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import type { MobileSpaceImageViewer } from "./media";
import type { SpacesReadAccess } from "./reader";

export function SpacesImageViewer({
  model,
  access,
}: {
  model: MobileSpaceImageViewer;
  access: SpacesReadAccess;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  // oxlint-disable-next-line t2code/react-effect-budget -- Release the decoder and abort metadata/download work when this source connection or mounted reader changes.
  useEffect(() => {
    if (!access.current()) model.close();
    return () => model.close();
  }, [model, access]);
  const url = access.current() ? model.url() : null;
  if (!state.assetId)
    return state.error ? (
      <Text accessibilityRole="alert" className="px-4 text-destructive">
        {state.error}
      </Text>
    ) : null;
  return (
    <Modal visible animationType="none" onRequestClose={model.close}>
      <View className="flex-1 gap-3 bg-background px-4 py-12">
        <Text className="text-base font-bold text-foreground">
          {state.metadata?.name || "Spaces image"}
        </Text>
        <View className="flex-row flex-wrap gap-3">
          <ControlPill variant="pill" label="Close image" onPress={model.close} />
          <ControlPill
            variant="pill"
            label="Refresh image URL"
            disabled={state.busy || !model.current()}
            onPress={() => void model.refresh()}
          />
          <ControlPill
            variant="pill"
            label="Save / share original"
            disabled={state.busy || !model.current()}
            onPress={() => void model.share()}
          />
        </View>
        {url ? (
          <Image
            key={url}
            accessibilityLabel={state.metadata?.name || "Spaces image"}
            source={{ uri: url, cache: "reload" }}
            style={{ flex: 1 }}
            resizeMode="contain"
            onError={() => model.failed(url)}
          />
        ) : (
          <Text className="text-foreground-muted">
            {state.busy
              ? "Preparing signed image…"
              : model.current()
                ? "Refresh the signed URL to retry or reopen an expired source."
                : "Image access or source changed. Close and reopen it from the current page."}
          </Text>
        )}
        {state.error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {state.error}
          </Text>
        ) : null}
      </View>
    </Modal>
  );
}
