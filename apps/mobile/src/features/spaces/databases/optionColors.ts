import type { SpaceDatabaseColor } from "@t2code/contracts/spaces";

export interface OptionColor {
  readonly background: string;
  readonly text: string;
  /** The faint tint of a board column grouped by this option. */
  readonly column: string;
}

const light: Record<SpaceDatabaseColor, OptionColor> = {
  default: { background: "#e3e2e0", text: "#32302c", column: "#f7f7f5" },
  gray: { background: "#e3e2e0", text: "#5f5e5b", column: "#f7f7f5" },
  brown: { background: "#eee0da", text: "#64473a", column: "#f9f5f3" },
  orange: { background: "#fadec9", text: "#8a4b13", column: "#fbf5ef" },
  yellow: { background: "#fdecc8", text: "#7a5a0a", column: "#fbf8ec" },
  green: { background: "#dbeddb", text: "#2b593f", column: "#f2f8f4" },
  blue: { background: "#d3e5ef", text: "#183347", column: "#f2f7fc" },
  purple: { background: "#e8deee", text: "#412454", column: "#f8f4fb" },
  pink: { background: "#f5e0e9", text: "#69314c", column: "#fbf3f7" },
  red: { background: "#ffe2dd", text: "#5d1715", column: "#fcf4f3" },
};

const dark: Record<SpaceDatabaseColor, OptionColor> = {
  default: { background: "#454b4e", text: "#ffffffcf", column: "#252525" },
  gray: { background: "#454b4e", text: "#ffffffcf", column: "#2a2a2a" },
  brown: { background: "#603b2c", text: "#ffffffcf", column: "#2e2622" },
  orange: { background: "#854c1d", text: "#ffffffcf", column: "#33281e" },
  yellow: { background: "#89632a", text: "#ffffffcf", column: "#322d1e" },
  green: { background: "#2b593f", text: "#ffffffcf", column: "#1f2d24" },
  blue: { background: "#28456c", text: "#ffffffcf", column: "#1e2a36" },
  purple: { background: "#492f64", text: "#ffffffcf", column: "#2a2233" },
  pink: { background: "#69314c", text: "#ffffffcf", column: "#33222b" },
  red: { background: "#6e3630", text: "#ffffffcf", column: "#35221f" },
};

const isColor = (value: string): value is SpaceDatabaseColor => Object.hasOwn(light, value);

/** A chip's colors; a color this client does not know renders as the default. */
export function optionColor(color: string | undefined, scheme: "light" | "dark"): OptionColor {
  const palette = scheme === "dark" ? dark : light;
  return palette[color !== undefined && isColor(color) ? color : "default"];
}
