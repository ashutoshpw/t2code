import { useState, type KeyboardEvent } from "react";
import type { SpaceDateValue } from "@t2code/contracts/spaces";

import { Calendar } from "~/components/ui/calendar";
import { Switch } from "~/components/ui/switch";
import type { CellEditorProps } from "./CellEditor";
import {
  buildDateValue,
  dateToDay,
  dayToDate,
  parseDateValue,
  parseTypedDay,
  type DateDraft,
} from "./dateValue";
import { EditorPopover } from "./EditorPopover";
import { useSettleOnce } from "./settle";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const FIELD =
  "h-7 min-w-0 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function DayField({
  label,
  day,
  onDay,
  autoFocus,
}: {
  readonly label: string;
  readonly day: string;
  readonly onDay: (day: string) => void;
  readonly autoFocus?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const apply = () => {
    const parsed = parseTypedDay(text ?? day);
    setText(null);
    if (parsed !== null && parsed !== day) onDay(parsed);
  };
  return (
    <input
      aria-label={label}
      placeholder="YYYY-MM-DD"
      autoFocus={autoFocus}
      value={text ?? day}
      className={`${FIELD} flex-1`}
      onChange={(event) => setText(event.target.value)}
      onBlur={apply}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        apply();
      }}
    />
  );
}

/** Calendar popover; every change writes at once, like the other multi-step editors. */
export function DateEditor(props: CellEditorProps) {
  const { known, value, onChange } = props;
  const [draft, setDraft] = useState<DateDraft>(() =>
    parseDateValue(value as SpaceDateValue | null | undefined),
  );
  const { commit, cancel } = useSettleOnce(props);

  const update = (next: DateDraft) => {
    setDraft(next);
    onChange?.(buildDateValue(next, viewerZone()));
  };
  const pickDay = (date: Date | undefined) => {
    if (date === undefined) return;
    const day = dateToDay(date);
    if (!draft.hasEnd) return update({ ...draft, startDate: day });
    if (draft.startDate === "" || draft.endDate !== "")
      return update({ ...draft, startDate: day, endDate: "" });
    update(day < draft.startDate ? { ...draft, startDate: day } : { ...draft, endDate: day });
  };

  const start = dayToDate(draft.startDate);
  const end = dayToDate(draft.endDate);
  const month = start === undefined ? {} : { defaultMonth: start };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  return (
    <EditorPopover label={known.name} width="auto" onClose={cancel}>
      <div className="flex w-full flex-col gap-2 p-2 text-sm" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-1.5">
          <DayField
            label="Start date"
            day={draft.startDate}
            autoFocus
            onDay={(day) => update({ ...draft, startDate: day })}
          />
          {draft.hasEnd ? (
            <DayField
              label="End date"
              day={draft.endDate}
              onDay={(day) => update({ ...draft, endDate: day })}
            />
          ) : null}
        </div>
        {draft.hasTime ? (
          <div className="flex items-center gap-1.5">
            <input
              type="time"
              aria-label="Start time"
              value={draft.startTime}
              className={`${FIELD} flex-1`}
              onChange={(event) => update({ ...draft, startTime: event.target.value })}
            />
            {draft.hasEnd ? (
              <input
                type="time"
                aria-label="End time"
                value={draft.endTime}
                className={`${FIELD} flex-1`}
                onChange={(event) => update({ ...draft, endTime: event.target.value })}
              />
            ) : null}
          </div>
        ) : null}
        {draft.hasEnd ? (
          <Calendar
            mode="range"
            selected={
              start === undefined
                ? undefined
                : { from: start, ...(end === undefined ? {} : { to: end }) }
            }
            {...month}
            onDayClick={pickDay}
          />
        ) : (
          <Calendar mode="single" selected={start} {...month} onSelect={pickDay} />
        )}
        <label className="flex items-center justify-between gap-2">
          <span>End date</span>
          <Switch
            size="sm"
            checked={draft.hasEnd}
            onCheckedChange={(checked) =>
              update({
                ...draft,
                hasEnd: checked,
                endDate: checked ? draft.endDate : "",
                endTime: checked ? draft.endTime : "",
              })
            }
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Include time</span>
          <Switch
            size="sm"
            checked={draft.hasTime}
            onCheckedChange={(checked) => update({ ...draft, hasTime: checked })}
          />
        </label>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-start text-muted-foreground hover:bg-accent"
          onClick={() => commit(null)}
        >
          Clear
        </button>
      </div>
    </EditorPopover>
  );
}
