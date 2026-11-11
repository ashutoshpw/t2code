export const POSITION_GAP = 65_536;

export const appendPosition = (max: number | null) =>
  max === null ? POSITION_GAP : max + POSITION_GAP;

/**
 * `count` distinct positions strictly between `previous` and `next` (null for the end of the
 * list), or null when the gap is exhausted and the list must be renumbered first.
 */
export function positionsBetween(previous: number, next: number | null, count: number) {
  if (next === null)
    return Array.from({ length: count }, (_, i) => previous + POSITION_GAP * (i + 1));
  const step = Math.floor((next - previous) / (count + 1));
  return step < 1 ? null : Array.from({ length: count }, (_, i) => previous + step * (i + 1));
}

interface Positioned {
  readonly id: string;
  readonly position: number;
}

/**
 * Orders `moving` (in the given order) immediately before `beforeId`, or at the end. Returns the
 * new position of every item whose position changes; renumbers the whole list when a gap is full.
 */
export function placeInList(
  items: readonly Positioned[],
  moving: readonly string[],
  beforeId: string | null,
): ReadonlyMap<string, number> | undefined {
  const stay = items.filter((item) => !moving.includes(item.id));
  const index = beforeId === null ? stay.length : stay.findIndex((item) => item.id === beforeId);
  if (index < 0) return undefined;
  const previous = index === 0 ? 0 : stay[index - 1]!.position;
  const next = index >= stay.length ? null : stay[index]!.position;
  const direct = positionsBetween(previous, next, moving.length);
  if (direct) return new Map(moving.map((id, i) => [id, direct[i]!]));
  const order = [
    ...stay.slice(0, index).map((i) => i.id),
    ...moving,
    ...stay.slice(index).map((i) => i.id),
  ];
  return new Map(order.map((id, i) => [id, (i + 1) * POSITION_GAP]));
}
