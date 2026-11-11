import { clampWidth } from "./gridWindow";

/** A CSS variable name for a column width; property ids may hold characters a name cannot. */
export const columnVar = (propertyId: string) =>
  `--col-${propertyId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export const widthValue = (propertyId: string) => `var(${columnVar(propertyId)})`;

/** The width after dragging `delta` pixels from `start`, within the column limits. */
export const draggedWidth = (start: number, delta: number) => clampWidth(start + delta);
