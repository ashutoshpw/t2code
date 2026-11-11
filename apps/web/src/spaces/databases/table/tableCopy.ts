import { type CellTextContext, cellPlainText } from "@t2code/client-runtime/spaces";
import type { SpaceCellValue, SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

/** What Mod+C puts on the clipboard: dates as ISO days so a paste can read them back. */
export function cellCopyText(
  value: SpaceCellValue | undefined,
  known: SpaceKnownDatabaseProperty | null,
  context: CellTextContext,
): string {
  if (value === undefined || value === null || known === null) return "";
  if (known.type === "date" && typeof value === "object" && !Array.isArray(value)) {
    const date = value as { start?: unknown; end?: unknown };
    if (typeof date.start !== "string") return "";
    return typeof date.end === "string" ? `${date.start} → ${date.end}` : date.start;
  }
  if (known.type === "number" && typeof value === "number") return String(value);
  return cellPlainText(value, known, context);
}
