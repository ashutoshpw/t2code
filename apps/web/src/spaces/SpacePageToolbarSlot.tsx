import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// undefined: no page header hosts the controls, so they render inline. null: the header's slot is not mounted yet.
const SpacePageToolbarSlot = createContext<HTMLElement | null | undefined>(undefined);

export const SpacePageToolbarSlotProvider = SpacePageToolbarSlot.Provider;

export function SpacePageToolbar({ children }: { children: ReactNode }) {
  const slot = useContext(SpacePageToolbarSlot);
  if (slot === undefined)
    return <div className="flex flex-wrap items-center justify-end gap-1">{children}</div>;
  return slot ? createPortal(children, slot) : null;
}
