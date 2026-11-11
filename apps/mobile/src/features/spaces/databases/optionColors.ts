import type { SpaceDatabaseColor } from "@t2code/contracts/spaces";

export interface OptionColor {
  readonly background: string;
  readonly text: string;
}

const light: Record<SpaceDatabaseColor, OptionColor> = {
  default: { background: "#e3e2e0", text: "#32302c" },
  gray: { background: "#e3e2e0", text: "#5f5e5b" },
  brown: { background: "#eee0da", text: "#64473a" },
  orange: { background: "#fadec9", text: "#8a4b13" },
  yellow: { background: "#fdecc8", text: "#7a5a0a" },
  green: { background: "#dbeddb", text: "#2b593f" },
  blue: { background: "#d3e5ef", text: "#183347" },
  purple: { background: "#e8deee", text: "#412454" },
  pink: { background: "#f5e0e9", text: "#69314c" },
  red: { background: "#ffe2dd", text: "#5d1715" },
};

const dark: Record<SpaceDatabaseColor, OptionColor> = {
  default: { background: "#454b4e", text: "#ffffffcf" },
  gray: { background: "#454b4e", text: "#ffffffcf" },
  brown: { background: "#603b2c", text: "#ffffffcf" },
  orange: { background: "#854c1d", text: "#ffffffcf" },
  yellow: { background: "#89632a", text: "#ffffffcf" },
  green: { background: "#2b593f", text: "#ffffffcf" },
  blue: { background: "#28456c", text: "#ffffffcf" },
  purple: { background: "#492f64", text: "#ffffffcf" },
  pink: { background: "#69314c", text: "#ffffffcf" },
  red: { background: "#6e3630", text: "#ffffffcf" },
};

const isColor = (value: string): value is SpaceDatabaseColor => Object.hasOwn(light, value);

/** A chip's colors; a color this client does not know renders as the default. */
export function optionColor(color: string | undefined, scheme: "light" | "dark"): OptionColor {
  const palette = scheme === "dark" ? dark : light;
  return palette[color !== undefined && isColor(color) ? color : "default"];
}
