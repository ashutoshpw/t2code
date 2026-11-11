import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { DebouncedInput } from "./DebouncedInput";
import { OptionSelect } from "./OptionSelect";
import { NUMBER_FORMATS, nextConfig, numberFormatLabel, type ConfigObject } from "./propertyConfig";

type NumberProperty = Extract<SpaceKnownDatabaseProperty, { type: "number" }>;
const CHOICES = NUMBER_FORMATS.map((value) => ({ value, label: numberFormatLabel(value) }));

export function NumberFormatSelect({
  known,
  disabled,
  onConfig,
}: {
  readonly known: NumberProperty;
  readonly disabled: boolean;
  readonly onConfig: (config: ConfigObject) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Number format</span>
        <OptionSelect
          label="Number format"
          value={known.config.format}
          choices={CHOICES}
          disabled={disabled}
          onChange={(format) => onConfig(nextConfig(known, { format }))}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Decimal places</span>
        <DebouncedInput
          type="number"
          label="Decimal places"
          disabled={disabled}
          value={known.config.decimals === undefined ? "" : String(known.config.decimals)}
          onCommit={(text) => {
            const decimals = Math.floor(Number(text));
            if (text.trim() === "") onConfig(nextConfig(known, { decimals: undefined }));
            else if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 10)
              onConfig(nextConfig(known, { decimals }));
          }}
        />
      </div>
    </div>
  );
}
