import { propertyOptions, operatorNeedsValue } from "@t2code/client-runtime/spaces";
import type { SpaceKnownDatabaseProperty, SpaceStatusGroup } from "@t2code/contracts/spaces";

import { DebouncedInput } from "./DebouncedInput";
import { FilterDateValue } from "./FilterDateValue";
import { STATUS_GROUP_LABELS } from "./filterLabels";
import { OptionSelect } from "./OptionSelect";

const GROUP_CHOICES = (Object.keys(STATUS_GROUP_LABELS) as SpaceStatusGroup[]).map((value) => ({
  value,
  label: STATUS_GROUP_LABELS[value],
}));
const CHECKED = [
  { value: "true", label: "Checked" },
  { value: "false", label: "Unchecked" },
];

/** The value editor of one filter rule; renders nothing for operators without a value. */
export function FilterValue({
  known,
  queryType: queryTypeProp,
  operator,
  value,
  onChange,
  disabled,
}: {
  readonly known: SpaceKnownDatabaseProperty;
  /** What a formula or rollup filters as; defaults to the property's own type. */
  readonly queryType?: string;
  readonly operator: string;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly disabled: boolean;
}) {
  if (!operatorNeedsValue(operator)) return null;
  const queryType = queryTypeProp ?? known.type;
  switch (queryType) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return (
        <DebouncedInput
          label="Filter value"
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          onCommit={onChange}
        />
      );
    case "number":
    case "unique_id":
      return (
        <DebouncedInput
          type="number"
          label="Filter value"
          disabled={disabled}
          value={typeof value === "number" ? String(value) : ""}
          onCommit={(next) => {
            const parsed = Number(next);
            if (next.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
          }}
        />
      );
    case "checkbox":
      return (
        <OptionSelect
          label="Filter value"
          disabled={disabled}
          value={value === false ? "false" : "true"}
          choices={CHECKED}
          onChange={(next) => onChange(next === "true")}
        />
      );
    case "status":
    case "select":
    case "multi_select":
      if (operator === "in_group" || operator === "not_in_group")
        return (
          <OptionSelect
            label="Filter value"
            disabled={disabled}
            value={typeof value === "string" ? (value as SpaceStatusGroup) : null}
            choices={GROUP_CHOICES}
            onChange={onChange}
          />
        );
      return (
        <OptionSelect
          label="Filter value"
          disabled={disabled}
          value={typeof value === "string" ? value : null}
          choices={propertyOptions(known).map((option) => ({
            value: option.id,
            label: option.name,
          }))}
          placeholder="Choose an option"
          onChange={onChange}
        />
      );
    case "date":
    case "created_time":
    case "last_edited_time":
      return (
        <FilterDateValue
          operator={operator}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    default:
      return null;
  }
}
