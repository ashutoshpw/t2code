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

/** Column backgrounds: much lighter than the pill so cards and text stay readable. */
export const OPTION_COLUMN_CLASS: Record<SpaceDatabaseColor, string> = {
  default: "bg-foreground/3",
  gray: "bg-zinc-500/6 dark:bg-zinc-400/8",
  brown: "bg-amber-900/6 dark:bg-amber-700/10",
  orange: "bg-orange-500/7 dark:bg-orange-500/10",
  yellow: "bg-yellow-500/8 dark:bg-yellow-500/10",
  green: "bg-green-500/7 dark:bg-green-500/10",
  blue: "bg-blue-500/7 dark:bg-blue-500/10",
  purple: "bg-purple-500/7 dark:bg-purple-500/10",
  pink: "bg-pink-500/7 dark:bg-pink-500/10",
  red: "bg-red-500/7 dark:bg-red-500/10",
};

/** Count, add buttons and "New page" inside a tinted column. */
export const OPTION_COLUMN_TEXT_CLASS: Record<SpaceDatabaseColor, string> = {
  default: "text-muted-foreground",
  gray: "text-zinc-600 dark:text-zinc-400",
  brown: "text-amber-800/80 dark:text-amber-300/80",
  orange: "text-orange-700/80 dark:text-orange-300/80",
  yellow: "text-yellow-700/90 dark:text-yellow-300/80",
  green: "text-green-700/80 dark:text-green-300/80",
  blue: "text-blue-700/80 dark:text-blue-300/80",
  purple: "text-purple-700/80 dark:text-purple-300/80",
  pink: "text-pink-700/80 dark:text-pink-300/80",
  red: "text-red-700/80 dark:text-red-300/80",
};

export function isDatabaseColor(value: string): value is SpaceDatabaseColor {
  return SPACE_DATABASE_COLORS.some((color) => color === value);
}
