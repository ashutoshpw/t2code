import { RegistryContext } from "@effect/atom-react";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceBlock, SpaceRichText, SpaceAssetMetadata } from "@t2code/contracts/spaces";
import {
  isKnownSpaceBlock,
  canEditSpaceBlock,
  isSafeSpaceLink,
} from "@t2code/client-runtime/spaces";
import { useAssetUrlState, useAssetUrlRefresh } from "../assets/assetUrls";
import { useEnvironment } from "../state/environments";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { spaceImages, spaceImagePreviews } from "./imageRuntime";

function Caption({ runs }: { runs: SpaceRichText }) {
  return (
    <p>
      {runs.map((run, index) => {
        let content: ReactNode = run.text;
        for (const mark of run.marks) {
          if (mark.type === "bold") content = <strong>{content}</strong>;
          else if (mark.type === "italic") content = <em>{content}</em>;
          else if (mark.type === "strike") content = <del>{content}</del>;
          else if (mark.type === "code") content = <code>{content}</code>;
          else if (
            mark.type === "link" &&
            typeof mark.href === "string" &&
            isSafeSpaceLink(mark.href)
          )
            content = (
              <a href={mark.href} target="_blank" rel="noopener noreferrer">
                {content}
              </a>
            );
          else if (mark.type === "page_mention" || mark.type === "block_mention")
            content = <span>{content}</span>;
        }
        // oxlint-disable-next-line react/no-array-index-key -- Canonical caption runs have no identities and render only immutable text.
        return <span key={index}>{content}</span>;
      })}
    </p>
  );
}
function ImagePreview({
  environmentId,
  assetId,
  metadata,
  current,
}: {
  environmentId: EnvironmentId;
  assetId: import("@t2code/contracts/spaces").SpaceAssetId;
  metadata: SpaceAssetMetadata;
  current: () => boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const registry = useContext(RegistryContext);
  const [admission] = useState(() =>
    spaceImagePreviews(registry).watch(
      metadata.imageDimensions!.width * metadata.imageDimensions!.height,
    ),
  );
  const admitted = useSyncExternalStore(admission.subscribe, admission.getSnapshot);
  const resource =
    admitted.active && current() ? { _tag: "spaces-asset" as const, environmentId, assetId } : null;
  const url = useAssetUrlState(environmentId, resource);
  const refresh = useAssetUrlRefresh(environmentId, resource);
  const image =
    url._tag === "Success" && current() ? (
      <img
        src={url.url}
        alt={metadata.name}
        loading="lazy"
        decoding="async"
        width={metadata.imageDimensions?.width}
        height={metadata.imageDimensions?.height}
        className="h-auto max-h-[70vh] max-w-full object-contain"
        onError={() => setError("Image could not load. Refresh its signed URL or use Download.")}
      />
    ) : (
      <p role="status">
        {!admitted.active
          ? "Preview paused at the image limit"
          : url._tag === "Failure"
            ? "Image URL unavailable"
            : "Loading image URL…"}
      </p>
    );
  return (
    <div className="space-y-2">
      {enlarged ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              admission.enlarge(false);
              setEnlarged(false);
            }
          }}
        >
          <DialogPopup>
            <DialogTitle>{metadata.name}</DialogTitle>
            {image}
          </DialogPopup>
        </Dialog>
      ) : (
        image
      )}
      {error ? <p role="alert">{error}</p> : null}
      {admitted.error ? (
        <p role="alert">
          {admitted.error instanceof Error ? admitted.error.message : "Image admission failed"}
        </p>
      ) : null}
      {!admitted.active ? (
        <Button variant="outline" onClick={() => admission.retry()}>
          Retry preview admission
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void refresh()
              .then(() => {
                if (current()) setError(null);
              })
              .catch((e: unknown) =>
                setError(e instanceof Error ? e.message : "Image URL refresh failed"),
              );
          }}
        >
          Refresh image URL
        </Button>
        <Button
          variant="outline"
          disabled={!current() || enlarged || !admitted.active}
          onClick={() => {
            try {
              admission.enlarge(true);
              setEnlarged(true);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Enlarged preview unavailable");
            }
          }}
        >
          Enlarge image
        </Button>
      </div>
    </div>
  );
}
export function SpaceMediaBlock({
  environmentId,
  block,
  current,
}: {
  environmentId: EnvironmentId;
  block: SpaceBlock;
  current: () => boolean;
}) {
  const registry = useContext(RegistryContext),
    images = spaceImages(registry);
  const [source, setSource] = useState<{
    metadata: SpaceAssetMetadata;
    current: () => boolean;
  } | null>(null);
  const [download, setDownload] = useState<{
    url: string;
    assetId: string;
    current: () => boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false),
    lifetime = useRef(0);
  const capability = useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces;
  const supported =
    capability?.version === 2 && capability.features?.assets === true && !!capability.limits.assets;
  const allowed = supported && current();
  const known =
    isKnownSpaceBlock(block) && ["image", "pdf", "video"].includes(block.type) ? block : null;
  const assetId = known && "assetId" in known.content ? known.content.assetId : null;
  const resource = assetId
    ? { _tag: "spaces-asset" as const, environmentId, assetId, disposition: "attachment" as const }
    : null;
  const refreshDownload = useAssetUrlRefresh(
    allowed ? environmentId : null,
    allowed ? resource : null,
  );
  // oxlint-disable-next-line t2code/react-effect-budget -- Source ownership changes invalidate late metadata/download work.
  useEffect(() => {
    return () => {
      lifetime.current++;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each source change invalidates late results even though the lifetime ref is stable.
  }, [assetId, environmentId, allowed]);
  if (!known || !assetId) return <p>Unsupported media (preserved read only)</p>;
  const active =
    source?.metadata.assetId === assetId && source.current() && allowed ? source : null;
  const preview = async () => {
    if (pending.current || !allowed || !current()) return;
    pending.current = true;
    const request = lifetime.current;
    try {
      const result = await images.readMetadata(environmentId, assetId);
      if (request !== lifetime.current || !current() || !result.current()) return;
      if (
        block.type !== "image" ||
        !result.metadata.mimeType.startsWith("image/") ||
        !result.metadata.imageDimensions ||
        result.metadata.byteSize > 10 * 1024 * 1024
      )
        throw new Error("This media has no image preview");
      setSource(result);
      setError(null);
    } catch (e) {
      if (request === lifetime.current && current())
        setError(e instanceof Error ? e.message : "Image unavailable");
    } finally {
      pending.current = false;
    }
  };
  return (
    <section aria-label={`${block.type} block`} className="space-y-2">
      <p>
        {block.type === "image"
          ? "Image"
          : `${block.type.toUpperCase()} preview is not implemented; download is available.`}
      </p>
      {block.type === "image" ? (
        <Button
          variant="outline"
          disabled={!allowed}
          onClick={() => {
            if (active) {
              setSource(null);
            } else {
              void preview();
            }
          }}
        >
          {active ? "Close image" : "Preview image"}
        </Button>
      ) : null}
      {active ? (
        <ImagePreview
          key={JSON.stringify([environmentId, assetId, active.metadata.digest])}
          environmentId={environmentId}
          assetId={assetId}
          metadata={active.metadata}
          current={() => current() && active.current()}
        />
      ) : null}
      {"caption" in known.content && known.content.caption ? (
        canEditSpaceBlock(known) ? (
          <Caption runs={known.content.caption} />
        ) : (
          <p>Unsupported rich caption (preserved read only)</p>
        )
      ) : null}
      <Button
        variant="outline"
        disabled={!allowed}
        onClick={() => {
          if (pending.current) return;
          pending.current = true;
          const request = lifetime.current;
          void images
            .readMetadata(environmentId, assetId)
            .then(async (owner) => {
              if (!owner.current() || !current() || request !== lifetime.current) return;
              const url = await refreshDownload();
              if (request === lifetime.current && current() && owner.current()) {
                setDownload(url ? { url, assetId, current: owner.current } : null);
                setError(url ? null : "Download URL unavailable");
              }
            })
            .catch((e: unknown) => {
              if (request === lifetime.current)
                setError(e instanceof Error ? e.message : "Download failed");
            })
            .finally(() => {
              pending.current = false;
            });
        }}
      >
        Prepare / retry download
      </Button>
      {download && download.assetId === assetId && download.current() && allowed ? (
        <a
          href={download.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => {
            if (!current() || !download.current()) event.preventDefault();
          }}
        >
          Download original
        </a>
      ) : null}
      {!supported ? <p>Assets are not advertised by this environment.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
