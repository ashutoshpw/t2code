import { useRef } from "react";
import type { SpaceCellValue } from "@t2code/contracts/spaces";

/** An editor reports one outcome per close: blur after Enter or Escape must not report twice. */
export function useSettleOnce(handlers: {
  readonly onCommit: (
    value: SpaceCellValue | null,
    move?: "right" | "left",
    reason?: "blur",
  ) => void;
  readonly onClose: () => void;
}) {
  const settled = useRef(false);
  return {
    commit: (value: SpaceCellValue | null, move?: "right" | "left", reason?: "blur") => {
      if (settled.current) return;
      settled.current = true;
      handlers.onCommit(value, move, reason);
    },
    cancel: () => {
      if (settled.current) return;
      settled.current = true;
      handlers.onClose();
    },
  };
}
