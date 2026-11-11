import {
  SPACE_NUMBER_FORMATS,
  type SpaceCellValue,
  type SpaceKnownDatabaseProperty,
  type SpacePropertyId,
  type SpacePropertyType,
} from "@t2code/contracts/spaces";

const TEXT_LIKE: ReadonlyArray<string> = ["text", "url", "email", "phone"];

/** Text-like to text-like keeps every value; any other change converts or clears some. */
export function typeChangeNeedsConfirmation(from: string, to: string): boolean {
  return !(TEXT_LIKE.includes(from) && TEXT_LIKE.includes(to));
}

/** Types offered when changing an existing property. A relation needs a target, so it is add-only. */
export const CHANGEABLE_TYPES: ReadonlyArray<SpacePropertyType> = [
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "files",
  "created_time",
  "last_edited_time",
  "unique_id",
];

/** The config a type starts with when the server has no default for it. */
export type ConfigObject = { [key: string]: SpaceCellValue };

export function configForType(type: SpacePropertyType): ConfigObject | undefined {
  return type === "number" ? { format: "number" } : undefined;
}

/**
 * The next whole config of a property for `updateProperty`, which replaces everything except
 * options and rejects an `options` key. A key set to undefined is dropped.
 */
export function nextConfig(
  known: SpaceKnownDatabaseProperty,
  patch: Readonly<Record<string, SpaceCellValue | undefined>>,
): ConfigObject {
  const { options: _options, ...rest } = known.config as ConfigObject;
  const next: ConfigObject = {};
  for (const [key, value] of Object.entries({ ...rest, ...patch }))
    if (value !== undefined) next[key] = value;
  return next;
}

/** "Property", then "Property 2", "Property 3" while the name is taken (case-insensitive). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** The column order with a new property placed before another, or last. */
export function orderWithInserted(
  order: ReadonlyArray<SpacePropertyId>,
  id: SpacePropertyId,
  beforeId: SpacePropertyId | null | undefined,
): SpacePropertyId[] {
  const rest = order.filter((entry) => entry !== id);
  const at = beforeId === null || beforeId === undefined ? -1 : rest.indexOf(beforeId);
  if (at < 0) return [...rest, id];
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** The id a reordered list puts this item before, or null at the end. */
export function beforeIdAfterMove(ids: ReadonlyArray<string>, moved: string): string | null {
  const at = ids.indexOf(moved);
  return at < 0 ? null : (ids[at + 1] ?? null);
}

/** The one id whose position differs between two orders of the same ids. */
export function movedId(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): string | null {
  const from = before.findIndex((id, at) => after[at] !== id);
  if (from < 0) return null;
  const candidate = after[from]!;
  const rest = before.filter((id) => id !== candidate);
  const forward = [
    ...rest.slice(0, after.indexOf(candidate)),
    candidate,
    ...rest.slice(after.indexOf(candidate)),
  ];
  if (forward.every((id, at) => after[at] === id)) return candidate;
  return before[from]!;
}

export const NUMBER_FORMATS: ReadonlyArray<string> = [...new Set(SPACE_NUMBER_FORMATS)];

export function numberFormatLabel(format: string): string {
  const text = format.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
