import * as C from "@t2code/contracts/spaces";
import type { AdvertisedDocument } from "../../../spaces/InputCodec.ts";

// These reduce only what a model reads. Handlers still decode with the full contract schema,
// so a malformed value is rejected with the path of the bad field.
type Json = { [key: string]: unknown };

const FILTER: Json = {
  type: "object",
  description:
    "Filter tree: {and:[...]}, {or:[...]} or {property, operator, value}. Operators and value shapes per property type are listed on t2_spaces_databases_query.",
};
const GROUP: Json = {
  type: "object",
  description:
    "{property, by?, sort?: 'ascending'|'descending'|'manual', hideEmpty?, order?/hidden?/collapsed?: group keys}. by: option|status_group|checkbox|exact|alphabetical|page|day|week|month|year|relative or {range:{start,size}}.",
  properties: { property: { type: "string" } },
  required: ["property"],
};
const SUB_GROUP: Json = { type: "object", description: "Same shape as group." };
const AGGREGATE: Json = {
  type: "string",
  description: "Aggregate function for the column, e.g. count, sum, average, min, max, checked.",
};

const references = (value: unknown, found: Set<string>) => {
  if (Array.isArray(value)) value.forEach((item) => references(item, found));
  else if (typeof value === "object" && value !== null)
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") found.add(child.replace(/^#\/\$defs\//, ""));
      else references(child, found);
    }
};

const settle = (schema: Json, definitions: AdvertisedDocument["definitions"]) => {
  const reachable = new Set<string>();
  const pending: Array<unknown> = [schema];
  while (pending.length > 0) {
    const found = new Set<string>();
    references(pending.pop(), found);
    for (const name of found)
      if (!reachable.has(name) && name in definitions) {
        reachable.add(name);
        pending.push(definitions[name]);
      }
  }
  return {
    schema,
    definitions: Object.fromEntries(Object.entries(definitions).filter(([k]) => reachable.has(k))),
  };
};

const withProperties =
  (replace: (properties: Json) => Json) =>
  ({ schema, definitions }: AdvertisedDocument): AdvertisedDocument => {
    const properties = (schema.properties ?? {}) as Json;
    return settle({ ...schema, properties: replace(properties) }, definitions);
  };

export const advertiseView = withProperties((properties) => {
  const columns = properties.properties as Json | undefined;
  const items = columns?.items as Json | undefined;
  const itemProperties = items?.properties as Json | undefined;
  return {
    ...properties,
    filter: FILTER,
    group: GROUP,
    subGroup: SUB_GROUP,
    ...(itemProperties
      ? {
          properties: {
            ...columns,
            items: { ...items, properties: { ...itemProperties, aggregate: AGGREGATE } },
          },
        }
      : {
          properties: {
            type: "object",
            description:
              "set: {propertyId: {visible?, width?, wrap?, aggregate?} or null to reset that column}; order: property ids.",
            properties: {
              set: { type: "object" },
              order: { type: "array", items: { type: "string" } },
            },
          },
        }),
  };
});

const OPERATIONS = C.SpaceMutationRequest.members.map((member) => member.fields.operation.literal);

export const advertiseReceiptLookup = (document: AdvertisedDocument): AdvertisedDocument =>
  settle(
    {
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: {
            operation: { type: "string", enum: OPERATIONS },
            input: {
              type: "object",
              description:
                "The original input of that mutation, unchanged: environmentId, mutationId, receiptEpoch and every other field as sent.",
            },
          },
          required: ["operation", "input"],
        },
      },
      required: ["request"],
    },
    document.definitions,
  );

const GROUP_KEY: Json = {
  type: "object",
  description: "A group key as returned by a groups query: {kind, ...}.",
};
const SORTS: Json = {
  type: "array",
  items: {
    type: "object",
    properties: {
      property: { type: "string" },
      direction: { type: "string", enum: ["ascending", "descending"] },
    },
    required: ["property", "direction"],
  },
};

export const advertiseQuery = withProperties((properties) => {
  const scope = properties.scope as Json | undefined;
  const aggregates = properties.aggregates as Json | undefined;
  return {
    ...properties,
    sorts: SORTS,
    group: GROUP,
    subGroup: SUB_GROUP,
    ...(scope
      ? {
          scope: {
            ...scope,
            properties: {
              ...(scope.properties as Json),
              group: GROUP_KEY,
              subGroup: GROUP_KEY,
            },
          },
        }
      : {}),
    ...(aggregates
      ? {
          aggregates: {
            type: "array",
            items: {
              type: "object",
              properties: { property: { type: "string" }, function: { type: "string" } },
              required: ["property", "function"],
            },
          },
        }
      : {}),
  };
});
