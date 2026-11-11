import { knownComputedValue } from "@t2code/client-runtime/spaces";
import type {
  SpaceAggregateResult,
  SpaceCellValue,
  SpaceDatabaseColor,
  SpaceDateValue,
  SpaceKnownDatabaseProperty,
  SpaceNumberFormat,
  SpaceRelatedPage,
} from "@t2code/contracts/spaces";

const CURRENCY: Partial<Record<SpaceNumberFormat, string>> = {
  dollar: "USD",
  euro: "EUR",
  pound: "GBP",
  yen: "JPY",
  ruble: "RUB",
  rupee: "INR",
  won: "KRW",
  yuan: "CNY",
  real: "BRL",
  lira: "TRY",
  rupiah: "IDR",
  franc: "CHF",
  hong_kong_dollar: "HKD",
  new_zealand_dollar: "NZD",
  krona: "SEK",
  norwegian_krone: "NOK",
  mexican_peso: "MXN",
  rand: "ZAR",
  new_taiwan_dollar: "TWD",
  danish_krone: "DKK",
  zloty: "PLN",
  baht: "THB",
  forint: "HUF",
  koruna: "CZK",
  shekel: "ILS",
  chilean_peso: "CLP",
  philippine_peso: "PHP",
  dirham: "AED",
  colombian_peso: "COP",
  riyal: "SAR",
  ringgit: "MYR",
  leu: "RON",
  argentine_peso: "ARS",
  uruguayan_peso: "UYU",
  singapore_dollar: "SGD",
  australian_dollar: "AUD",
  canadian_dollar: "CAD",
};

export interface NumberConfig {
  readonly format: SpaceNumberFormat;
  readonly decimals?: number | undefined;
}

export function formatNumber(value: number, config: NumberConfig): string {
  const digits =
    config.decimals === undefined
      ? { maximumFractionDigits: 10 }
      : { minimumFractionDigits: config.decimals, maximumFractionDigits: config.decimals };
  const currency = CURRENCY[config.format];
  if (currency)
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      ...(config.decimals === undefined ? {} : digits),
    }).format(value);
  if (config.format === "percent")
    return new Intl.NumberFormat("en-US", { style: "percent", ...digits }).format(value);
  return new Intl.NumberFormat("en-US", {
    useGrouping: config.format === "number_with_commas",
    ...digits,
  }).format(value);
}

export interface DateConfig {
  readonly dateFormat?: "full" | "short" | "mdy" | "dmy" | "ymd" | "relative" | undefined;
  readonly timeFormat?: "12h" | "24h" | "hidden" | undefined;
}

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number | null;
  readonly minute: number;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;
const hasOffset = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.slice(10));

/** Date-only strings and wall times are zone-less; an instant is shown in `timeZone`. */
function partsOf(value: string, timeZone: string): Parts | null {
  if (hasOffset(value)) {
    const time = Date.parse(value);
    if (Number.isNaN(time)) return null;
    const read = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(time);
    const part = (type: string) => Number(read.find((entry) => entry.type === type)?.value);
    return {
      year: part("year"),
      month: part("month"),
      day: part("day"),
      hour: part("hour"),
      minute: part("minute"),
    };
  }
  const match = WALL.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: match[4] === undefined ? null : Number(match[4]),
    minute: Number(match[5] ?? 0),
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

function renderDate(parts: Parts, config: DateConfig, today: Parts | null): string {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day);
  let date: string;
  switch (config.dateFormat) {
    case "mdy":
      date = `${pad(parts.month)}/${pad(parts.day)}/${parts.year}`;
      break;
    case "dmy":
      date = `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
      break;
    case "ymd":
      date = `${parts.year}/${pad(parts.month)}/${pad(parts.day)}`;
      break;
    case "relative": {
      const base = today ?? parts;
      const diff = Math.round((utc - Date.UTC(base.year, base.month - 1, base.day)) / 86_400_000);
      date = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(diff, "day");
      date = date.charAt(0).toUpperCase() + date.slice(1);
      break;
    }
    case "short":
      date = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(utc);
      break;
    default:
      date = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(utc);
  }
  if (parts.hour === null || config.timeFormat === "hidden") return date;
  if (config.timeFormat === "24h") return `${date} ${pad(parts.hour)}:${pad(parts.minute)}`;
  const hour = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${date} ${hour}:${pad(parts.minute)} ${parts.hour < 12 ? "AM" : "PM"}`;
}

function todayIn(timeZone: string): Parts {
  return partsOf(new Date(Date.now()).toISOString(), timeZone)!;
}

export function formatDate(value: SpaceDateValue, config: DateConfig, timeZone: string): string {
  const zone = value.timeZone ?? timeZone;
  const today = config.dateFormat === "relative" ? todayIn(timeZone) : null;
  const start = partsOf(value.start, zone);
  if (start === null) return value.start;
  const first = renderDate(start, config, today);
  const end = value.end === undefined ? null : partsOf(value.end, zone);
  return end === null ? first : `${first} → ${renderDate(end, config, today)}`;
}

export function formatTimestamp(iso: string, config: DateConfig, timeZone: string): string {
  const parts = partsOf(iso, timeZone);
  return parts === null
    ? iso
    : renderDate(parts, { ...config, dateFormat: config.dateFormat }, null);
}

export function formatUniqueId(value: { readonly number: number; readonly prefix?: string }) {
  return value.prefix ? `${value.prefix}-${value.number}` : String(value.number);
}

const PERCENT_AGGREGATES = new Set([
  "percent_empty",
  "percent_not_empty",
  "percent_checked",
  "percent_unchecked",
]);

function days(ms: number): string {
  const count = Math.round(ms / 86_400_000);
  return `${count} ${count === 1 ? "day" : "days"}`;
}

export function formatAggregate(
  result: SpaceAggregateResult,
  known: SpaceKnownDatabaseProperty | null,
  timeZone = "UTC",
): string {
  if (result.date !== undefined) return formatDate({ start: result.date.start }, {}, timeZone);
  if (result.number === undefined) return "";
  if (PERCENT_AGGREGATES.has(result.function)) return `${Math.round(result.number * 100)}%`;
  if (result.function === "date_range") return days(result.number);
  const numeric =
    known?.type === "number"
      ? known.config
      : known?.type === "formula" || known?.type === "rollup"
        ? computedNumberConfig(known)
        : undefined;
  if (
    numeric !== undefined &&
    ![
      "count",
      "count_values",
      "count_unique",
      "empty",
      "not_empty",
      "checked",
      "unchecked",
    ].includes(result.function)
  )
    return formatNumber(result.number, numeric);
  return new Intl.NumberFormat("en-US").format(result.number);
}

export interface CellTextContext {
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
  readonly optionHint: (
    propertyId: string,
    optionId: string,
  ) => { readonly name: string; readonly color: SpaceDatabaseColor | string } | undefined;
  readonly timeZone: string;
}

export function optionLabel(
  known: Extract<SpaceKnownDatabaseProperty, { type: "select" | "multi_select" | "status" }>,
  optionId: string,
  hint: CellTextContext["optionHint"],
): string | undefined {
  return (
    known.config.options.find((option) => option.id === optionId)?.name ??
    hint(known.id, optionId)?.name
  );
}

/** What a cell reads as in a clipboard or a screen reader; empty when it has no value. */
export function cellPlainText(
  value: SpaceCellValue | undefined,
  known: SpaceKnownDatabaseProperty | null,
  context: CellTextContext,
): string {
  if (value === undefined || value === null || known === null) return "";
  switch (known.type) {
    case "title":
    case "url":
    case "email":
    case "phone":
      return typeof value === "string" ? value : "";
    case "text":
      return Array.isArray(value)
        ? value
            .map((run) =>
              typeof run === "object" && run !== null && "text" in run ? String(run.text) : "",
            )
            .join("")
        : "";
    case "number":
      return typeof value === "number" ? formatNumber(value, known.config) : "";
    case "checkbox":
      return value === true ? "Checked" : "";
    case "select":
    case "status":
      return typeof value === "string" ? (optionLabel(known, value, context.optionHint) ?? "") : "";
    case "multi_select":
      return Array.isArray(value)
        ? value
            .flatMap((id) =>
              typeof id === "string" ? [optionLabel(known, id, context.optionHint)] : [],
            )
            .filter((name): name is string => name !== undefined)
            .join(", ")
        : "";
    case "date":
      return typeof value === "object" && !Array.isArray(value) && "start" in value
        ? formatDate(value as unknown as SpaceDateValue, known.config, context.timeZone)
        : "";
    case "created_time":
    case "last_edited_time":
      return typeof value === "string"
        ? formatTimestamp(value, known.config, context.timeZone)
        : "";
    case "files":
      return Array.isArray(value)
        ? value
            .map((item) =>
              typeof item === "object" && item !== null && "name" in item ? String(item.name) : "",
            )
            .join(", ")
        : "";
    case "relation":
      return Array.isArray(value)
        ? value
            .map((id) => (typeof id === "string" ? (context.relatedPages[id]?.title ?? "") : ""))
            .filter((title) => title !== "")
            .join(", ")
        : "";
    case "unique_id":
      return typeof value === "object" && !Array.isArray(value) && "number" in value
        ? formatUniqueId(value as { number: number; prefix?: string })
        : "";
    case "formula":
    case "rollup":
      return computedText(value, known, context);
  }
}

type ComputedKnown = Extract<SpaceKnownDatabaseProperty, { type: "formula" | "rollup" }>;

const isPercentRollup = (known: ComputedKnown) =>
  known.type === "rollup" && known.config.function.startsWith("percent_");

/** The number display of a computed property: its own format, else percent for percent rollups. */
export function computedNumberConfig(known: ComputedKnown): {
  readonly format: SpaceNumberFormat;
  readonly decimals?: number | undefined;
} {
  return {
    format: known.config.format ?? (isPercentRollup(known) ? "percent" : "number"),
    decimals: known.config.decimals,
  };
}

/** A computed value as plain text, for copy and screen readers. Empty when it has no value. */
function computedText(
  value: SpaceCellValue | undefined,
  known: ComputedKnown,
  context: CellTextContext,
): string {
  const parsed = knownComputedValue(value);
  if (parsed === undefined) return "";
  switch (parsed.type) {
    case "string":
      return parsed.value;
    case "number":
      return formatNumber(parsed.value, computedNumberConfig(known));
    case "boolean":
      return parsed.value ? "Checked" : "";
    case "date":
      return formatDate(parsed.value, {}, context.timeZone);
    case "page":
      return context.relatedPages[parsed.value]?.title || "Untitled";
    case "array": {
      const items = parsed.value
        .map((item) => computedText(item, known, context))
        .filter((text) => text !== "");
      return items.join(", ") + (parsed.truncated === true ? ", …" : "");
    }
  }
}
