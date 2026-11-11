import { canonicalJson, cellForGroupKey } from "@t2code/client-runtime/spaces";
import {
  SpaceKnownGroupKey,
  type SpaceCellValue,
  type SpaceDatabaseView,
  type SpaceGroupKey,
  type SpaceKnownDatabaseProperty,
} from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";

const isKnownKey = Schema.is(SpaceKnownGroupKey);

export interface CardDropPlan {
  /** The new value of the group property; null clears it. Absent when the cell stays. */
  readonly cell?: SpaceCellValue | null;
  /** Reorders within the data source; only without sorts, where manual order is what shows. */
  readonly move?: { readonly beforeRowId: string | null };
}

/** Whether a card can be dropped into, or created in, this bucket. */
export function canWriteGroup(
  key: SpaceGroupKey,
  known: SpaceKnownDatabaseProperty | null,
): boolean {
  return known !== null && isKnownKey(key) && cellForGroupKey(key, known) !== undefined;
}

/**
 * What a card dropped in `to` writes. `value` is the card's current group cell (multi-select
 * drops edit the list instead of replacing it). Null when the bucket cannot take the card.
 */
export function planCardDrop(input: {
  readonly cardId: string;
  readonly value: SpaceCellValue | undefined;
  readonly from: SpaceGroupKey;
  readonly to: SpaceGroupKey;
  readonly beforeRowId: string | null;
  readonly view: Pick<SpaceDatabaseView, "sorts">;
  readonly known: SpaceKnownDatabaseProperty;
}): CardDropPlan | null {
  const { cardId, from, to, known, beforeRowId } = input;
  const ordered = input.view.sorts.length === 0 && beforeRowId !== cardId;
  const move = ordered ? { move: { beforeRowId } } : {};
  if (canonicalJson(from) === canonicalJson(to)) return ordered ? { move: { beforeRowId } } : {};
  if (!isKnownKey(to)) return null;
  if (known.type === "multi_select") {
    const current = Array.isArray(input.value)
      ? input.value.filter((entry): entry is string => typeof entry === "string")
      : [];
    const without = from.kind === "option" ? current.filter((id) => id !== from.optionId) : current;
    if (to.kind === "empty") return { cell: without.length === 0 ? null : without, ...move };
    if (to.kind !== "option") return null;
    const next = without.includes(to.optionId) ? without : [...without, to.optionId];
    return { cell: next, ...move };
  }
  const cell = cellForGroupKey(to, known);
  return cell === undefined ? null : { cell, ...move };
}

/** The new `group.order`: `active` takes the place of `over`; the empty bucket never moves. */
export function planColumnMove(
  keys: ReadonlyArray<SpaceGroupKey>,
  active: SpaceGroupKey,
  over: SpaceGroupKey,
): ReadonlyArray<SpaceGroupKey> | null {
  const ids = keys
    .filter((key) => key.kind !== "empty")
    .map((key) => [canonicalJson(key), key] as const);
  const from = ids.findIndex(([id]) => id === canonicalJson(active));
  if (from < 0) return null;
  const target = over.kind === "empty" ? 0 : ids.findIndex(([id]) => id === canonicalJson(over));
  if (target < 0 || target === from) return null;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved!);
  return next.map(([, key]) => key);
}

/**
 * The card a dropped card lands before: the first card of the column whose middle is below
 * `y`, or null for the end. `mids` are the cards' vertical midpoints in order.
 */
export function insertionIndex(mids: ReadonlyArray<number>, y: number): number {
  const index = mids.findIndex((mid) => y < mid);
  return index < 0 ? mids.length : index;
}
