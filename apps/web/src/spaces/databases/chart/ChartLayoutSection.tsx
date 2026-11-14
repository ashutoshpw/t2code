import { groupByChoices, defaultGroupBy } from "../controls/groupOptions";
import { propertyQueryType } from "@t2code/client-runtime/spaces";
import {
  SPACE_CHART_TYPES,
  SPACE_CHART_Y_FUNCTIONS,
  SPACE_GROUPABLE_TYPES,
  SpacePropertyId,
} from "@t2code/contracts/spaces";

import { Switch } from "~/components/ui/switch";
import { OptionSelect } from "../controls/OptionSelect";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

const KINDS = [
  { value: "bar", label: "Bar" },
  { value: "horizontal_bar", label: "Horizontal bar" },
  { value: "line", label: "Line" },
  { value: "donut", label: "Donut" },
] as const satisfies ReadonlyArray<{ value: (typeof SPACE_CHART_TYPES)[number]; label: string }>;

const FUNCTIONS = [
  { value: "sum", label: "Sum" },
  { value: "average", label: "Average" },
  { value: "median", label: "Median" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
] as const satisfies ReadonlyArray<{
  value: (typeof SPACE_CHART_Y_FUNCTIONS)[number];
  label: string;
}>;

const SORTS = [
  { value: "group", label: "Group order" },
  { value: "ascending", label: "Value ascending" },
  { value: "descending", label: "Value descending" },
] as const;

const COUNT = "count";
const OPTION_TYPES = ["select", "multi_select", "status"];

/** Chart type, axes, sorting and colours. */
export function ChartLayoutSection({ known, dataSource, editView, disabled }: LayoutSectionProps) {
  if (known?.type !== "chart") return null;
  const layout = known.layout;
  const group = known.group;
  const properties = Object.values(dataSource.properties).sort((a, b) => a.position - b.position);
  const typeOf = (id: string) => {
    const property = dataSource.properties[id];
    return property === undefined ? "" : (propertyQueryType(property) ?? "");
  };
  const groupable = properties.filter((property) =>
    (SPACE_GROUPABLE_TYPES as ReadonlyArray<string>).includes(propertyQueryType(property) ?? ""),
  );
  const numbers = properties.filter((property) => property.type === "number");
  const xType = group === undefined ? "" : typeOf(group.property);
  const dateBy = groupByChoices(xType);
  const by = group?.by;
  const y = layout.y;
  const withoutY = () => {
    const { y: _y, ...rest } = layout;
    return rest;
  };
  return (
    <>
      <LayoutRow label="Chart type">
        <OptionSelect
          label="Chart type"
          value={layout.chartType ?? "bar"}
          disabled={disabled}
          choices={KINDS}
          onChange={(chartType) => editView({ layout: { ...layout, chartType } })}
        />
      </LayoutRow>
      <LayoutRow label="X axis">
        <PropertyPicker
          label="X axis"
          placeholder="Choose"
          properties={groupable}
          value={group?.property ?? null}
          disabled={disabled}
          onChange={(property) => {
            if (property === group?.property) return;
            const next = defaultGroupBy(typeOf(property));
            editView({
              group: {
                property,
                ...(next === undefined ? {} : { by: next }),
                ...(group?.hideEmpty === undefined ? {} : { hideEmpty: group.hideEmpty }),
              },
            });
          }}
        />
      </LayoutRow>
      {group === undefined || !dateBy.some((choice) => choice.id === "day") ? null : (
        <LayoutRow label="Date by">
          <OptionSelect
            label="Date by"
            value={typeof by === "string" ? by : null}
            disabled={disabled}
            choices={dateBy.map((choice) => ({ value: choice.id, label: choice.label }))}
            onChange={(id) => {
              const choice = dateBy.find((entry) => entry.id === id);
              if (choice === undefined) return;
              editView({
                group: {
                  property: group.property,
                  by: choice.by,
                  ...(group.hideEmpty === undefined ? {} : { hideEmpty: group.hideEmpty }),
                },
              });
            }}
          />
        </LayoutRow>
      )}
      <LayoutRow label="Y axis">
        <OptionSelect
          label="Y axis"
          value={y?.property ?? COUNT}
          disabled={disabled}
          choices={[
            { value: COUNT, label: "Count" },
            ...numbers.map((property) => ({ value: property.id as string, label: property.name })),
          ]}
          onChange={(value) =>
            editView({
              layout:
                value === COUNT
                  ? withoutY()
                  : {
                      ...layout,
                      y: { property: SpacePropertyId.make(value), function: y?.function ?? "sum" },
                    },
            })
          }
        />
      </LayoutRow>
      {y === undefined ? null : (
        <LayoutRow label="Calculation">
          <OptionSelect
            label="Calculation"
            value={y.function}
            disabled={disabled}
            choices={FUNCTIONS}
            onChange={(fn) => editView({ layout: { ...layout, y: { ...y, function: fn } } })}
          />
        </LayoutRow>
      )}
      <LayoutRow label="Sort">
        <OptionSelect
          label="Sort"
          value={layout.sortByValue ?? "group"}
          disabled={disabled}
          choices={SORTS}
          onChange={(value) => {
            if (value === "group") {
              const { sortByValue: _sort, ...rest } = layout;
              editView({ layout: rest });
            } else editView({ layout: { ...layout, sortByValue: value } });
          }}
        />
      </LayoutRow>
      {OPTION_TYPES.includes(xType) ? (
        <LayoutRow label="Color by option">
          <Switch
            size="sm"
            aria-label="Color by option"
            checked={layout.colorByOption !== false}
            disabled={disabled}
            onCheckedChange={(colorByOption) => editView({ layout: { ...layout, colorByOption } })}
          />
        </LayoutRow>
      ) : null}
      <LayoutRow label="Show values">
        <Switch
          size="sm"
          aria-label="Show values"
          checked={layout.showValues === true}
          disabled={disabled}
          onCheckedChange={(showValues) => editView({ layout: { ...layout, showValues } })}
        />
      </LayoutRow>
      {group === undefined ? null : (
        <LayoutRow label="Hide empty groups">
          <Switch
            size="sm"
            aria-label="Hide empty groups"
            checked={group.hideEmpty === true}
            disabled={disabled}
            onCheckedChange={(hideEmpty) => editView({ group: { ...group, hideEmpty } })}
          />
        </LayoutRow>
      )}
    </>
  );
}
