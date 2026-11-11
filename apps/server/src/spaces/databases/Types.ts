import * as C from "@t2code/contracts/spaces";
import * as DateTime from "effect/DateTime";

export interface DatabaseRecord {
  readonly database_id: C.SpaceDatabaseId;
  readonly space_id: C.SpaceId;
  readonly title: string;
  readonly icon: string | null;
  readonly home_block_id: string | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}
export interface DataSourceRecord {
  readonly data_source_id: C.SpaceDataSourceId;
  readonly database_id: C.SpaceDatabaseId;
  readonly name: string;
  readonly position: number;
  readonly schema_revision: number;
  readonly data_revision: number;
  readonly next_row_seq: number;
  readonly row_count: number;
  readonly sub_items_property_id: string | null;
  readonly default_template_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
export interface PropertyRecord {
  readonly data_source_id: string;
  readonly property_id: string;
  readonly name: string;
  readonly name_key: string;
  readonly type: string;
  readonly config: string;
  readonly description: string | null;
  readonly position: number;
  readonly deleted_at_ms: number | null;
}
export interface OptionRecord {
  readonly data_source_id: string;
  readonly property_id: string;
  readonly option_id: string;
  readonly name: string;
  readonly name_key: string;
  readonly color: C.SpaceDatabaseColor;
  readonly status_group: C.SpaceStatusGroup | null;
  readonly position: number;
}
export interface ViewRecord {
  readonly view_id: C.SpaceViewId;
  readonly database_id: C.SpaceDatabaseId;
  readonly data_source_id: C.SpaceDataSourceId;
  readonly owner_block_id: string | null;
  readonly name: string;
  readonly type: string;
  readonly position: number;
  readonly filter: string | null;
  readonly sorts: string;
  readonly grouping: string | null;
  readonly sub_grouping: string | null;
  readonly properties: string;
  readonly layout: string;
  readonly logical_bytes: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export const dbError = (reason: C.SpaceDatabaseError["reason"], propertyId?: string) =>
  new C.SpaceDatabaseError({
    reason,
    ...(propertyId === undefined ? {} : { propertyId: C.SpacePropertyId.make(propertyId) }),
  });
export const trashed = () => new C.SpaceValidationError({ reason: "trashed" });
export const notFound = (entity: C.SpaceNotFoundError["entity"], id: string) =>
  new C.SpaceNotFoundError({ entity, id });
export const isoNow = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
