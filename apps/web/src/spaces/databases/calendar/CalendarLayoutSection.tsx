import { Switch } from "~/components/ui/switch";
import type { LayoutSectionProps } from "../shell/layoutSection";
import { OptionSelect } from "../controls/OptionSelect";
import { PropertyPicker } from "../primitives/PropertyPicker";
import type { CalendarMode, WeekStart } from "./calendarRange";
import { dateProperties } from "./dateProperties";

/** Layout rows of a calendar view: the date property, the range, the week start and weekends. */
export function CalendarLayoutSection({
  known,
  dataSource,
  editView,
  disabled,
}: LayoutSectionProps) {
  if (known?.type !== "calendar") return null;
  const layout = known.layout;
  const change = (patch: Record<string, unknown>) => editView({ layout: { ...layout, ...patch } });
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Calendar layout">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Show calendar by</span>
        <PropertyPicker
          properties={dateProperties(dataSource)}
          value={layout.datePropertyId}
          label="Show calendar by"
          disabled={disabled}
          onChange={(datePropertyId) => change({ datePropertyId })}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Show by</span>
        <OptionSelect<CalendarMode>
          label="Calendar range"
          value={layout.mode ?? "month"}
          disabled={disabled}
          choices={[
            { value: "month", label: "Month" },
            { value: "week", label: "Week" },
          ]}
          onChange={(mode) => change({ mode })}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Week starts on</span>
        <OptionSelect<WeekStart>
          label="Week starts on"
          value={layout.weekStart ?? "sunday"}
          disabled={disabled}
          choices={[
            { value: "sunday", label: "Sunday" },
            { value: "monday", label: "Monday" },
          ]}
          onChange={(weekStart) => change({ weekStart })}
        />
      </div>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Show weekends</span>
        <Switch
          size="sm"
          checked={layout.showWeekends ?? true}
          disabled={disabled}
          onCheckedChange={(showWeekends) => change({ showWeekends })}
        />
      </label>
    </div>
  );
}
