import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import type { Property } from "../SchemaStore.ts";
import { dbError } from "../Types.ts";
import { hasCell, liveTarget, noCell } from "./Cells.ts";
import { bucketBounds, instantIso, validBucketStart } from "./Dates.ts";
import type { Compile, Fragment, GroupBy, GroupSpec, KeyValue } from "./Types.ts";

export type Alias = "g0" | "g1";

const dateTypes = new Set<C.SpacePropertyType>(["date", "created_time", "last_edited_time"]);
const textTypes = new Set<C.SpacePropertyType>(["title", "text", "url", "email", "phone"]);
const statusRank = { todo: 0, in_progress: 1, complete: 2 } as const;
const STATUS_GROUPS = ["todo", "in_progress", "complete"] as const;

/** The validated `by` with its per-type default made explicit; undefined when none exists. */
const resolveBy = (
  property: Property,
  by: C.SpaceKnownGroupBy | undefined,
): GroupBy | undefined => {
  if (typeof by === "object") return { kind: "range", ...by.range };
  switch (by) {
    case "day":
    case "week":
    case "month":
    case "year":
      return { kind: "date", unit: by };
    case "option":
    case "status_group":
    case "checkbox":
    case "exact":
    case "alphabetical":
    case "page":
      return { kind: by };
    default:
      break;
  }
  if (textTypes.has(property.type)) return { kind: "exact" };
  if (dateTypes.has(property.type)) return { kind: "date", unit: "month" };
  switch (property.type) {
    case "select":
    case "multi_select":
    case "status":
      return { kind: "option" };
    case "checkbox":
      return { kind: "checkbox" };
    case "relation":
      return { kind: "page" };
    default:
      return undefined;
  }
};

export const specOf = (property: Property, group: C.SpaceKnownGroup): GroupSpec | undefined => {
  const by = resolveBy(property, group.by);
  if (by === undefined) return undefined;
  return {
    propertyId: property.id,
    type: property.type,
    by,
    descending: group.sort === "descending",
    source: group,
  };
};

const col = (c: Compile, alias: Alias, name: string) => c.sql.literal(`${alias}.${name}`);

/** LEFT JOINs that give one line per cell item, or one line with NULLs when the cell is empty. */
export const joins = (c: Compile, spec: GroupSpec, alias: Alias): Fragment => {
  const { sql } = c;
  if (spec.type === "unique_id" || spec.type === "created_time" || spec.type === "last_edited_time")
    return sql``;
  const live =
    spec.type === "relation" ? sql` AND ${liveTarget(sql, col(c, alias, "ref"))}` : sql``;
  const cells = sql`LEFT JOIN spaces_db_cells ${sql.literal(alias)} ON ${col(c, alias, "page_id")} = p.page_id
    AND ${col(c, alias, "property_id")} = ${spec.propertyId}${live}`;
  if (spec.by.kind !== "status_group") return cells;
  return sql`${cells} LEFT JOIN spaces_db_options ${sql.literal(`${alias}o`)}
    ON ${sql.literal(`${alias}o.data_source_id`)} = ${c.snapshot.source.data_source_id}
    AND ${sql.literal(`${alias}o.property_id`)} = ${spec.propertyId}
    AND ${sql.literal(`${alias}o.option_id`)} = ${col(c, alias, "ref")}`;
};

const offsetModifier = (offsetMs: number) => {
  const seconds = Math.round(offsetMs / 1000);
  return `${seconds < 0 ? "-" : "+"}${Math.abs(seconds)} seconds`;
};

/** The arguments after a strftime format: a stored instant shifted by the viewer's offset. */
const timeArgs = (c: Compile, spec: GroupSpec, alias: Alias) => {
  const { sql } = c;
  if (spec.type === "created_time") return sql`p.created_at, ${offsetModifier(c.dates.offsetMs)}`;
  if (spec.type === "last_edited_time")
    return sql`p.updated_at, ${offsetModifier(c.dates.offsetMs)}`;
  return sql`(${col(c, alias, "time_start")} + CASE WHEN (${col(c, alias, "flags")} & 1) = 1
    THEN ${c.dates.offsetMs} ELSE 0 END) / 1000.0, 'unixepoch'`;
};

const dateKey = (c: Compile, spec: GroupSpec, alias: Alias, unit: string) => {
  const { sql } = c;
  const args = timeArgs(c, spec, alias);
  switch (unit) {
    case "day":
      return sql`date(${args})`;
    case "week":
      return sql`date(${args}, '-' || ((CAST(strftime('%w', ${args}) AS INTEGER) + 7 - ${c.dates.weekStartsOn}) % 7) || ' days')`;
    case "month":
      return sql`strftime('%Y-%m-01', ${args})`;
    default:
      return sql`strftime('%Y-01-01', ${args})`;
  }
};

const rangeIndex = (c: Compile, value: Fragment, start: number, size: number) => {
  const { sql } = c;
  const x = sql`((${value} - ${start}) * 1.0 / ${size})`;
  return sql`(CAST(${x} AS INTEGER) - (${x} < CAST(${x} AS INTEGER)))`;
};

/** The scalar group key of a line; NULL is the empty bucket. */
export const keyExpr = (c: Compile, spec: GroupSpec, alias: Alias): Fragment => {
  const { sql } = c;
  const by = spec.by;
  switch (by.kind) {
    case "option":
    case "page":
      return col(c, alias, "ref");
    case "status_group":
      return sql.literal(`${alias}o.status_group`);
    case "checkbox":
      return sql`CASE WHEN ${col(c, alias, "page_id")} IS NULL THEN 0 ELSE 1 END`;
    case "exact":
      return col(c, alias, "text_key");
    case "alphabetical":
      return sql`substr(${col(c, alias, "text_key")}, 1, 1)`;
    case "range":
      return rangeIndex(
        c,
        spec.type === "unique_id" ? sql`p.row_seq` : col(c, alias, "num"),
        by.start,
        by.size,
      );
    case "date":
      return dateKey(c, spec, alias, by.unit);
  }
};

/** Extra ordering for buckets whose own key is not the order: pages sort by title. */
export const orderExpr = (c: Compile, spec: GroupSpec, alias: Alias): Fragment | undefined =>
  spec.by.kind === "page"
    ? c.sql`(SELECT tc.text_key FROM spaces_db_cells tc
        WHERE tc.page_id = ${col(c, alias, "ref")} AND tc.property_id = 'title')`
    : undefined;

/** Buckets that exist whether or not they have rows: every option, status group or checkbox value. */
export const enumerate = (
  property: Property,
  spec: GroupSpec,
): readonly C.SpaceKnownGroupKey[] | undefined => {
  switch (spec.by.kind) {
    case "option": {
      const options =
        property.type === "status"
          ? [...property.options].sort(
              (a, b) =>
                statusRank[a.status_group ?? "todo"] - statusRank[b.status_group ?? "todo"] ||
                a.position - b.position,
            )
          : property.options;
      return options.map((option) => ({
        kind: "option" as const,
        optionId: C.SpaceOptionId.make(option.option_id),
      }));
    }
    case "status_group":
      return STATUS_GROUPS.map((group) => ({
        kind: "status_group" as const,
        group,
      }));
    case "checkbox":
      return [
        { kind: "checkbox" as const, value: false },
        { kind: "checkbox" as const, value: true },
      ];
    default:
      return undefined;
  }
};

/** Whether an empty bucket is always returned: option and status grouping, not checkbox. */
export const alwaysHasEmpty = (spec: GroupSpec) =>
  spec.by.kind === "option" || spec.by.kind === "status_group";

export const toKey = (spec: GroupSpec, raw: KeyValue): C.SpaceKnownGroupKey => {
  const by = spec.by;
  if (raw === null && by.kind !== "checkbox") return { kind: "empty" };
  switch (by.kind) {
    case "option":
      return { kind: "option", optionId: C.SpaceOptionId.make(String(raw)) };
    case "status_group":
      return {
        kind: "status_group",
        group: STATUS_GROUPS.find((group) => group === raw) ?? "todo",
      };
    case "checkbox":
      return { kind: "checkbox", value: raw === 1 };
    case "exact":
    case "alphabetical":
      return { kind: "text", value: String(raw) };
    case "range": {
      const start = by.start + Number(raw) * by.size;
      return { kind: "number_range", start, end: start + by.size };
    }
    case "date":
      return { kind: "date", start: String(raw), unit: by.unit };
    case "page":
      return { kind: "page", pageId: C.SpacePageId.make(String(raw)) };
  }
};

const sameKey = (spec: GroupSpec, key: C.SpaceKnownGroupKey) => {
  const wanted: Record<GroupBy["kind"], readonly string[]> = {
    option: ["option", "empty"],
    status_group: ["status_group", "empty"],
    checkbox: ["checkbox"],
    exact: ["text", "empty"],
    alphabetical: ["text", "empty"],
    range: ["number_range", "empty"],
    date: ["date", "empty"],
    page: ["page", "empty"],
  };
  return wanted[spec.by.kind].includes(key.kind);
};

/** Membership predicate of one bucket on row `p`; the inverse of `keyExpr`. */
export const member = Effect.fn("SpacesDatabases.groupMember")(function* (
  c: Compile,
  spec: GroupSpec,
  key: C.SpaceKnownGroupKey,
) {
  const { sql } = c;
  const id = spec.propertyId;
  const by = spec.by;
  if (!sameKey(spec, key)) return yield* dbError("invalid_scope", id);
  if (key.kind === "empty") {
    if (
      spec.type === "unique_id" ||
      spec.type === "created_time" ||
      spec.type === "last_edited_time"
    )
      return sql`0`;
    return noCell(sql, id, undefined, spec.type === "relation");
  }
  switch (key.kind) {
    case "option":
      return hasCell(sql, id, sql`+c.ref = ${key.optionId}`);
    case "status_group":
      return hasCell(
        sql,
        id,
        sql`+c.ref IN (SELECT option_id FROM spaces_db_options
          WHERE data_source_id = ${c.snapshot.source.data_source_id} AND property_id = ${id}
          AND status_group = ${key.group})`,
      );
    case "checkbox":
      return key.value ? hasCell(sql, id) : noCell(sql, id);
    case "text":
      return hasCell(
        sql,
        id,
        by.kind === "alphabetical"
          ? sql`substr(c.text_key, 1, 1) = ${key.value}`
          : sql`c.text_key = ${key.value}`,
      );
    case "number_range": {
      if (by.kind !== "range") return yield* dbError("invalid_scope", id);
      // Same index expression as `keyExpr`, so a counted row is always in its bucket's scope.
      const index = Math.round((key.start - by.start) / by.size);
      if (!Number.isSafeInteger(index)) return yield* dbError("invalid_scope", id);
      return spec.type === "unique_id"
        ? sql`(${rangeIndex(c, sql`p.row_seq`, by.start, by.size)} = ${index})`
        : hasCell(sql, id, sql`${rangeIndex(c, sql`c.num`, by.start, by.size)} = ${index}`);
    }
    case "date": {
      if (by.kind !== "date" || by.unit !== key.unit || !validBucketStart(key.start))
        return yield* dbError("invalid_scope", id);
      const { lo, hi } = bucketBounds(key.start, key.unit);
      const off = c.dates.offsetMs;
      if (spec.type !== "date")
        return sql`(${spec.type === "created_time" ? sql`p.created_at` : sql`p.updated_at`} >= ${instantIso(lo - off)}
          AND ${spec.type === "created_time" ? sql`p.created_at` : sql`p.updated_at`} < ${instantIso(hi - off)})`;
      return hasCell(
        sql,
        id,
        sql`((c.flags & 1) = 0 AND c.time_start >= ${lo} AND c.time_start < ${hi})
          OR ((c.flags & 1) = 1 AND c.time_start >= ${lo - off} AND c.time_start < ${hi - off})`,
      );
    }
    case "page":
      return hasCell(sql, id, sql`+c.ref = ${key.pageId}`, true);
  }
});

/** The SQL key value of an enumerated bucket: the inverse of `toKey` for option-like groups. */
export const rawOf = (key: C.SpaceKnownGroupKey): KeyValue => {
  switch (key.kind) {
    case "option":
      return key.optionId;
    case "status_group":
      return key.group;
    case "checkbox":
      return key.value ? 1 : 0;
    default:
      return null;
  }
};
