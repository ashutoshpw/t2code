import { SpaceFileItem, type SpaceAssetId, type SpaceCardPreview } from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

export type CoverRef =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "asset"; readonly assetId: SpaceAssetId };

/** The slice of a row a cover reads; `cover` is the server's first image block of the row page. */
export interface CoverRow {
  readonly cells: Readonly<Record<string, unknown>>;
  readonly cover?: { readonly url?: string; readonly assetId?: SpaceAssetId } | undefined;
}

const isFiles = Schema.is(Schema.Array(SpaceFileItem));
const IMAGE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;
const isWebUrl = (url: string) =>
  /^(?:https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i.test(url);

const fromFiles = (value: unknown): CoverRef | null => {
  if (!isFiles(value)) return null;
  const refs = value.flatMap((item): CoverRef[] =>
    "assetId" in item
      ? [{ kind: "asset", assetId: item.assetId }]
      : isWebUrl(item.url)
        ? [{ kind: "url", url: item.url }]
        : [],
  );
  const named = value.findIndex((item) => IMAGE.test("url" in item ? item.url : item.name));
  if (named >= 0) {
    const item = value[named]!;
    if ("assetId" in item) return { kind: "asset", assetId: item.assetId };
    if (isWebUrl(item.url)) return { kind: "url", url: item.url };
  }
  return refs.find((ref) => ref.kind === "url") ?? null;
};

/** `page_cover` is not offered (Spaces pages have no covers) and gives no image, like `none`. */
export function coverOf(row: CoverRow, preview: SpaceCardPreview | undefined): CoverRef | null {
  switch (preview?.kind) {
    case "property":
      return fromFiles(row.cells[preview.propertyId]);
    case "page_content": {
      const cover = row.cover;
      if (cover?.assetId !== undefined) return { kind: "asset", assetId: cover.assetId };
      return cover?.url !== undefined && isWebUrl(cover.url)
        ? { kind: "url", url: cover.url }
        : null;
    }
    default:
      return null;
  }
}
