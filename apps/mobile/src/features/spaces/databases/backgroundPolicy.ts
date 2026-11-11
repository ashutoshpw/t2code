/** After this long away the rows are asked for again on return. */
export const BACKGROUND_REFRESH_MS = 30_000;

/**
 * What to do when the app comes back to the foreground. `leftAt` is when it stopped being active
 * (null when it never did). Nothing polls in the background; a short absence changes nothing.
 */
export function backgroundPolicy(leftAt: number | null, now: number): "none" | "refresh" {
  return leftAt !== null && now - leftAt >= BACKGROUND_REFRESH_MS ? "refresh" : "none";
}
