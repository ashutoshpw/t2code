import { propertyQueryType } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseProperty, SpaceDataSource } from "@t2code/contracts/spaces";

const DATE_TYPES = new Set(["date", "created_time", "last_edited_time"]);

/** Stored date types, and formulas or rollups that result in a date (read-only). */
export const isDateProperty = (property: SpaceDatabaseProperty): boolean =>
  DATE_TYPES.has(property.type) || propertyQueryType(property) === "date";

/** Only a stored `date` can be written; created and edited times are read-only. */
export const isWritableDateProperty = (property: SpaceDatabaseProperty): boolean =>
  property.type === "date";

export const dateProperties = (dataSource: SpaceDataSource): ReadonlyArray<SpaceDatabaseProperty> =>
  Object.values(dataSource.properties)
    .filter(isDateProperty)
    .sort((a, b) => a.position - b.position);
