import { useState } from "react";
import type { SpaceSharedDatabaseRow } from "@t2code/contracts";

import { cn } from "~/lib/utils";
import { coverOf } from "~/spaces/databases/primitives/coverSource";
import type { SharedEnv } from "./parts";
import type { ViewModel } from "./viewModel";

const HEIGHT = { small: 80, medium: 128, large: 176 } as const;

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

/** A fixed-height box, so an image arriving never moves the card. Null without a preview. */
export function SharedCover({
  env,
  viewId,
  row,
  model,
}: {
  readonly env: SharedEnv;
  readonly viewId: string;
  readonly row: SpaceSharedDatabaseRow;
  readonly model: ViewModel;
}) {
  if (model.cardPreview === undefined || model.cardPreview.kind === "none") return null;
  const cover = coverOf(row, model.cardPreview);
  const src =
    cover === null
      ? null
      : cover.kind === "url"
        ? cover.url
        : env.assetUrl(cover.assetId, viewId, row.id);
  return (
    <div
      aria-hidden
      data-card-cover=""
      className="relative w-full shrink-0 overflow-hidden border-b bg-muted/40"
      style={{ height: HEIGHT[model.cardSize] }}
    >
      {src === null ? null : <CoverImage key={src} src={src} fit={model.fitImage} />}
    </div>
  );
}
