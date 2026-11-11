import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ensureDatabaseLimit } from "../../CorePolicy.ts";
import { fold } from "../Fold.ts";
import { parseJson } from "../Json.ts";
import type { Property, Snapshot } from "../SchemaStore.ts";
import { dbError, notFound } from "../Types.ts";
import * as Validation from "../ViewValidation.ts";
import type { ViewRecord } from "../Types.ts";
import { specOf } from "./Group.ts";
import type { Effective, GroupSpec } from "./Types.ts";

const strict = { onExcessProperty: "error" } as const;
const filterOf = Schema.decodeUnknownOption(C.SpaceKnownFilter, strict);
const sortsOf = Schema.decodeUnknownOption(Schema.Array(C.SpaceKnownSort), strict);
const aggregatesOf = Schema.decodeUnknownOption(Schema.Array(C.SpaceKnownAggregate), strict);
// Presentation fields of a group (order, hidden, collapsed) are not the server's business.
const GroupShape = Schema.Struct({
  property: C.SpacePropertyId,
  by: Schema.optionalKey(C.SpaceKnownGroupBy),
  sort: Schema.optionalKey(Schema.Literals(["ascending", "descending", "manual"])),
});
const groupOf = Schema.decodeUnknownOption(GroupShape);
const keyOf = Schema.decodeUnknownOption(C.SpaceKnownGroupKey, strict);
const columnsOf = Schema.decodeUnknownOption(Schema.Array(C.SpaceViewProperty));
const isAggregate = Schema.is(C.SpaceAggregateFunction);

const computed = new Set<C.SpacePropertyType>(["formula", "rollup"]);

/** Section 4.9: formula and rollup are declared but cannot be queried until their values exist. */
const rejectComputed = (snapshot: Snapshot, filter: C.SpaceKnownFilter) => {
  const pending = [filter];
  const check = Effect.fn("SpacesDatabases.rejectComputed")(function* () {
    while (pending.length > 0) {
      const node = pending.pop()!;
      const nested = Validation.children(node);
      if (nested) pending.push(...nested);
      else if (Validation.isCondition(node)) {
        const property = snapshot.byId.get(node.property);
        if (property === undefined || property.deletedAtMs !== null)
          return yield* notFound("property", node.property);
        if (computed.has(property.type))
          return yield* dbError("property_not_queryable", property.id);
      }
    }
  });
  return check();
};

const filterParts = Effect.fn("SpacesDatabases.validateFilterPart")(function* (
  snapshot: Snapshot,
  raw: unknown,
) {
  const filter = Option.getOrUndefined(filterOf(raw));
  if (filter === undefined) return yield* dbError("invalid_filter");
  yield* rejectComputed(snapshot, filter);
  yield* Validation.validateFilter(snapshot, filter);
  return filter;
});

const groupSpec = Effect.fn("SpacesDatabases.validateQueryGroup")(function* (
  snapshot: Snapshot,
  raw: unknown,
) {
  const group = Option.getOrUndefined(groupOf(raw));
  if (group === undefined) return yield* dbError("invalid_group");
  const property: Property = yield* Validation.validateGroup(snapshot, group);
  const spec = specOf(property, group);
  if (spec === undefined) return yield* dbError("invalid_group", property.id);
  return spec;
});

export interface QueryDefinitionInput {
  readonly view: ViewRecord | undefined;
  readonly filter: C.SpaceFilter | null | undefined;
  readonly extraFilter: C.SpaceFilter | undefined;
  readonly sorts: readonly C.SpaceSort[] | undefined;
  readonly group: C.SpaceGroup | null | undefined;
  readonly subGroup: C.SpaceGroup | null | undefined;
  readonly search: string | undefined;
  readonly aggregates: readonly C.SpaceAggregate[] | undefined;
  readonly includeAggregates: boolean;
  readonly properties: readonly string[] | undefined;
  readonly scope: C.SpaceDatabaseQueryInput["scope"];
  readonly mode: "rows" | "groups";
}

const required = Effect.fn("SpacesDatabases.requiredDefinition")(function* <A>(
  value: Option.Option<A>,
  reason: C.SpaceDatabaseError["reason"],
) {
  return Option.isSome(value) ? value.value : yield* dbError(reason);
});

/** Section 3.8: the view, then each override, then quick filter, search and scope. */
export const effective = Effect.fn("SpacesDatabases.effectiveQuery")(function* (
  snapshot: Snapshot,
  input: QueryDefinitionInput,
) {
  const { view } = input;
  const filters: C.SpaceKnownFilter[] = [];
  const base =
    input.filter !== undefined ? input.filter : view?.filter ? parseJson(view.filter) : null;
  if (base !== null) filters.push(yield* filterParts(snapshot, base));
  if (input.extraFilter !== undefined)
    filters.push(yield* filterParts(snapshot, input.extraFilter));

  const rawSorts = input.sorts ?? (view ? parseJson(view.sorts) : []);
  const sorts = yield* required(sortsOf(rawSorts), input.sorts ? "invalid_sort" : "invalid_view");
  yield* Validation.validateSorts(snapshot, sorts);

  const rawGroup =
    input.group !== undefined ? input.group : view?.grouping ? parseJson(view.grouping) : null;
  const rawSub =
    input.subGroup !== undefined
      ? input.subGroup
      : view?.sub_grouping
        ? parseJson(view.sub_grouping)
        : null;
  const group = rawGroup === null ? undefined : yield* groupSpec(snapshot, rawGroup);
  const subGroup = rawSub === null ? undefined : yield* groupSpec(snapshot, rawSub);
  if (subGroup !== undefined && (group === undefined || subGroup.propertyId === group.propertyId))
    return yield* dbError("invalid_group", subGroup.propertyId);
  if (input.mode === "groups" && group === undefined) return yield* dbError("invalid_group");

  const columns = view ? Option.getOrUndefined(columnsOf(parseJson(view.properties))) : undefined;
  const aggregates: C.SpaceKnownAggregate[] = [];
  if (input.includeAggregates) {
    const requested =
      input.aggregates !== undefined
        ? yield* required(aggregatesOf(input.aggregates), "invalid_aggregate")
        : (columns ?? []).flatMap((column) =>
            column.aggregate !== undefined && isAggregate(column.aggregate)
              ? [{ property: column.propertyId, function: column.aggregate }]
              : [],
          );
    yield* ensureDatabaseLimit("maxAggregates", requested.length);
    for (const aggregate of requested) {
      const property = snapshot.byId.get(aggregate.property);
      if (property === undefined || property.deletedAtMs !== null)
        return yield* notFound("property", aggregate.property);
      yield* Validation.validateAggregate(property, aggregate.function);
      aggregates.push(aggregate);
    }
  }

  const scope = yield* scopeOf(snapshot, input.scope, input.mode, group, subGroup);
  const wanted =
    input.properties ??
    (columns
      ? columns.filter((column) => column.visible).map((column) => column.propertyId)
      : snapshot.live.map((property) => property.id));
  const properties: string[] = [
    C.SPACE_TITLE_PROPERTY_ID,
    ...wanted.filter(
      (id) =>
        id !== C.SPACE_TITLE_PROPERTY_ID &&
        (input.properties !== undefined || snapshot.byId.get(id)?.deletedAtMs === null),
    ),
  ];
  return {
    filters,
    search: input.search === undefined ? "" : fold(input.search),
    sorts,
    group,
    subGroup,
    aggregates,
    scope,
    properties: [...new Set(properties)],
  } satisfies Effective;
});

const scopeOf = Effect.fn("SpacesDatabases.validateScope")(function* (
  snapshot: Snapshot,
  raw: QueryDefinitionInput["scope"],
  mode: "rows" | "groups",
  group: GroupSpec | undefined,
  subGroup: GroupSpec | undefined,
) {
  if (raw === undefined) return {};
  const read = (key: unknown) => Option.getOrUndefined(keyOf(key));
  if (mode === "groups" && (raw.group !== undefined || raw.subGroup !== undefined))
    return yield* dbError("invalid_scope");
  const scoped: {
    group?: C.SpaceKnownGroupKey;
    subGroup?: C.SpaceKnownGroupKey;
    parentRowId?: string | null;
  } = {};
  if (raw.group !== undefined) {
    const key = read(raw.group);
    if (key === undefined || group === undefined) return yield* dbError("invalid_scope");
    scoped.group = key;
  }
  if (raw.subGroup !== undefined) {
    const key = read(raw.subGroup);
    if (key === undefined || subGroup === undefined || scoped.group === undefined)
      return yield* dbError("invalid_scope");
    scoped.subGroup = key;
  }
  if (raw.parentRowId !== undefined) {
    const parent =
      snapshot.source.sub_items_property_id === null
        ? undefined
        : snapshot.byId.get(snapshot.source.sub_items_property_id);
    if (parent === undefined || parent.deletedAtMs !== null) return yield* dbError("invalid_scope");
    scoped.parentRowId = raw.parentRowId;
  }
  return scoped;
});
