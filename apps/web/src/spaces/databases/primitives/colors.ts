import { SPACE_DATABASE_COLORS, type SpaceDatabaseColor } from "@t2code/contracts/spaces";

/** Static class strings so Tailwind sees every one. */
export const OPTION_COLOR_CLASS: Record<SpaceDatabaseColor, string> = {
  default: "bg-foreground/8 text-foreground",
  gray: "bg-zinc-500/18 text-zinc-700 dark:text-zinc-300",
  brown: "bg-amber-900/20 text-amber-900 dark:text-amber-200",
  orange: "bg-orange-500/20 text-orange-800 dark:text-orange-300",
  yellow: "bg-yellow-500/25 text-yellow-800 dark:text-yellow-200",
  green: "bg-green-500/20 text-green-800 dark:text-green-300",
  blue: "bg-blue-500/20 text-blue-800 dark:text-blue-300",
  purple: "bg-purple-500/20 text-purple-800 dark:text-purple-300",
  pink: "bg-pink-500/20 text-pink-800 dark:text-pink-300",
  red: "bg-red-500/20 text-red-800 dark:text-red-300",
};

/** Solid dots for swatches and color previews. */
export const OPTION_DOT_CLASS: Record<SpaceDatabaseColor, string> = {
  default: "bg-foreground/40",
  gray: "bg-zinc-500",
  brown: "bg-amber-800",
  orange: "bg-orange-500",
  yellow: "bg-yellow-500",
  green: "bg-green-500",
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  red: "bg-red-500",
};

export function isDatabaseColor(value: string): value is SpaceDatabaseColor {
  return SPACE_DATABASE_COLORS.some((color) => color === value);
}

/** The next palette color not used yet; wraps once all are taken. */
export function nextOptionColor(used: ReadonlyArray<SpaceDatabaseColor>): SpaceDatabaseColor {
  const palette = SPACE_DATABASE_COLORS.filter((color) => color !== "default");
  const counts = new Map<SpaceDatabaseColor, number>(palette.map((color) => [color, 0]));
  for (const color of used) if (counts.has(color)) counts.set(color, counts.get(color)! + 1);
  const least = Math.min(...counts.values());
  return palette.find((color) => counts.get(color) === least) ?? "gray";
}
