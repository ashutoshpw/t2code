import { databaseLimits } from "../CorePolicy.ts";

/** Case- and diacritic-insensitive, locale-independent text folding for filter, sort and match. */
export const fold = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();

/** Cuts at a code-point boundary so the result is at most `maxBytes` of UTF-8. */
export function truncateBytes(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let size = 0;
  let end = 0;
  for (const point of text) {
    const next = Buffer.byteLength(point, "utf8");
    if (size + next > maxBytes) break;
    size += next;
    end += point.length;
  }
  return text.slice(0, end);
}

/** `text_key` is the sort and prefix key; `text_full` is set only when the key is a truncation. */
export function textKeys(text: string) {
  const folded = fold(text);
  const key = truncateBytes(folded, databaseLimits.maxSortKeyBytes);
  return { key, full: key.length < folded.length ? folded : null };
}
