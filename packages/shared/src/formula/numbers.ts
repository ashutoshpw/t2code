/** Round half away from zero to `places` decimals without binary drift (2.675 -> 2.68). */
export function roundHalfAway(x: number, places: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const text = String(abs);
  if (text.includes("e")) {
    const scale = 10 ** places;
    return (sign * Math.round(abs * scale)) / scale || 0;
  }
  const shifted = Math.round(Number(`${text}e${places}`));
  const back = Number(`${shifted}e${-places}`);
  return sign * back || 0;
}

export const clampPlaces = (n: number): number => Math.min(10, Math.max(0, Math.trunc(n)));

export function medianOf(sorted: ReadonlyArray<number>): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const CURRENCY: Record<string, { readonly symbol: string; readonly decimals: number }> = {
  dollar: { symbol: "$", decimals: 2 },
  euro: { symbol: "€", decimals: 2 },
  pound: { symbol: "£", decimals: 2 },
  yen: { symbol: "¥", decimals: 0 },
  rupee: { symbol: "₹", decimals: 2 },
  won: { symbol: "₩", decimals: 0 },
  yuan: { symbol: "¥", decimals: 2 },
};

export function formatNumber(n: number, format: string, decimalsArg: number | null): string | null {
  const isPlain = format === "number" || format === "commas";
  const currency = CURRENCY[format];
  if (!isPlain && format !== "percent" && currency === undefined) return null;
  const defaultDecimals = currency?.decimals ?? 0;
  const places = decimalsArg === null ? defaultDecimals : clampPlaces(decimalsArg);
  const value = format === "percent" ? n * 100 : n;
  const rounded = roundHalfAway(value, places);
  let body = Math.abs(rounded).toFixed(places);
  if (format !== "number" && !body.includes("e")) {
    const [intPart = "", frac] = body.split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    body = frac === undefined ? grouped : `${grouped}.${frac}`;
  }
  const sign = rounded < 0 ? "-" : "";
  if (format === "percent") return `${sign}${body}%`;
  return `${sign}${currency?.symbol ?? ""}${body}`;
}

const NUMBER_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function parseNumberText(text: string): number | null {
  const cleaned = text.trim().replaceAll(",", "");
  if (!NUMBER_TEXT.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
