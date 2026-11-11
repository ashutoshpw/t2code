import type { ViewColumn } from "@t2code/client-runtime/spaces";
import type { SpaceCardPreview } from "@t2code/contracts/spaces";

/** Marks these properties visible so the query returns them even when the view hides them. */
export function withForcedColumns(
  columns: ReadonlyArray<ViewColumn>,
  ids: ReadonlyArray<string>,
): ReadonlyArray<ViewColumn> {
  if (
    ids.length === 0 ||
    columns.every((column) => column.visible || !ids.includes(column.property.id))
  )
    return columns;
  return columns.map((column) =>
    !column.visible && ids.includes(column.property.id) ? { ...column, visible: true } : column,
  );
}

/** The files property a card cover reads, when it still exists and holds files. */
export function coverPropertyId(
  preview: SpaceCardPreview | undefined,
  columns: ReadonlyArray<ViewColumn>,
): string | null {
  if (preview?.kind !== "property") return null;
  const column = columns.find((entry) => entry.property.id === preview.propertyId);
  return column?.known?.type === "files" ? column.property.id : null;
}
