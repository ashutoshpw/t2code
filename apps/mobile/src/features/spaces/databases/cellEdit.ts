import {
  buildDateValue,
  nextOptionColor,
  EMPTY_DATE_DRAFT,
  knownProperty,
  numberToText,
  parseLocalizedNumber,
  parseTypedDay,
} from "@t2code/client-runtime/spaces";
import {
  SpaceOptionId,
  type SpaceCellValue,
  type SpaceDatabaseOption,
  type SpaceDatabaseProperty,
  type SpacePropertyId,
  type SpaceSchemaOperation,
} from "@t2code/contracts/spaces";

export const FORMATTED_TEXT_NOTE = "Formatted text · edit on desktop";
export const TIMED_DATE_NOTE = "Date with time · edit on desktop";
export const DESKTOP_ONLY_NOTE = "Edit on desktop";
export const UNSUPPORTED_NOTE = "Unsupported";
export const NUMBER_ERROR = "Enter a number.";
export const DATE_ERROR = "Enter a date as YYYY-MM-DD.";
export const DATE_START_ERROR = "Enter a start date.";

export type TextField = "title" | "text" | "number" | "url" | "email" | "phone";

/** What tapping a property of a row opens, decided from the property and the cell's current value. */
export type CellEditor =
  | {
      readonly kind: "text";
      readonly field: TextField;
      readonly initial: string;
      readonly multiline: boolean;
      /** Number format, for parsing percents. */
      readonly format: string;
    }
  | { readonly kind: "checkbox"; readonly checked: boolean }
  | {
      readonly kind: "choice";
      readonly multiple: boolean;
      readonly options: ReadonlyArray<SpaceDatabaseOption>;
      readonly selected: ReadonlyArray<string>;
    }
  | { readonly kind: "date"; readonly start: string; readonly end: string }
  /** Shown but never edited here; `note` explains where it can be, or is null when it is nowhere. */
  | { readonly kind: "readonly"; readonly note: string | null };

export type CellDraft =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "choice"; readonly selected: ReadonlyArray<string> }
  | { readonly kind: "date"; readonly start: string; readonly end: string };

export type CommitResult =
  | { readonly ok: true; readonly value: SpaceCellValue | null }
  | { readonly ok: false; readonly message: string };

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const readonly = (note: string | null): CellEditor => ({ kind: "readonly", note });

type JsonObject = Exclude<
  SpaceCellValue,
  string | number | boolean | null | ReadonlyArray<unknown>
>;

const isObject = (value: SpaceCellValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of a run with no marks; null for a run with marks or one this client does not know. */
const plainRunText = (run: SpaceCellValue): string | null => {
  if (!isObject(run)) return null;
  const { text, marks } = run;
  if (typeof text !== "string") return null;
  return marks === undefined || (Array.isArray(marks) && marks.length === 0) ? text : null;
};

/** The editor for one property and value. Marks, timed dates and everything else a phone cannot edit stay read-only. */
export function editorFor(
  property: SpaceDatabaseProperty,
  value: SpaceCellValue | undefined,
): CellEditor {
  const known = knownProperty(property);
  if (known === null) return readonly(UNSUPPORTED_NOTE);
  switch (known.type) {
    case "title":
    case "url":
    case "email":
    case "phone":
      return {
        kind: "text",
        field: known.type,
        initial: typeof value === "string" ? value : "",
        multiline: false,
        format: "",
      };
    case "text": {
      if (value === undefined || value === null)
        return { kind: "text", field: "text", initial: "", multiline: true, format: "" };
      const texts = Array.isArray(value) ? value.map(plainRunText) : [null];
      const plain = texts.flatMap((text) => (text === null ? [] : [text]));
      if (plain.length !== texts.length) return readonly(FORMATTED_TEXT_NOTE);
      return { kind: "text", field: "text", initial: plain.join(""), multiline: true, format: "" };
    }
    case "number":
      return {
        kind: "text",
        field: "number",
        initial: typeof value === "number" ? numberToText(value, known.config.format) : "",
        multiline: false,
        format: known.config.format,
      };
    case "checkbox":
      return { kind: "checkbox", checked: value === true };
    case "select":
    case "status":
      return {
        kind: "choice",
        multiple: false,
        options: known.config.options,
        selected: typeof value === "string" ? [value] : [],
      };
    case "multi_select":
      return {
        kind: "choice",
        multiple: true,
        options: known.config.options,
        selected: Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    case "date": {
      if (value === undefined || value === null) return { kind: "date", start: "", end: "" };
      if (!isObject(value)) return readonly(TIMED_DATE_NOTE);
      const { start, end, timeZone } = value;
      // A time of day, or a zone, needs the desktop editor: a day-only field would drop it.
      if (
        typeof start !== "string" ||
        !DAY_ONLY.test(start) ||
        timeZone !== undefined ||
        (end !== undefined && (typeof end !== "string" || !DAY_ONLY.test(end)))
      )
        return readonly(TIMED_DATE_NOTE);
      return { kind: "date", start, end: end ?? "" };
    }
    case "relation":
    case "files":
      return readonly(DESKTOP_ONLY_NOTE);
    default:
      return readonly(null);
  }
}

/** The decimal separator `Intl` reports, else the one `toLocaleString` prints; "." when neither works. */
export function detectDecimalSeparator(
  fromParts: () => string | undefined = () =>
    new Intl.NumberFormat().formatToParts(1.1).find((part) => part.type === "decimal")?.value,
  fromText: () => string = () => (1.1).toLocaleString(),
): string {
  try {
    const found = fromParts();
    if (found) return found;
  } catch {
    // Hermes builds without Intl.NumberFormat.formatToParts land here.
  }
  try {
    const match = /^1(\D)1$/u.exec(fromText());
    if (match?.[1]) return match[1];
  } catch {
    // A broken locale falls through to the neutral default.
  }
  return ".";
}

let deviceSeparator: string | undefined;

/** The device's decimal separator, read on first use so importing this module never calls `Intl`. */
export function deviceDecimalSeparator(): string {
  deviceSeparator ??= detectDecimalSeparator();
  return deviceSeparator;
}

function commitText(
  editor: Extract<CellEditor, { kind: "text" }>,
  text: string,
  decimalSeparator: string,
): CommitResult {
  if (editor.field === "number") {
    const number = parseLocalizedNumber(text, editor.format, decimalSeparator);
    return number === undefined
      ? { ok: false, message: NUMBER_ERROR }
      : { ok: true, value: number };
  }
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  return { ok: true, value: editor.field === "text" ? [{ text: trimmed, marks: [] }] : trimmed };
}

function commitDate(start: string, end: string): CommitResult {
  if (start.trim() === "" && end.trim() === "") return { ok: true, value: null };
  if (start.trim() === "") return { ok: false, message: DATE_START_ERROR };
  const startDate = parseTypedDay(start);
  const endDate = end.trim() === "" ? "" : parseTypedDay(end);
  if (startDate === null || endDate === null) return { ok: false, message: DATE_ERROR };
  return {
    ok: true,
    value: buildDateValue(
      { ...EMPTY_DATE_DRAFT, startDate, endDate, hasEnd: endDate !== "" },
      "UTC",
    ),
  };
}

/** What a typed or chosen draft means as a cell: a value to send, or a message to keep the editor open. */
export function commitValue(
  editor: CellEditor,
  draft: CellDraft,
  decimalSeparator: string = deviceDecimalSeparator(),
): CommitResult {
  if (editor.kind === "text" && draft.kind === "text")
    return commitText(editor, draft.text, decimalSeparator);
  if (editor.kind === "date" && draft.kind === "date") return commitDate(draft.start, draft.end);
  if (editor.kind === "choice" && draft.kind === "choice") {
    const known = new Set<string>(editor.options.map((option) => option.id));
    const chosen = draft.selected.filter((id) => known.has(id));
    if (chosen.length !== draft.selected.length)
      return { ok: false, message: "That option no longer exists." };
    if (chosen.length === 0) return { ok: true, value: null };
    return { ok: true, value: editor.multiple ? chosen : (chosen[0] ?? null) };
  }
  return { ok: false, message: "That value isn't valid." };
}

/** Checkbox cells are true or empty, never false. */
export const commitCheckbox = (checked: boolean): SpaceCellValue | null => (checked ? true : null);

/** The options matching a typed query, and the name a new option would get (null when none fits). */
export function choiceRows(
  options: ReadonlyArray<SpaceDatabaseOption>,
  query: string,
  canCreate: boolean,
): { readonly options: ReadonlyArray<SpaceDatabaseOption>; readonly create: string | null } {
  const name = query.trim();
  const needle = name.toLowerCase();
  const matching =
    needle === ""
      ? options
      : options.filter((option) => option.name.toLowerCase().includes(needle));
  const taken = options.some((option) => option.name.trim().toLowerCase() === needle);
  return { options: matching, create: canCreate && name !== "" && !taken ? name : null };
}

/** The schema operation that adds an option, colored with the next palette color. */
export function newOptionOperation(
  property: {
    readonly id: SpacePropertyId;
    readonly type: string;
    readonly options: ReadonlyArray<SpaceDatabaseOption>;
  },
  name: string,
  newId: () => string,
): { readonly optionId: SpaceOptionId; readonly operation: SpaceSchemaOperation } {
  const optionId = SpaceOptionId.make(newId());
  return {
    optionId,
    operation: {
      op: "addOption",
      propertyId: property.id,
      option: {
        id: optionId,
        name: name.trim(),
        color: nextOptionColor(property.options.map((option) => option.color)),
        ...(property.type === "status" ? { group: "todo" as const } : {}),
      },
    },
  };
}
