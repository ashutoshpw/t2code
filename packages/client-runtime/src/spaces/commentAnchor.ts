import { SPACE_COMMENT_LIMITS, type SpaceCommentAnchor } from "@t2code/contracts/spaces";

export type SpaceCommentPlacement =
  | { readonly kind: "block" }
  | { readonly kind: "range"; readonly start: number; readonly end: number };

type RangeAnchor = Extract<SpaceCommentAnchor, { kind: "range" }>;

/** Offsets are UTF-16 offsets into the block's plain text. Null for an empty selection. */
export function captureSpaceCommentRange(
  text: string,
  start: number,
  end: number,
): RangeAnchor | null {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.min(text.length, from + SPACE_COMMENT_LIMITS.maxQuoteChars, Math.max(end, 0));
  if (from >= to) return null;
  const context = SPACE_COMMENT_LIMITS.maxContextChars;
  return {
    kind: "range",
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - context), from),
    suffix: text.slice(to, to + context),
    start: from,
    end: to,
  };
}

const commonSuffix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonPrefix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/** Finds where a comment's anchor sits in the block's current text; falls back to the whole block. */
export function anchorSpaceComment(
  text: string,
  anchor: SpaceCommentAnchor,
): SpaceCommentPlacement {
  if (anchor.kind === "block") return { kind: "block" };
  const { quote, prefix, suffix, start, end } = anchor;
  if (
    text.slice(start, end) === quote &&
    text.slice(Math.max(0, start - prefix.length), start) === prefix &&
    text.slice(end, end + suffix.length) === suffix
  )
    return { kind: "range", start, end };
  let best: { readonly at: number; readonly score: number; readonly distance: number } | null =
    null;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const score =
      commonSuffix(prefix, text.slice(Math.max(0, at - prefix.length), at)) +
      commonPrefix(suffix, text.slice(at + quote.length, at + quote.length + suffix.length));
    const distance = Math.abs(at - start);
    if (best === null || score > best.score || (score === best.score && distance < best.distance))
      best = { at, score, distance };
  }
  return best === null
    ? { kind: "block" }
    : { kind: "range", start: best.at, end: best.at + quote.length };
}
