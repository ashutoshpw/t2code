import { useState } from "react";
import type { EnvironmentId } from "@t2code/contracts";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import type { CoverRef } from "./coverSource";

function CoverImage({ src, fit }: { readonly src: string; readonly fit: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      className={cn("absolute inset-0 size-full", fit ? "object-contain" : "object-cover")}
      onError={() => setFailed(true)}
    />
  );
}

function AssetCoverImage({
  environmentId,
  assetId,
  fit,
}: {
  readonly environmentId: EnvironmentId;
  readonly assetId: Extract<CoverRef, { kind: "asset" }>["assetId"];
  readonly fit: boolean;
}) {
  const url = useAssetUrlState(environmentId, { _tag: "spaces-asset", environmentId, assetId });
  return url._tag === "Success" ? <CoverImage key={url.url} src={url.url} fit={fit} /> : null;
}

/** A fixed-height cover box, so the image arriving never moves the card. */
export function CardCover({
  cover,
  fit,
  height,
  environmentId,
}: {
  readonly cover: CoverRef | null;
  readonly fit: boolean;
  readonly height: number;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <div
      aria-hidden
      data-card-cover=""
      className="relative w-full shrink-0 overflow-hidden border-b bg-muted/40"
      style={{ height }}
    >
      {cover === null ? null : cover.kind === "url" ? (
        <CoverImage key={cover.url} src={cover.url} fit={fit} />
      ) : (
        <AssetCoverImage environmentId={environmentId} assetId={cover.assetId} fit={fit} />
      )}
    </div>
  );
}
