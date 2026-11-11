/**
 * The full property order after moving one visible column: hidden columns and the title keep their
 * slots, and the visible non-title columns take the new order in the slots visible columns held.
 */
export function reorderedPropertyIds(
  all: ReadonlyArray<{ readonly id: string; readonly visible: boolean }>,
  movedId: string,
  overId: string,
): ReadonlyArray<string> {
  const slots = all.filter((column) => column.visible && column.id !== "title");
  const from = slots.findIndex((column) => column.id === movedId);
  const to = slots.findIndex((column) => column.id === overId);
  if (from < 0 || to < 0 || from === to) return all.map((column) => column.id);
  const moved = slots.slice();
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item!);
  let next = 0;
  return all.map((column) =>
    column.visible && column.id !== "title" ? moved[next++]!.id : column.id,
  );
}
