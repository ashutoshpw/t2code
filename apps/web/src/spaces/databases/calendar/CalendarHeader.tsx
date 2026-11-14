import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { CalendarMode } from "./calendarRange";

const monthLabel = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const utc = (day: string) => new Date(`${day}T00:00:00Z`);

export function periodTitle(anchor: string, mode: CalendarMode, firstDay: string, lastDay: string) {
  return mode === "month"
    ? monthLabel.format(utc(anchor))
    : `${dayLabel.format(utc(firstDay))} – ${dayLabel.format(utc(lastDay))}`;
}

export function CalendarHeader({
  title,
  mode,
  canChangeMode,
  onStep,
  onToday,
  onMode,
  trailing,
}: {
  readonly title: string;
  readonly mode: CalendarMode;
  readonly canChangeMode: boolean;
  readonly onStep: (direction: -1 | 1) => void;
  readonly onToday: () => void;
  readonly onMode: (mode: CalendarMode) => void;
  readonly trailing: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <h3 aria-live="polite" className="me-1 text-sm font-medium">
        {title}
      </h3>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={mode === "month" ? "Previous month" : "Previous week"}
        onClick={() => onStep(-1)}
      >
        <ChevronLeftIcon />
      </Button>
      <Button size="xs" variant="outline" onClick={onToday}>
        Today
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={mode === "month" ? "Next month" : "Next week"}
        onClick={() => onStep(1)}
      >
        <ChevronRightIcon />
      </Button>
      <div role="group" aria-label="Calendar range" className="flex items-center gap-0.5">
        {(["month", "week"] as const).map((entry) => (
          <Button
            key={entry}
            size="xs"
            variant={mode === entry ? "secondary" : "ghost"}
            aria-pressed={mode === entry}
            disabled={!canChangeMode}
            onClick={() => onMode(entry)}
          >
            {entry === "month" ? "Month" : "Week"}
          </Button>
        ))}
      </div>
      <div className="ms-auto flex items-center gap-1.5">{trailing}</div>
    </div>
  );
}
