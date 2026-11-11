import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { OptionSelect } from "./OptionSelect";
import { nextConfig, type ConfigObject } from "./propertyConfig";

type DateProperty = Extract<
  SpaceKnownDatabaseProperty,
  { type: "date" | "created_time" | "last_edited_time" }
>;

const DATE_FORMATS = [
  { value: "full", label: "Full date" },
  { value: "short", label: "Short date" },
  { value: "mdy", label: "Month/Day/Year" },
  { value: "dmy", label: "Day/Month/Year" },
  { value: "ymd", label: "Year/Month/Day" },
  { value: "relative", label: "Relative" },
] as const;
const TIME_FORMATS = [
  { value: "12h", label: "12 hour" },
  { value: "24h", label: "24 hour" },
  { value: "hidden", label: "Hidden" },
] as const;

export function DateFormatFields({
  known,
  disabled,
  onConfig,
}: {
  readonly known: DateProperty;
  readonly disabled: boolean;
  readonly onConfig: (config: ConfigObject) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Date format</span>
        <OptionSelect
          label="Date format"
          value={known.config.dateFormat ?? "full"}
          choices={DATE_FORMATS}
          disabled={disabled}
          onChange={(dateFormat) => onConfig(nextConfig(known, { dateFormat }))}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Time format</span>
        <OptionSelect
          label="Time format"
          value={known.config.timeFormat ?? "12h"}
          choices={TIME_FORMATS}
          disabled={disabled}
          onChange={(timeFormat) => onConfig(nextConfig(known, { timeFormat }))}
        />
      </div>
    </div>
  );
}
