import type * as C from "@t2code/contracts/spaces";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

import type { Snapshot } from "../SchemaStore.ts";
import type { DateContext } from "./Dates.ts";

export type Sql = SqlClient.SqlClient;
export type { Fragment };

/** What every compiler function needs: the statement builder, the schema and the viewer's calendar. */
export interface Compile {
  readonly sql: Sql;
  /** The schema as the compiler sees it: computed properties carry their query type. */
  readonly snapshot: Snapshot;
  /** The stored schema, for hydrating rows. */
  readonly full: Snapshot;
  readonly dates: DateContext;
}

export type GroupBy =
  | { readonly kind: "option" }
  | { readonly kind: "status_group" }
  | { readonly kind: "checkbox" }
  | { readonly kind: "exact" }
  | { readonly kind: "alphabetical" }
  | { readonly kind: "range"; readonly start: number; readonly size: number }
  | { readonly kind: "date"; readonly unit: "day" | "week" | "month" | "year" }
  | { readonly kind: "page" };

export interface GroupSpec {
  readonly propertyId: string;
  readonly type: C.SpacePropertyType;
  readonly by: GroupBy;
  readonly descending: boolean;
  /** The definition as validated, for the cursor fingerprint. */
  readonly source: C.SpaceKnownGroup;
}

export interface Scope {
  readonly group?: C.SpaceKnownGroupKey;
  readonly subGroup?: C.SpaceKnownGroupKey;
  readonly parentRowId?: string | null;
}

/** The query after the view, overrides, quick filters and search are merged and validated. */
export interface Effective {
  /** The merged filter: ANDed parts, each already validated. */
  readonly filters: readonly C.SpaceKnownFilter[];
  readonly search: string;
  readonly sorts: readonly C.SpaceKnownSort[];
  readonly group: GroupSpec | undefined;
  readonly subGroup: GroupSpec | undefined;
  readonly aggregates: readonly C.SpaceKnownAggregate[];
  readonly scope: Scope;
  /** Cells to hydrate, title included. */
  readonly properties: readonly string[];
}

export type KeyValue = string | number | null;
