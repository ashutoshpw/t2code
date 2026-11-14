import { SPACE_FEED_WINDOW_ROWS, type SpaceDatabaseView } from "@t2code/contracts/spaces";

const DEFAULT_PREVIEW_BLOCKS = 3;

/** Body blocks shown per feed card: 0, 1, 3, 5 or 10. */
export function feedPreviewBlocks(view: SpaceDatabaseView): number {
  const value: unknown = (view.layout as { previewBlocks?: unknown }).previewBlocks;
  return value === 0 || value === 1 || value === 3 || value === 5 || value === 10
    ? value
    : DEFAULT_PREVIEW_BLOCKS;
}

/** Rows per feed window: the load limit, never past the server's preview window or the query cap. */
export function feedWindowLimit(view: SpaceDatabaseView, maxQueryRows: number): number {
  const loadLimit: unknown = (view.layout as { loadLimit?: unknown }).loadLimit;
  const chosen =
    loadLimit === 10 || loadLimit === 25 || loadLimit === 50 || loadLimit === 100
      ? loadLimit
      : SPACE_FEED_WINDOW_ROWS;
  return Math.min(chosen, SPACE_FEED_WINDOW_ROWS, maxQueryRows);
}
