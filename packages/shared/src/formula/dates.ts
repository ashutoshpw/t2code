export const MS_SECOND = 1000;
export const MS_MINUTE = 60_000;
export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;
const MAX_INSTANT = 8.64e15;

export const validInstant = (ms: number): boolean =>
  Number.isFinite(ms) && Math.abs(ms) <= MAX_INSTANT;

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0: number): {
  readonly y: number;
  readonly m: number;
  readonly d: number;
} {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeapYear(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;

export interface Fields {
  readonly y: number;
  readonly mo: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
  readonly ms: number;
  /** 1 = Monday .. 7 = Sunday. */
  readonly dow: number;
}

/** Calendar fields of a millisecond count read as UTC wall time. */
export function fieldsOfWallMs(wallMs: number): Fields {
  const days = Math.floor(wallMs / MS_DAY);
  const rem = wallMs - days * MS_DAY;
  const { y, m, d } = civilFromDays(days);
  return {
    y,
    mo: m,
    d,
    h: Math.floor(rem / MS_HOUR),
    mi: Math.floor((rem % MS_HOUR) / MS_MINUTE),
    s: Math.floor((rem % MS_MINUTE) / MS_SECOND),
    ms: rem % MS_SECOND,
    dow: ((((days + 3) % 7) + 7) % 7) + 1,
  };
}

export const wallMsOf = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number =>
  daysFromCivil(y, mo, d) * MS_DAY + h * MS_HOUR + mi * MS_MINUTE + s * MS_SECOND + ms;

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  let made: Intl.DateTimeFormat | null = null;
  try {
    made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    made = null;
  }
  formatters.set(zone, made);
  return made;
}

/** An unknown zone is UTC. */
export function normalizeZone(zone: string | undefined): string {
  if (zone === undefined || zone === "" || zone === "UTC") return "UTC";
  return formatterFor(zone) === null ? "UTC" : zone;
}

const YEAR_ONE = -62_135_596_800_000;

/** Offset from UTC in minutes at an instant. */
export function offsetAt(instant: number, zone: string): number {
  const fmt = zone === "UTC" ? null : formatterFor(zone);
  if (fmt === null) return 0;
  const at = Math.min(Math.max(instant, YEAR_ONE), MAX_INSTANT);
  const parts = fmt.formatToParts(at);
  let y = 1970;
  let mo = 1;
  let d = 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const part of parts) {
    const n = Number(part.value);
    switch (part.type) {
      case "year":
        y = n;
        break;
      case "month":
        mo = n;
        break;
      case "day":
        d = n;
        break;
      case "hour":
        h = n % 24;
        break;
      case "minute":
        mi = n;
        break;
      case "second":
        s = n;
        break;
      default:
        break;
    }
  }
  const local = wallMsOf(y, mo, d, h, mi, s);
  return Math.round((local - Math.floor(at / 1000) * 1000) / MS_MINUTE);
}

/** Wall-clock fields of an instant in a zone. */
export function fieldsAt(instant: number, zone: string): Fields {
  return fieldsOfWallMs(instant + offsetAt(instant, zone) * MS_MINUTE);
}

/**
 * Wall time (as UTC-style milliseconds) to an instant. A time skipped by a
 * forward shift moves forward; a repeated time takes the earlier offset.
 */
export function wallToInstant(wallMs: number, zone: string): number {
  if (zone === "UTC") return wallMs;
  const before = offsetAt(wallMs - MS_DAY, zone);
  const after = offsetAt(wallMs + MS_DAY, zone);
  let best: number | undefined;
  for (const o of before === after ? [before] : [before, after]) {
    const t = wallMs - o * MS_MINUTE;
    if (offsetAt(t, zone) === o && (best === undefined || t < best)) best = t;
  }
  return best ?? wallMs - before * MS_MINUTE;
}

export function isoWeek(y: number, mo: number, d: number): number {
  const days = daysFromCivil(y, mo, d);
  const dow = ((((days + 3) % 7) + 7) % 7) + 1;
  const thursday = days + (4 - dow);
  const ty = civilFromDays(thursday).y;
  return Math.floor((thursday - daysFromCivil(ty, 1, 1)) / 7) + 1;
}

export function addMonthsClamped(
  y: number,
  mo: number,
  d: number,
  n: number,
): { readonly y: number; readonly mo: number; readonly d: number } {
  const total = y * 12 + (mo - 1) + n;
  const ny = Math.floor(total / 12);
  const nmo = total - ny * 12 + 1;
  return { y: ny, mo: nmo, d: Math.min(d, daysInMonth(ny, nmo)) };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number, w: number): string => String(Math.abs(n)).padStart(w, "0");

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const TOKENS = [
  "YYYY",
  "MMMM",
  "dddd",
  "MMM",
  "ddd",
  "YY",
  "MM",
  "DD",
  "Do",
  "HH",
  "hh",
  "mm",
  "ss",
  "ZZ",
  "M",
  "D",
  "d",
  "H",
  "h",
  "m",
  "s",
  "A",
  "a",
  "Z",
] as const;

function tokenText(token: string, f: Fields, offsetMin: number): string {
  const h12 = f.h % 12 === 0 ? 12 : f.h % 12;
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  switch (token) {
    case "YYYY":
      return pad(f.y, 4);
    case "YY":
      return pad(f.y % 100, 2);
    case "MMMM":
      return MONTHS[f.mo - 1] ?? "";
    case "MMM":
      return (MONTHS[f.mo - 1] ?? "").slice(0, 3);
    case "MM":
      return pad(f.mo, 2);
    case "M":
      return String(f.mo);
    case "DD":
      return pad(f.d, 2);
    case "D":
      return String(f.d);
    case "Do":
      return ordinal(f.d);
    case "dddd":
      return WEEKDAYS[f.dow % 7] ?? "";
    case "ddd":
      return (WEEKDAYS[f.dow % 7] ?? "").slice(0, 3);
    case "d":
      return String(f.dow % 7);
    case "HH":
      return pad(f.h, 2);
    case "H":
      return String(f.h);
    case "hh":
      return pad(h12, 2);
    case "h":
      return String(h12);
    case "mm":
      return pad(f.mi, 2);
    case "m":
      return String(f.mi);
    case "ss":
      return pad(f.s, 2);
    case "s":
      return String(f.s);
    case "A":
      return f.h < 12 ? "AM" : "PM";
    case "a":
      return f.h < 12 ? "am" : "pm";
    case "Z":
      return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
    case "ZZ":
      return `${sign}${pad(Math.floor(abs / 60), 2)}${pad(abs % 60, 2)}`;
    default:
      return token;
  }
}

/** Moment-style formatting: tokens, with `[literal]` escapes. */
export function formatFields(f: Fields, offsetMin: number, format: string): string {
  let out = "";
  let i = 0;
  while (i < format.length) {
    const ch = format[i] ?? "";
    if (ch === "[") {
      const close = format.indexOf("]", i + 1);
      if (close !== -1) {
        out += format.slice(i + 1, close);
        i = close + 1;
        continue;
      }
    }
    const token = TOKENS.find((t) => format.startsWith(t, i));
    if (token === undefined) {
      out += ch;
      i += 1;
    } else {
      out += tokenText(token, f, offsetMin);
      i += token.length;
    }
  }
  return out;
}

export interface ParsedDate {
  readonly start: number;
  readonly timed: boolean;
  /** True when the text carried its own offset. */
  readonly absolute: boolean;
}

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function parseDateText(text: string, zone: string): ParsedDate | null {
  const m = DATE_RE.exec(text.trim());
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  if (m[4] === undefined) return { start: wallMsOf(y, mo, d), timed: false, absolute: false };
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number((m[7] + "00").slice(0, 3));
  if (h > 23 || mi > 59 || s > 59) return null;
  const wall = wallMsOf(y, mo, d, h, mi, s, ms);
  const off = m[8];
  if (off === undefined) return { start: wallToInstant(wall, zone), timed: true, absolute: false };
  if (off === "Z") return { start: wall, timed: true, absolute: true };
  const sign = off.startsWith("-") ? -1 : 1;
  const oh = Number(off.slice(1, 3));
  const om = Number(off.slice(4, 6));
  if (oh > 23 || om > 59) return null;
  return { start: wall - sign * (oh * 60 + om) * MS_MINUTE, timed: true, absolute: true };
}
