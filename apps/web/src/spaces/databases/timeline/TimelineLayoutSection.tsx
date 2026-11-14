import { Switch } from "~/components/ui/switch";
import type { LayoutSectionProps } from "../shell/layoutSection";
import { dateProperties } from "../calendar/dateProperties";
import { OptionSelect } from "../controls/OptionSelect";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { DEFAULT_ZOOM, ZOOMS, type Zoom } from "./timelineScale";

const LABELS: Record<Zoom, string> = {
  hours: "Hours",
  day: "Day",
  week: "Week",
  biweek: "Bi-week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};

/** Layout rows of a timeline: start and end properties, zoom and the table pane. */
export function TimelineLayoutSection({
  known,
  dataSource,
  editView,
  disabled,
}: LayoutSectionProps) {
  if (known?.type !== "timeline") return null;
  const layout = known.layout;
  const change = (patch: Record<string, unknown>) => editView({ layout: { ...layout, ...patch } });
  const properties = dateProperties(dataSource);
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Timeline layout">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Start date</span>
        <PropertyPicker
          properties={properties}
          value={layout.startPropertyId}
          label="Start date"
          disabled={disabled}
          onChange={(startPropertyId) => change({ startPropertyId })}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>End date</span>
        <div className="flex items-center gap-1">
          <PropertyPicker
            properties={properties.filter((property) => property.id !== layout.startPropertyId)}
            value={layout.endPropertyId ?? null}
            label="End date"
            placeholder="None"
            disabled={disabled}
            onChange={(endPropertyId) => change({ endPropertyId })}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Zoom</span>
        <OptionSelect<Zoom>
          label="Zoom level"
          value={layout.zoom ?? DEFAULT_ZOOM}
          disabled={disabled}
          choices={ZOOMS.map((value) => ({ value, label: LABELS[value] }))}
          onChange={(zoom) => change({ zoom })}
        />
      </div>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Show table</span>
        <Switch
          size="sm"
          checked={layout.showTable ?? true}
          disabled={disabled}
          onCheckedChange={(showTable) => change({ showTable })}
        />
      </label>
    </div>
  );
}
