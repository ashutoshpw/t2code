import { useState } from "react";

/** Enter or blur commits, Escape cancels. */
export function RenameInput({
  value,
  label,
  onCommit,
  onCancel,
}: {
  readonly value: string;
  readonly label: string;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [done, setDone] = useState(false);
  const finish = (commit: boolean) => {
    if (done) return;
    setDone(true);
    if (commit && draft.trim() !== "" && draft !== value) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      ref={(element) => element?.select()}
      aria-label={label}
      className="h-6 w-28 rounded-sm border bg-background px-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}
