import { knownProperty } from "@t2code/client-runtime/spaces";
import {
  SPACE_AGGREGATES_BY_TYPE,
  SpacePropertyId,
  type SpaceAggregateFunction,
} from "@t2code/contracts/spaces";

import { Switch } from "~/components/ui/switch";
import { OptionSelect } from "../controls/OptionSelect";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

const PAGE_CONTENT = "page_content";
const SIZES = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
] as const;

const aggregatesFor = (type: string): ReadonlyArray<string> =>
  (SPACE_AGGREGATES_BY_TYPE as Readonly<Record<string, ReadonlyArray<string>>>)[type] ?? [];

const label = (fn: string) => fn.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

/** Card size and preview, fit, wrapped properties, column colours and the column calculation. */
export function BoardLayoutSection({
  known,
  dataSource,
  view,
  editView,
  disabled,
}: LayoutSectionProps) {
  if (known?.type !== "board") return null;
  const layout = known.layout;
  const files = Object.values(dataSource.properties)
    .filter((property) => knownProperty(property)?.type === "files")
    .sort((a, b) => a.position - b.position);
  const preview = layout.cardPreview;
  const cover =
    preview?.kind === "page_content"
      ? PAGE_CONTENT
      : preview?.kind === "property" && files.some((property) => property.id === preview.propertyId)
        ? preview.propertyId
        : "none";
  const calculated = view.properties.find((entry) => entry.aggregate !== undefined);
  const calculatedProperty =
    calculated === undefined ? null : dataSource.properties[calculated.propertyId];
  const calculable = Object.values(dataSource.properties)
    .filter((property) => aggregatesFor(property.type).length > 0)
    .sort((a, b) => a.position - b.position);
  const functions: ReadonlyArray<string> =
    calculatedProperty === null || calculatedProperty === undefined
      ? []
      : aggregatesFor(calculatedProperty.type);

  /** One calculation per board: setting one clears the others. */
  const calculate = (propertyId: string | null, fn: SpaceAggregateFunction | null) => {
    const set: Record<string, { aggregate: SpaceAggregateFunction | null }> = {};
    for (const entry of view.properties)
      if (entry.aggregate !== undefined && entry.propertyId !== propertyId)
        set[entry.propertyId] = { aggregate: null };
    if (propertyId !== null) set[propertyId] = { aggregate: fn };
    if (Object.keys(set).length > 0) editView({ properties: { set } });
  };

  return (
    <>
      <LayoutRow label="Card preview">
        <OptionSelect
          label="Card preview"
          value={cover}
          disabled={disabled}
          choices={[
            { value: "none", label: "None" },
            { value: PAGE_CONTENT, label: "Page content" },
            ...files.map((property) => ({ value: property.id as string, label: property.name })),
          ]}
          onChange={(value) =>
            editView({
              layout: {
                ...layout,
                cardPreview:
                  value === "none"
                    ? { kind: "none" }
                    : value === PAGE_CONTENT
                      ? { kind: "page_content" }
                      : { kind: "property", propertyId: SpacePropertyId.make(value) },
              },
            })
          }
        />
      </LayoutRow>
      <LayoutRow label="Card size">
        <OptionSelect
          label="Card size"
          value={layout.cardSize ?? "medium"}
          disabled={disabled}
          choices={SIZES}
          onChange={(cardSize) => editView({ layout: { ...layout, cardSize } })}
        />
      </LayoutRow>
      <LayoutRow label="Fit image">
        <Switch
          size="sm"
          aria-label="Fit image"
          checked={layout.fitImage === true}
          disabled={disabled || cover === "none"}
          onCheckedChange={(fitImage) => editView({ layout: { ...layout, fitImage } })}
        />
      </LayoutRow>
      <LayoutRow label="Wrap properties">
        <Switch
          size="sm"
          aria-label="Wrap properties"
          checked={layout.wrapProperties === true}
          disabled={disabled}
          onCheckedChange={(wrapProperties) => editView({ layout: { ...layout, wrapProperties } })}
        />
      </LayoutRow>
      <LayoutRow label="Color columns">
        <Switch
          size="sm"
          aria-label="Color columns"
          checked={layout.colorColumns === true}
          disabled={disabled}
          onCheckedChange={(colorColumns) => editView({ layout: { ...layout, colorColumns } })}
        />
      </LayoutRow>
      <LayoutRow label="Calculate">
        <OptionSelect
          label="Calculate property"
          value={calculated?.propertyId ?? "none"}
          disabled={disabled}
          choices={[
            { value: "none", label: "None" },
            ...calculable.map((property) => ({
              value: property.id as string,
              label: property.name,
            })),
          ]}
          onChange={(value) => {
            if (value === "none") return calculate(null, null);
            const type = dataSource.properties[value]?.type ?? "";
            const [first] = aggregatesFor(type);
            if (first !== undefined) calculate(value, first as SpaceAggregateFunction);
          }}
        />
      </LayoutRow>
      {calculated === undefined || functions.length === 0 ? null : (
        <LayoutRow label="Calculation">
          <OptionSelect
            label="Calculation"
            value={calculated.aggregate ?? null}
            disabled={disabled}
            choices={functions.map((fn) => ({ value: fn, label: label(fn) }))}
            onChange={(fn) => calculate(calculated.propertyId, fn as SpaceAggregateFunction)}
          />
        </LayoutRow>
      )}
    </>
  );
}
