import type { SpacePropertyType } from "@t2code/contracts/spaces";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { propertyTypeMeta } from "../primitives/propertyTypes";

export function PropertyTypeMenu({
  value,
  types,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly types: ReadonlyArray<SpacePropertyType>;
  readonly disabled: boolean;
  readonly onChange: (type: SpacePropertyType) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as SpacePropertyType);
      }}
    >
      <SelectTrigger size="compact" aria-label="Property type">
        <SelectValue>
          <span className="flex items-center gap-1.5">
            <PropertyTypeIcon type={value} />
            {propertyTypeMeta(value).label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {types.map((type) => (
          <SelectItem key={type} value={type}>
            <span className="flex items-center gap-1.5">
              <PropertyTypeIcon type={type} />
              {propertyTypeMeta(type).label}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
