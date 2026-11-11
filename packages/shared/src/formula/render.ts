import type { FormulaRef } from "./types.ts";

function decodedLiteral(literal: string): string | undefined {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrites each `prop("...")` literal whose property now has another name.
 * A property whose name is unknown keeps its text; the source is never otherwise touched.
 */
export function renderSource(
  source: string,
  refs: ReadonlyArray<FormulaRef>,
  nameOf: (dataSourceId: string, propertyId: string) => string | undefined,
): string {
  const ordered = refs
    .filter((r) => r.start >= 0 && r.end > r.start && r.end <= source.length)
    .sort((a, b) => b.start - a.start);
  let out = source;
  let limit = source.length;
  for (const ref of ordered) {
    if (ref.end > limit) continue;
    const name = nameOf(ref.dataSourceId, ref.propertyId);
    if (name === undefined) continue;
    if (decodedLiteral(out.slice(ref.start, ref.end)) === name) continue;
    out = out.slice(0, ref.start) + JSON.stringify(name) + out.slice(ref.end);
    limit = ref.start;
  }
  return out;
}
