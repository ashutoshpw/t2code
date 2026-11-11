import type {
  SpaceDataSourceId,
  SpaceDatabaseProperty,
  SpacePropertyId,
} from "@t2code/contracts/spaces";

import { knownProperty } from "./schema.ts";

const PARENT_NAME = "Parent item";
const CHILD_NAME = "Sub-items";

export type SubItemPlan =
  | { readonly kind: "reuse"; readonly parentPropertyId: SpacePropertyId }
  | { readonly kind: "create"; readonly parentName: string; readonly childName: string };

const freeName = (taken: ReadonlySet<string>, base: string) => {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
};

/**
 * Turning sub-items on again reuses a live self-relation pair (limit one, with a two-way twin),
 * preferring the one named "Parent item"; otherwise it picks property names that are free, since
 * names are unique within a data source.
 */
export function planSubItems(
  dataSourceId: SpaceDataSourceId,
  properties: Readonly<Record<string, SpaceDatabaseProperty>>,
): SubItemPlan {
  const live = Object.values(properties).sort((a, b) => a.position - b.position);
  const pairs = live.filter((property) => {
    const known = knownProperty(property);
    if (known?.type !== "relation") return false;
    const { config } = known;
    if (config.dataSourceId !== dataSourceId || config.limit !== "one") return false;
    return config.twoWay !== undefined && properties[config.twoWay.propertyId] !== undefined;
  });
  const chosen = pairs.find((property) => property.name === PARENT_NAME) ?? pairs[0];
  if (chosen !== undefined) return { kind: "reuse", parentPropertyId: chosen.id };
  const taken = new Set(live.map((property) => property.name.toLowerCase()));
  return {
    kind: "create",
    parentName: freeName(taken, PARENT_NAME),
    childName: freeName(new Set([...taken, PARENT_NAME.toLowerCase()]), CHILD_NAME),
  };
}
