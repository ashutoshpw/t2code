import type { SpaceDatabaseProperty, SpacePropertyId } from "@t2code/contracts/spaces";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { PropertyTypeIcon } from "./PropertyTypeIcon";

export function PropertyPicker({
  properties,
  value,
  onChange,
  filter,
  disabledReason,
  placeholder = "Choose a property",
  label = "Property",
  disabled = false,
}: {
  readonly properties: ReadonlyArray<SpaceDatabaseProperty>;
  readonly value: SpacePropertyId | null;
  readonly onChange: (propertyId: SpacePropertyId) => void;
  readonly filter?: (property: SpaceDatabaseProperty) => boolean;
  /** A reason makes the property listed but not choosable. */
  readonly disabledReason?: (property: SpaceDatabaseProperty) => string | undefined;
  readonly placeholder?: string;
  readonly label?: string;
  readonly disabled?: boolean;
}) {
  const options = filter ? properties.filter(filter) : properties;
  const selected = properties.find((property) => property.id === value);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as SpacePropertyId);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>
          {selected ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <PropertyTypeIcon type={selected.type} />
              <span className="truncate">{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((property) => (
          <SelectItem
            key={property.id}
            value={property.id}
            disabled={disabledReason?.(property) !== undefined}
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5">
                <PropertyTypeIcon type={property.type} />
                {property.name}
              </span>
              <span className="text-xs text-muted-foreground empty:hidden">
                {disabledReason?.(property)}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
