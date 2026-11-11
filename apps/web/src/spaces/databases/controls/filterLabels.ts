import {
  SPACE_RELATIVE_DATES,
  type SpaceStatusGroup,
  type SpacePropertyType,
} from "@t2code/contracts/spaces";

const OPERATOR_LABELS: Record<string, string> = {
  equals: "Is",
  does_not_equal: "Is not",
  contains: "Contains",
  does_not_contain: "Does not contain",
  starts_with: "Starts with",
  ends_with: "Ends with",
  is_empty: "Is empty",
  is_not_empty: "Is not empty",
  greater_than: "Greater than",
  less_than: "Less than",
  greater_than_or_equal_to: "Greater than or equal to",
  less_than_or_equal_to: "Less than or equal to",
  before: "Is before",
  after: "Is after",
  on_or_before: "Is on or before",
  on_or_after: "Is on or after",
  within: "Is within",
  in_group: "Is in group",
  not_in_group: "Is not in group",
};

const NUMBER_SYMBOLS: Record<string, string> = {
  equals: "=",
  does_not_equal: "≠",
  greater_than: ">",
  less_than: "<",
  greater_than_or_equal_to: "≥",
  less_than_or_equal_to: "≤",
};

export function operatorLabel(operator: string, type: SpacePropertyType | string): string {
  if ((type === "number" || type === "unique_id") && NUMBER_SYMBOLS[operator] !== undefined)
    return NUMBER_SYMBOLS[operator]!;
  return OPERATOR_LABELS[operator] ?? operator;
}

export const RELATIVE_DATE_LABELS: Record<(typeof SPACE_RELATIVE_DATES)[number], string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  yesterday: "Yesterday",
  one_week_ago: "One week ago",
  one_week_from_now: "One week from now",
  one_month_ago: "One month ago",
  one_month_from_now: "One month from now",
};

export const STATUS_GROUP_LABELS: Record<SpaceStatusGroup, string> = {
  todo: "To-do",
  in_progress: "In progress",
  complete: "Complete",
};

export const WITHIN_DIRECTION_LABELS = { past: "Past", next: "Next", this: "This" } as const;
export const WITHIN_UNIT_LABELS = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
} as const;
