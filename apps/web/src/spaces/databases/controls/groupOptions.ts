import { propertyOptions } from "@t2code/client-runtime/spaces";
import type {
  SpaceKnownDatabaseProperty,
  SpaceKnownGroupBy,
  SpaceKnownGroupKey,
  SpaceStatusGroup,
} from "@t2code/contracts/spaces";

import { STATUS_GROUP_LABELS } from "./filterLabels";

export interface GroupByChoice {
  readonly id: string;
  readonly label: string;
  readonly by: SpaceKnownGroupBy;
}

const TEXT_TYPES = ["title", "text", "url", "email", "phone"];
const DATE_TYPES = ["date", "created_time", "last_edited_time"];

export function groupByChoices(type: string): ReadonlyArray<GroupByChoice> {
  if (type === "status")
    return [
      { id: "option", label: "Option", by: "option" },
      { id: "status_group", label: "Group", by: "status_group" },
    ];
  if (TEXT_TYPES.includes(type))
    return [
      { id: "exact", label: "Exact", by: "exact" },
      { id: "alphabetical", label: "Alphabetical", by: "alphabetical" },
    ];
  if (DATE_TYPES.includes(type))
    return (["day", "week", "month", "year"] as const).map((unit) => ({
      id: unit,
      label: unit.charAt(0).toUpperCase() + unit.slice(1),
      by: unit,
    }));
  return [];
}

/** What `by` a freshly chosen group property starts with. */
export function defaultGroupBy(type: string): SpaceKnownGroupBy | undefined {
  if (type === "select" || type === "multi_select" || type === "status") return "option";
  if (type === "checkbox") return "checkbox";
  if (type === "relation") return "page";
  if (type === "number" || type === "unique_id") return { range: { start: 0, size: 10 } };
  if (DATE_TYPES.includes(type)) return "month";
  if (TEXT_TYPES.includes(type)) return "exact";
  return undefined;
}

export const isRangeBy = (by: unknown): by is { range: { start: number; size: number } } =>
  typeof by === "object" && by !== null && "range" in by;

/**
 * Every bucket the server returns for groupings that always have all of them (options, status
 * groups, checkbox values), plus the empty bucket. Null when the buckets depend on the data.
 */
export function listedBuckets(
  known: SpaceKnownDatabaseProperty,
  by: SpaceKnownGroupBy | undefined,
  type: string = known.type,
): ReadonlyArray<{ readonly key: SpaceKnownGroupKey; readonly label: string }> | null {
  const empty = { key: { kind: "empty" } as const, label: "No value" };
  if (type === "checkbox")
    return [
      { key: { kind: "checkbox", value: false }, label: "Unchecked" },
      { key: { kind: "checkbox", value: true }, label: "Checked" },
      empty,
    ];
  if (type === "status" && by === "status_group")
    return [
      ...(["todo", "in_progress", "complete"] as SpaceStatusGroup[]).map((group) => ({
        key: { kind: "status_group", group } as const,
        label: STATUS_GROUP_LABELS[group],
      })),
      empty,
    ];
  if (type === "status" || type === "select" || type === "multi_select")
    return [
      ...propertyOptions(known).map((option) => ({
        key: { kind: "option", optionId: option.id } as SpaceKnownGroupKey,
        label: option.name,
      })),
      empty,
    ];
  return null;
}
