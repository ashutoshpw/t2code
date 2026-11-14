export const FEED_PROPERTY_LIMIT = 6;
export const FEED_GAP = 12;
export const FEED_MAX_WIDTH = 720;

const PADDING = 16;
const TITLE = 28;
const PROPERTY_LINES = 44;
const BLOCK = 40;
const BLOCKS_GAP = 8;

/** Cards have one fixed height so the scroller can window them without measuring. */
export function cardHeight(previewBlocks: number): number {
  return (
    PADDING + TITLE + PROPERTY_LINES + previewBlocks * BLOCK + (previewBlocks > 0 ? BLOCKS_GAP : 0)
  );
}

export function feedPlan(rowCount: number, previewBlocks: number) {
  const height = cardHeight(previewBlocks);
  const offsets = Array.from({ length: rowCount }, (_, index) => index * (height + FEED_GAP));
  return { offsets, total: rowCount === 0 ? 0 : (offsets[rowCount - 1] ?? 0) + height, height };
}
