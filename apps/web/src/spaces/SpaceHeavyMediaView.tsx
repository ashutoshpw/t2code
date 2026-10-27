import { RegistryContext } from "@effect/atom-react";
import { lazy, Suspense, useContext, useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceAssetMetadata } from "@t2code/contracts/spaces";
import { SpaceHeavyMediaSource } from "@t2code/client-runtime/spaces";
import { useLongLivedAssetUrl } from "../assets/longLivedAssetUrls";
import { useAssetUrlRefresh } from "../assets/assetUrls";
import { Button } from "../components/ui/button";
import { MediaVideoPlayer } from "../components/media/MediaVideoPlayer";
import { spaceImagePreviews } from "./imageRuntime";

const PdfViewer = lazy(() => import("../components/files/PdfViewer"));
export function SpaceHeavyMediaView({
  environmentId,
  metadata,
  kind,
  current,
}: {
  environmentId: EnvironmentId;
  metadata: SpaceAssetMetadata;
  kind: "pdf" | "video";
  current: () => boolean;
}) {
  const registry = useContext(RegistryContext);
  const [admission] = useState(() => spaceImagePreviews(registry).watchHeavy());
  const lease = useSyncExternalStore(admission.subscribe, admission.getSnapshot);
  const [owner] = useState(
    () => new SpaceHeavyMediaSource(() => admission.getSnapshot().active && current()),
  );
  const source = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const resource = { _tag: "spaces-asset" as const, environmentId, assetId: metadata.assetId };
  const enabled = lease.active && owner.current();
  const url = useLongLivedAssetUrl(enabled ? environmentId : null, resource);
  const refresh = useAssetUrlRefresh(enabled ? environmentId : null, enabled ? resource : null);
  const src = source.url ?? (url._tag === "Success" ? url.url : null);
  const retry = () => owner.retry(refresh);
  const bindVideo = (video: HTMLVideoElement) =>
    owner.attach(video, owner.getSnapshot().attempt, video.src);
  return (
    <div className="space-y-2">
      {!lease.active ? (
        <>
          <p role="status">One PDF or video can be open across all views.</p>
          <Button variant="outline" onClick={admission.retry}>
            Retry preview admission
          </Button>
        </>
      ) : src && enabled ? (
        kind === "pdf" ? (
          <div className="flex h-[70vh] min-h-0 flex-col">
            <Suspense fallback={<p role="status">Loading PDF viewer…</p>}>
              <PdfViewer
                key={JSON.stringify([src, source.attempt])}
                src={src}
                title={metadata.name}
                rangeBytes={metadata.byteSize}
                initialPage={owner.getPage}
                onPageChange={owner.rememberPage}
                onRetry={() => {
                  void retry().catch(() => {});
                }}
              />
            </Suspense>
          </div>
        ) : (
          <div
            onTimeUpdate={(event) => {
              if (event.target instanceof HTMLVideoElement)
                owner.remember(event.target, source.attempt);
            }}
            onPlay={(event) => {
              if (event.target instanceof HTMLVideoElement)
                owner.remember(event.target, source.attempt);
            }}
            onPause={(event) => {
              if (event.target instanceof HTMLVideoElement)
                owner.remember(event.target, source.attempt);
            }}
            onSeeked={(event) => {
              if (event.target instanceof HTMLVideoElement)
                owner.remember(event.target, source.attempt);
            }}
            onLoadedMetadata={(event) => {
              if (event.target instanceof HTMLVideoElement && src)
                owner.loaded(event.target, source.attempt, event.target.src);
            }}
          >
            <MediaVideoPlayer
              key={source.attempt}
              bindVideo={bindVideo}
              src={src}
              label={metadata.name}
              revision={metadata.digest}
              preload="metadata"
              onRetry={retry}
            />
          </div>
        )
      ) : (
        <p role="status">
          {url._tag === "Failure" ? "Media URL unavailable" : "Loading media URL…"}
        </p>
      )}
      {source.error || lease.error ? (
        <p role="alert">{String(source.error ?? lease.error)}</p>
      ) : null}
      {lease.active ? (
        <Button
          variant="outline"
          disabled={!enabled || source.busy}
          onClick={() => {
            void retry().catch(() => {});
          }}
        >
          Refresh URL / reopen at retained position
        </Button>
      ) : null}
      {kind === "pdf" ? (
        <p>
          Range preview, up to 2,000 pages. Reopen restores the last page; download remains
          available.
        </p>
      ) : null}
    </div>
  );
}
