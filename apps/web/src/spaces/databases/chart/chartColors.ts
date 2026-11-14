import { SPACE_DATABASE_COLORS, type SpaceDatabaseColor } from "@t2code/contracts/spaces";

/** Static class strings so Tailwind sees every one. */
export const CHART_FILL_CLASS: Record<SpaceDatabaseColor, string> = {
  default: "fill-foreground/45",
  gray: "fill-zinc-500 dark:fill-zinc-400",
  brown: "fill-amber-800 dark:fill-amber-600",
  orange: "fill-orange-500 dark:fill-orange-400",
  yellow: "fill-yellow-500 dark:fill-yellow-400",
  green: "fill-green-600 dark:fill-green-500",
  blue: "fill-blue-500 dark:fill-blue-400",
  purple: "fill-purple-500 dark:fill-purple-400",
  pink: "fill-pink-500 dark:fill-pink-400",
  red: "fill-red-500 dark:fill-red-400",
};

export const CHART_STROKE_CLASS: Record<SpaceDatabaseColor, string> = {
  default: "stroke-foreground/45",
  gray: "stroke-zinc-500 dark:stroke-zinc-400",
  brown: "stroke-amber-800 dark:stroke-amber-600",
  orange: "stroke-orange-500 dark:stroke-orange-400",
  yellow: "stroke-yellow-500 dark:stroke-yellow-400",
  green: "stroke-green-600 dark:stroke-green-500",
  blue: "stroke-blue-500 dark:stroke-blue-400",
  purple: "stroke-purple-500 dark:stroke-purple-400",
  pink: "stroke-pink-500 dark:stroke-pink-400",
  red: "stroke-red-500 dark:stroke-red-400",
};

/** Legend dots: the same colours as fills, as backgrounds. */
export const CHART_DOT_CLASS: Record<SpaceDatabaseColor, string> = {
  default: "bg-foreground/45",
  gray: "bg-zinc-500 dark:bg-zinc-400",
  brown: "bg-amber-800 dark:bg-amber-600",
  orange: "bg-orange-500 dark:bg-orange-400",
  yellow: "bg-yellow-500 dark:bg-yellow-400",
  green: "bg-green-600 dark:bg-green-500",
  blue: "bg-blue-500 dark:bg-blue-400",
  purple: "bg-purple-500 dark:bg-purple-400",
  pink: "bg-pink-500 dark:bg-pink-400",
  red: "bg-red-500 dark:bg-red-400",
};

const isColor = (value: string): value is SpaceDatabaseColor =>
  (SPACE_DATABASE_COLORS as ReadonlyArray<string>).includes(value);

/** The colour of a datum: its option colour, else the single-series blue. */
export const seriesColor = (color: string | null): SpaceDatabaseColor =>
  color !== null && isColor(color) ? color : "blue";

const SLICE_CYCLE: ReadonlyArray<SpaceDatabaseColor> = [
  "blue",
  "orange",
  "green",
  "purple",
  "pink",
  "yellow",
  "red",
  "brown",
  "gray",
];

/** A donut needs one colour per slice; slices with no option colour take the cycle by position. */
export const sliceColor = (color: string | null, index: number): SpaceDatabaseColor =>
  color !== null && isColor(color) ? color : (SLICE_CYCLE[index % SLICE_CYCLE.length] ?? "blue");
