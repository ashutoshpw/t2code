import { useRef, useState } from "react";

import { Input } from "~/components/ui/input";

const COMMIT_DELAY_MS = 400;

/** Commits 400 ms after the last key and on blur. The timer starts in the handler, not an effect. */
export function DebouncedInput({
  value,
  onCommit,
  label,
  type = "text",
  disabled = false,
  placeholder,
}: {
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly label: string;
  readonly type?: "text" | "number";
  readonly disabled?: boolean;
  readonly placeholder?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <Input
      type={type}
      size="compact"
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      value={draft ?? value}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        cancel();
        timer.current = setTimeout(() => {
          timer.current = null;
          onCommit(next);
        }, COMMIT_DELAY_MS);
      }}
      onBlur={() => {
        if (timer.current !== null) {
          cancel();
          if (draft !== null) onCommit(draft);
        }
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
      }}
    />
  );
}
