import type * as Schema from "effect/Schema";
import {
  SpaceKnownViewLayout,
  SpacePropertyId,
  SPACE_VIEW_TYPES,
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
  const groupId = type === "board" ? firstOfType(dataSource, "status", "select") : undefined;
  return {
    name: VIEW_TYPE_NAMES[type],
    layout: requiredLayout(type, dateId ?? datePropertyCandidates(dataSource)[0]?.id),
    ...(groupId === undefined ? {} : { group: { property: groupId } }),
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
  return { ...kept, ...requiredLayout(type, id) };
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
