import {
  conditionForOperator,
  conditionForProperty,
  filterOperatorsFor,
  knownProperty,
  propertyQueryType,
  unqueryableReason,
  type FilterCondition,
} from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseProperty, SpacePropertyId } from "@t2code/contracts/spaces";
import { CopyIcon, GroupIcon, MoreHorizontalIcon, Trash2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { operatorLabel } from "./filterLabels";
import { FilterValue } from "./FilterValue";
import { OptionSelect } from "./OptionSelect";

export function FilterRule({
  condition,
  properties,
  disabled,
  canGroup,
  onChange,
  onDuplicate,
  onWrap,
  onRemove,
}: {
  readonly condition: FilterCondition;
  /** Every live property of the data source. */
  readonly properties: Readonly<Record<string, SpaceDatabaseProperty>>;
  readonly disabled: boolean;
  readonly canGroup: boolean;
  readonly onChange: (next: FilterCondition) => void;
  readonly onDuplicate: () => void;
  readonly onWrap: () => void;
  readonly onRemove: () => void;
}) {
  const property = properties[condition.property];
  const known = property === undefined ? null : knownProperty(property);
  const queryType = property === undefined ? undefined : propertyQueryType(property);
  const filterable = Object.values(properties)
    .filter(
      (entry) =>
        filterOperatorsFor(propertyQueryType(entry) ?? "").length > 0 ||
        unqueryableReason(entry) !== undefined,
    )
    .sort((a, b) => a.position - b.position);
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {known === null || queryType === undefined ? (
        <span className="text-xs text-muted-foreground">This property can't be filtered</span>
      ) : (
        <>
          <PropertyPicker
            properties={filterable}
            value={condition.property}
            disabled={disabled}
            label="Filter property"
            disabledReason={unqueryableReason}
            onChange={(id: SpacePropertyId) => {
              const next = properties[id];
              const nextKnown = next === undefined ? null : knownProperty(next);
              const nextType = next === undefined ? undefined : propertyQueryType(next);
              if (nextKnown !== null && nextType !== undefined && id !== condition.property)
                onChange(conditionForProperty(condition, nextKnown, nextType));
            }}
          />
          <OptionSelect
            label="Filter operator"
            disabled={disabled}
            value={condition.operator}
            choices={filterOperatorsFor(queryType).map((operator) => ({
              value: operator,
              label: operatorLabel(operator, queryType),
              disabled:
                queryType === "relation" && operator !== "is_empty" && operator !== "is_not_empty",
            }))}
            onChange={(operator) =>
              onChange(
                conditionForOperator(
                  condition,
                  known,
                  operator as FilterCondition["operator"],
                  queryType,
                ),
              )
            }
          />
          <FilterValue
            known={known}
            queryType={queryType}
            operator={condition.operator}
            value={condition.value}
            disabled={disabled}
            onChange={(value) => onChange({ ...condition, value: value as never })}
          />
        </>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              disabled={disabled}
              aria-label="Rule options"
            />
          }
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={onDuplicate}>
            <CopyIcon />
            Duplicate
          </MenuItem>
          <MenuItem disabled={!canGroup} onClick={onWrap}>
            <GroupIcon />
            Turn into group
          </MenuItem>
          <MenuItem variant="destructive" onClick={onRemove}>
            <Trash2Icon />
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
