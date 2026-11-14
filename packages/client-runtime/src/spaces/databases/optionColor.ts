import { SPACE_DATABASE_COLORS, type SpaceDatabaseColor } from "@t2code/contracts/spaces";

/** The next palette color not used yet; wraps once all are taken. */
export function nextOptionColor(used: ReadonlyArray<SpaceDatabaseColor>): SpaceDatabaseColor {
  const palette = SPACE_DATABASE_COLORS.filter((color) => color !== "default");
  const counts = new Map<SpaceDatabaseColor, number>(palette.map((color) => [color, 0]));
  for (const color of used) if (counts.has(color)) counts.set(color, counts.get(color)! + 1);
  const least = Math.min(...counts.values());
  return palette.find((color) => counts.get(color) === least) ?? "gray";
}
