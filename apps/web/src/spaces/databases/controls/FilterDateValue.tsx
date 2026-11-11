import { SPACE_RELATIVE_DATES } from "@t2code/contracts/spaces";
import { CalendarIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Calendar } from "~/components/ui/calendar";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { DebouncedInput } from "./DebouncedInput";
import { RELATIVE_DATE_LABELS, WITHIN_DIRECTION_LABELS, WITHIN_UNIT_LABELS } from "./filterLabels";
import { OptionSelect, type SelectChoice } from "./OptionSelect";

type Relative = (typeof SPACE_RELATIVE_DATES)[number];
type Direction = keyof typeof WITHIN_DIRECTION_LABELS;
type Unit = keyof typeof WITHIN_UNIT_LABELS;
const EXACT = "exact";

const DATE_CHOICES: ReadonlyArray<SelectChoice<string>> = [
  ...SPACE_RELATIVE_DATES.map((value) => ({ value, label: RELATIVE_DATE_LABELS[value] })),
  { value: EXACT, label: "Exact date" },
];
const DIRECTIONS = (Object.keys(WITHIN_DIRECTION_LABELS) as Direction[]).map((value) => ({
  value,
  label: WITHIN_DIRECTION_LABELS[value],
}));

const toDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDay = (value: string): Date | undefined => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
};
const today = () => toDay(new Date());

function Within({
  value,
  onChange,
  disabled,
}: {
  readonly value: { direction?: unknown; unit?: unknown; count?: unknown };
  readonly onChange: (value: { direction: Direction; unit: Unit; count?: number }) => void;
  readonly disabled: boolean;
}) {
  const direction: Direction =
    value.direction === "next" || value.direction === "this" ? value.direction : "past";
  const unit: Unit =
    value.unit === "day" || value.unit === "month" || value.unit === "year" ? value.unit : "week";
  const count = typeof value.count === "number" ? value.count : 1;
  const emit = (next: { direction?: Direction; unit?: Unit; count?: number }) => {
    const nextDirection = next.direction ?? direction;
    const nextCount = next.count ?? count;
    onChange({
      direction: nextDirection,
      unit: next.unit ?? unit,
      ...(nextDirection === "this" || nextCount === 1 ? {} : { count: nextCount }),
    });
  };
  return (
    <div className="flex items-center gap-1">
      <OptionSelect
        label="Direction"
        value={direction}
        choices={DIRECTIONS}
        disabled={disabled}
        onChange={(next) => emit({ direction: next })}
      />
      {direction === "this" ? null : (
        <DebouncedInput
          type="number"
          label="Count"
          disabled={disabled}
          value={String(count)}
          onCommit={(next) => {
            const parsed = Math.floor(Number(next));
            if (Number.isFinite(parsed) && parsed >= 1) emit({ count: parsed });
          }}
        />
      )}
      <OptionSelect
        label="Unit"
        value={unit}
        choices={(Object.keys(WITHIN_UNIT_LABELS) as Unit[]).map((key) => ({
          value: key,
          label: WITHIN_UNIT_LABELS[key],
        }))}
        disabled={disabled}
        onChange={(next) => emit({ unit: next })}
      />
    </div>
  );
}

/** The operand of a date operator: a relative day, an exact day, or a `within` window. */
export function FilterDateValue({
  operator,
  value,
  onChange,
  disabled,
}: {
  readonly operator: string;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly disabled: boolean;
}) {
  if (operator === "within")
    return (
      <Within
        value={typeof value === "object" && value !== null ? value : {}}
        onChange={onChange}
        disabled={disabled}
      />
    );
  const relative =
    typeof value === "object" && value !== null && "relative" in value
      ? (value.relative as Relative)
      : null;
  const exact = typeof value === "string" ? value : null;
  const day = exact === null ? undefined : parseDay(exact);
  return (
    <div className="flex items-center gap-1">
      <OptionSelect
        label="Date"
        value={relative ?? EXACT}
        choices={DATE_CHOICES}
        disabled={disabled}
        onChange={(next) => onChange(next === EXACT ? today() : { relative: next })}
      />
      {exact === null ? null : (
        <Popover>
          <PopoverTrigger
            render={
              <Button variant="outline" size="xs" disabled={disabled} aria-label="Pick a date" />
            }
          >
            <CalendarIcon />
            {exact}
          </PopoverTrigger>
          <PopoverPopup align="start" padding="compact">
            <Calendar
              mode="single"
              {...(day === undefined ? {} : { selected: day, defaultMonth: day })}
              onSelect={(date) => {
                if (date) onChange(toDay(date));
              }}
            />
          </PopoverPopup>
        </Popover>
      )}
    </div>
  );
}
