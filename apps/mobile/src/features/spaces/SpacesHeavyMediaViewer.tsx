import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Modal, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { RenderErrorBoundary } from "../../components/RenderErrorBoundary";
import { PdfPreview } from "../../components/PdfPreview";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { PdfPosition } from "../../lib/pdfPosition";
import { RetainedMediaVideoSource } from "../../lib/mediaVideoSource";
import type { MobileSpaceImageViewer } from "./media";
import type { SpacesReadAccess } from "./reader";

function HeavyDecoder({
  model,
  url,
  name,
  identity,
}: {
  model: MobileSpaceImageViewer;
  url: string;
  name: string;
  identity: string;
}) {
  const [position] = useState(() => new PdfPosition());
  const [renewal, setRenewal] = useState(0);
  const renewPdf = useCallback(async () => {
    const previous = model.getSnapshot().url;
    const refreshed = await model.refresh();
    if (refreshed && refreshed === previous) setRenewal((value) => value + 1);
  }, [model]);
  const pdf = useMemo(
    () => ({
      position,
      hold: model.hold,
      current: () => model.current(),
      retry: () => void renewPdf(),
    }),
    [position, model, renewPdf],
  );
  const [video] = useState(
    () =>
      new RetainedMediaVideoSource({
        current: () => model.current(),
        initialUrl: () => model.url(),
        renew: async (signal) => (await model.refresh(signal)) ?? null,
        hold: model.hold,
      }),
  );
  return (
    <View className="flex-1 gap-3">
      <ControlPill
        variant="pill"
        label="Renew source / retain position"
        onPress={() => {
          if (model.kind === "pdf") void renewPdf();
          else setRenewal((value) => value + 1);
        }}
      />
      {model.kind === "video" ? (
        <ControlPill variant="pill" label="Pause" onPress={() => video.pause()} />
      ) : null}
      {model.kind === "pdf" ? (
        <PdfPreview key={renewal} uri={url} tracking={pdf} />
      ) : (
        <MediaVideoPlayer
          uri={url}
          name={name}
          thumbnailKey={identity}
          expanded
          autoPlay={false}
          retainedSource={video}
          renewalKey={renewal}
        />
      )}
    </View>
  );
}

export function SpacesHeavyMediaViewer({
  model,
  access,
}: {
  model: MobileSpaceImageViewer;
  access: SpacesReadAccess;
}) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  // oxlint-disable-next-line t2code/react-effect-budget -- Abort source work and release the heavy decoder when this reader connection changes or unmounts.
  useEffect(() => {
    if (!access.current()) model.close();
    return () => model.close();
  }, [model, access]);
  if (!state.assetId)
    return state.error ? (
      <Text accessibilityRole="alert" className="px-4 text-destructive">
        {state.error}
      </Text>
    ) : null;
  const current = access.current() && model.current();
  const metadata = state.metadata;
  const identity = JSON.stringify([state.assetId, metadata?.digest]);
  return (
    <Modal visible animationType="none" onRequestClose={model.close}>
      <View className="flex-1 gap-3 bg-background px-4 py-12">
        <Text className="text-base font-bold text-foreground">
          {metadata?.name || `Spaces ${model.kind}`}
        </Text>
        <View className="flex-row flex-wrap gap-3">
          <ControlPill variant="pill" label="Close media" onPress={model.close} />
          <ControlPill
            variant="pill"
            label="Save / share original"
            disabled={state.busy || !current}
            onPress={() => void model.share()}
          />
        </View>
        {current && metadata && state.url ? (
          <RenderErrorBoundary
            resetKeys={[identity]}
            renderFallback={() => (
              <Text className="text-foreground-muted">
                This installed app could not open the media viewer. Close it or save/share the
                original; update the app if it remains unavailable.
              </Text>
            )}
          >
            <HeavyDecoder
              key={identity}
              model={model}
              url={state.url}
              name={metadata.name}
              identity={identity}
            />
          </RenderErrorBoundary>
        ) : (
          <View className="gap-2">
            <Text className="text-foreground-muted">
              {state.busy
                ? "Preparing signed media…"
                : "Source unavailable. Restore access or retry explicitly."}
            </Text>
            <ControlPill
              variant="pill"
              label="Retry signed source"
              disabled={state.busy || !current}
              onPress={() => void model.refresh()}
            />
          </View>
        )}
        {state.error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {state.error}
          </Text>
        ) : null}
        <Text className="text-sm text-foreground-muted">
          {model.kind === "pdf"
            ? "PDF uses a temporary whole-file download, up to 25 MiB and 2,000 pages. Renewal retains the last reported page."
            : "Video uses the native player, up to 50 MiB. Explicit renewal retains seek position and play intent when the player reports them."}
        </Text>
      </View>
    </Modal>
  );
}
