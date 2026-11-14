import type * as Schema from "effect/Schema";
import {
  SpaceKnownViewLayout,
  SpacePropertyId,
  SPACE_VIEW_TYPES,
  SPACE_GROUPABLE_TYPES,
  isFormAnswerType,
  type SpaceFormQuestion,
  type SpaceCellValue,
  type SpaceDataSource,
  type SpaceDatabaseProperty,
  type SpaceKnownGroup,
  type SpaceKnownDatabaseView,
  type SpaceViewType,
} from "@t2code/contracts/spaces";

import { knownProperty } from "./schema.ts";

export type ViewLayout = { [key: string]: Schema.Json };

export const VIEW_TYPE_NAMES: Readonly<Record<SpaceViewType, string>> = {
  table: "Table",
  board: "Board",
  list: "List",
  gallery: "Gallery",
  calendar: "Calendar",
  timeline: "Timeline",
  chart: "Chart",
  form: "Form",
  feed: "Feed",
};

/** Views that cannot exist without a date property. */
export const needsDateProperty = (type: SpaceViewType): boolean =>
  type === "calendar" || type === "timeline";

const DATE_RANK: Readonly<Record<string, number>> = {
  date: 0,
  created_time: 1,
  last_edited_time: 2,
};

/** Date-like properties in position order, writable `date` first. */
export function datePropertyCandidates(
  dataSource: SpaceDataSource,
): ReadonlyArray<SpaceDatabaseProperty> {
  return Object.values(dataSource.properties)
    .filter((property) => property.type in DATE_RANK)
    .sort((a, b) => (DATE_RANK[a.type] ?? 0) - (DATE_RANK[b.type] ?? 0) || a.position - b.position);
}

const firstOfType = (dataSource: SpaceDataSource, ...types: ReadonlyArray<string>) =>
  Object.values(dataSource.properties)
    .filter((property) => types.includes(property.type))
    .sort((a, b) => a.position - b.position)
    .map(knownProperty)
    .find((property) => property !== null)?.id;

const FORM_DEFAULT_QUESTIONS = 10;

/** The title first, then live answerable properties in position order, at most ten in all. */
export function defaultFormQuestions(dataSource: SpaceDataSource): SpaceFormQuestion[] {
  const known = Object.values(dataSource.properties)
    .sort((a, b) => a.position - b.position)
    .flatMap((property) => {
      const decoded = knownProperty(property);
      return decoded !== null && isFormAnswerType(decoded.type) ? [decoded] : [];
    });
  const title = known.filter((property) => property.type === "title");
  const rest = known.filter((property) => property.type !== "title");
  return [...title, ...rest]
    .slice(0, FORM_DEFAULT_QUESTIONS)
    .map((property) => ({ propertyId: property.id }));
}

const groupable = new Set<string>(SPACE_GROUPABLE_TYPES);

/** A chart's X axis: the first status or select, else the first other groupable property. */
function defaultChartGroup(dataSource: SpaceDataSource): SpaceKnownGroup | undefined {
  const id =
    firstOfType(dataSource, "status", "select") ??
    Object.values(dataSource.properties)
      .filter((property) => property.type !== "title" && groupable.has(property.type))
      .sort((a, b) => a.position - b.position)
      .map(knownProperty)
      .find((property) => property !== null)?.id;
  return id === undefined ? undefined : { property: id };
}

/** The group a chart converted from `view` uses: its own, else the default X axis. */
export function chartGroupForTypeChange(
  view: SpaceKnownDatabaseView | null,
  dataSource: SpaceDataSource,
): SpaceKnownGroup | undefined {
  return view?.group ?? defaultChartGroup(dataSource);
}

/** View types a server offers: the newer ones need the capability flag. */
export function offeredViewTypes(
  features: { readonly databaseChartFormFeed?: true } | undefined,
): ReadonlyArray<SpaceViewType> {
  return features?.databaseChartFormFeed === true
    ? SPACE_VIEW_TYPES
    : SPACE_VIEW_TYPES.filter((type) => type !== "chart" && type !== "form" && type !== "feed");
}

/** The layout a type needs on its own; `dateId` is the date property of a calendar or timeline. */
const requiredLayout = (type: SpaceViewType, dateId: SpacePropertyId | undefined): ViewLayout =>
  dateId === undefined
    ? {}
    : type === "calendar"
      ? { datePropertyId: dateId }
      : type === "timeline"
        ? { startPropertyId: dateId }
        : {};

/** What a new view of `type` starts with. Pass `dateId` for calendar and timeline. */
export function defaultViewDraft(
  type: SpaceViewType,
  dataSource: SpaceDataSource,
  dateId?: SpacePropertyId,
): { readonly name: string; readonly layout: ViewLayout; readonly group?: SpaceKnownGroup } {
  const boardId = type === "board" ? firstOfType(dataSource, "status", "select") : undefined;
  const group =
    type === "chart"
      ? defaultChartGroup(dataSource)
      : boardId === undefined
        ? undefined
        : { property: boardId };
  return {
    name: VIEW_TYPE_NAMES[type],
    layout: {
      ...(type === "board" ? { colorColumns: true } : {}),
      ...(type === "chart" ? { chartType: "bar" } : {}),
      ...(type === "form" ? { questions: defaultFormQuestions(dataSource) } : {}),
      ...requiredLayout(type, dateId ?? datePropertyCandidates(dataSource)[0]?.id),
    },
    ...(group === undefined ? {} : { group }),
  };
}

const layoutKeys = (type: SpaceViewType): ReadonlyArray<string> =>
  Object.keys(SpaceKnownViewLayout[type].fields);

const isLayout = (value: Schema.Json): value is ViewLayout =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REQUIRED_KEYS = ["datePropertyId", "startPropertyId"];

/**
 * The layout of a view converted to `type`: keys both types know are kept, the required ones are
 * added. A calendar date and a timeline start carry over to each other.
 */
export function layoutForTypeChange(
  type: SpaceViewType,
  dataSource: SpaceDataSource,
  previous: Schema.Json,
  dateId?: SpacePropertyId,
): ViewLayout {
  const old = isLayout(previous) ? previous : {};
  const known = new Set(layoutKeys(type));
  const kept: ViewLayout = Object.fromEntries(
    Object.entries(old).filter(([key]) => known.has(key) && !REQUIRED_KEYS.includes(key)),
  );
  const carried = [old.datePropertyId, old.startPropertyId].find(
    (value): value is string => typeof value === "string" && value in dataSource.properties,
  );
  const id =
    (carried === undefined ? undefined : SpacePropertyId.make(carried)) ??
    dateId ??
    datePropertyCandidates(dataSource)[0]?.id;
  const tint: ViewLayout =
    type === "board" && !("colorColumns" in old) ? { colorColumns: true } : {};
  const added: ViewLayout =
    type === "form" && !("questions" in old)
      ? { questions: defaultFormQuestions(dataSource) }
      : type === "chart" && !("chartType" in old)
        ? { chartType: "bar" }
        : {};
  return { ...kept, ...tint, ...added, ...requiredLayout(type, id) };
}

/** Cells a toolbar "New" adds so the row shows up in a calendar or timeline. */
export function seedCellsForView(
  known: SpaceKnownDatabaseView | null,
  dataSource: SpaceDataSource,
  today: string,
): Record<string, SpaceCellValue> {
  if (known === null) return {};
  const writable = (id: SpacePropertyId | undefined) =>
    id !== undefined && dataSource.properties[id]?.type === "date" ? id : undefined;
  if (known.type === "calendar") {
    const id = writable(known.layout.datePropertyId);
    return id === undefined ? {} : { [id]: { start: today } };
  }
  if (known.type === "timeline") {
    const start = writable(known.layout.startPropertyId);
    const end = writable(known.layout.endPropertyId);
    return {
      ...(start === undefined ? {} : { [start]: { start: today } }),
      ...(end === undefined || end === start ? {} : { [end]: { start: today } }),
    };
  }
  return {};
}

export const isViewType = (value: string): value is SpaceViewType =>
  (SPACE_VIEW_TYPES as ReadonlyArray<string>).includes(value);
