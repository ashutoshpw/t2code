import type { ReactNode } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export interface SelectChoice<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

/** A labelled single select over a fixed list; the trigger shows the chosen label. */
export function OptionSelect<Value extends string>({
  value,
  choices,
  onChange,
  label,
  disabled = false,
  placeholder = "Choose",
}: {
  readonly value: Value | null;
  readonly choices: ReadonlyArray<SelectChoice<Value>>;
  readonly onChange: (value: Value) => void;
  readonly label: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}) {
  const selected = choices.find((choice) => choice.value === value);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as Value);
      }}
    >
      <SelectTrigger size="compact" aria-label={label}>
        <SelectValue>
          {selected ? (
            <span className="truncate">{selected.label}</span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value} disabled={choice.disabled}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
