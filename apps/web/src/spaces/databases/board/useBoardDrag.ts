import type { DragEndEvent, DragMoveEvent, DragStartEvent } from "@dnd-kit/core";
import { canonicalJson, type RowPlacement } from "@t2code/client-runtime/spaces";
import * as Schema from "effect/Schema";
import { useRef, useState, type RefObject } from "react";
import {
  SpaceKnownGroupKey,
  type SpaceCellValue,
  type SpaceDatabaseView,
  type SpaceKnownGroup,
  type SpaceGroupBucket,
  type SpaceGroupKey,
  type SpaceKnownDatabaseProperty,
  type SpacePageId,
  type SpacePropertyId,
} from "@t2code/contracts/spaces";

import type { DatabaseActions } from "../data/actions";
import { columnElement, locateDrop, markDrop } from "./boardDom";
import { planCardDrop, planColumnMove } from "./boardDrag";

export type ActiveDrag =
  | { readonly kind: "card"; readonly pageId: string; readonly group: SpaceGroupKey }
  | { readonly kind: "column"; readonly text: string; readonly color: string | undefined };

export interface BoardDragModel {
  readonly root: RefObject<HTMLElement | null>;
  readonly view: SpaceDatabaseView;
  readonly group: SpaceKnownGroup | undefined;
  readonly property: SpacePropertyId;
  readonly known: SpaceKnownDatabaseProperty | null;
  readonly shown: ReadonlyArray<SpaceGroupBucket>;
  readonly hidden: ReadonlyArray<SpaceGroupBucket>;
  readonly canCards: boolean;
  readonly canViews: boolean;
  readonly actions: Pick<DatabaseActions, "editCell" | "moveRows" | "flushCells" | "editView">;
  hold(): () => void;
  setPlacement(pageId: string, placement: RowPlacement | undefined): void;
}

const isKnownKey = Schema.is(SpaceKnownGroupKey);

const centerOf = (event: Pick<DragEndEvent, "active">) => {
  const rect = event.active.rect.current.translated;
  return rect === null ? null : rect.top + rect.height / 2;
};

/**
 * Drag handlers of the board: a card drop writes the group cell (and the order, in a view without
 * sorts); a column drop writes `group.order`. The query session is held from pick-up until the
 * writes are acknowledged, so a refresh cannot move cards under the pointer.
 */
export function useBoardDrag(model: BoardDragModel) {
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const ref = useRef<{ release: (() => void) | null; marked: HTMLElement | null }>({
    release: null,
    marked: null,
  });

  const clearMark = () => {
    ref.current.marked = markDrop(ref.current.marked, null);
  };
  const finish = () => {
    clearMark();
    setActive(null);
  };

  const onDragStart = ({ active: item }: DragStartEvent) => {
    const data = item.data.current;
    if (data?.type === "card") {
      ref.current.release?.();
      ref.current.release = model.hold();
      setActive({ kind: "card", pageId: data.pageId, group: data.group });
    } else if (data?.type === "column") {
      setActive({ kind: "column", text: data.labelText, color: data.labelColor });
    }
  };

  const onDragMove = (event: DragMoveEvent) => {
    const data = event.active.data.current;
    const over = event.over?.data.current;
    const y = centerOf(event);
    const column =
      event.over === null ? null : columnElement(model.root.current!, columnIdOf(event.over.id));
    if (
      data?.type !== "card" ||
      over?.type !== "column" ||
      over.hidden ||
      column === null ||
      y === null
    )
      return void clearMark();
    const { cards, index } = locateDrop(column, y, data.pageId);
    // Past the last card the line goes under it; an empty column shows only its ring.
    ref.current.marked =
      cards[index] !== undefined
        ? markDrop(ref.current.marked, cards[index])
        : markDrop(ref.current.marked, cards.at(-1) ?? null, "after");
  };

  const dropCard = (event: DragEndEvent) => {
    const data = event.active.data.current!;
    const over = event.over!.data.current!;
    const { known, property, actions, view } = model;
    const pageId = data.pageId as SpacePageId;
    const from = data.group as SpaceGroupKey;
    const to = over.key as SpaceGroupKey;
    if (known === null) return false;
    const column = columnElement(model.root.current!, canonicalJson(to));
    const y = centerOf(event);
    let beforeRowId: string | null = null;
    if (over.hidden !== true && column !== null && y !== null) {
      const { cards, index } = locateDrop(column, y, pageId);
      beforeRowId = cards[index]?.dataset.cardId ?? null;
    }
    const source = model.shown
      .concat(model.hidden)
      .find((bucket) => canonicalJson(bucket.key) === canonicalJson(from))
      ?.rows.find((row) => row.page.id === pageId);
    const plan = planCardDrop({
      cardId: pageId,
      value: source?.cells[property],
      from,
      to,
      beforeRowId: over.hidden === true ? pageId : beforeRowId,
      view,
      known,
    });
    if (plan === null) return false;
    const jobs: Promise<unknown>[] = [];
    if (plan.cell !== undefined) {
      actions.editCell(pageId, property, plan.cell as SpaceCellValue | null);
      jobs.push(actions.flushCells());
    }
    const move = over.hidden === true ? undefined : plan.move;
    if (move !== undefined) {
      jobs.push(actions.moveRows([pageId], move.beforeRowId as SpacePageId | null));
      model.setPlacement(pageId, { group: to, beforeRowId: move.beforeRowId });
    }
    const release = ref.current.release;
    ref.current.release = null;
    void Promise.allSettled(jobs).then((results) => {
      if (results.some((result) => result.status === "rejected"))
        model.setPlacement(pageId, undefined);
      release?.();
    });
    return true;
  };

  const moveColumn = (event: DragEndEvent) => {
    const from = event.active.data.current!.key as SpaceGroupKey;
    const to = event.over!.data.current!.key as SpaceGroupKey;
    const order = planColumnMove(
      model.shown.map((bucket) => bucket.key),
      from,
      to,
    );
    if (order === null || model.group === undefined) return;
    model.actions.editView({
      group: {
        ...model.group,
        sort: "manual",
        order: [...order, ...model.hidden.map((bucket) => bucket.key)].filter(isKnownKey),
      },
    });
  };

  const onDragEnd = (event: DragEndEvent) => {
    const data = event.active.data.current;
    const over = event.over?.data.current;
    let wrote = false;
    if (data?.type === "card" && over?.type === "column" && model.canCards) wrote = dropCard(event);
    else if (
      data?.type === "column" &&
      over?.type === "column" &&
      over.hidden !== true &&
      model.canViews
    )
      moveColumn(event);
    if (!wrote) {
      ref.current.release?.();
      ref.current.release = null;
    }
    finish();
  };

  const onDragCancel = () => {
    ref.current.release?.();
    ref.current.release = null;
    finish();
  };

  return { active, onDragStart, onDragMove, onDragEnd, onDragCancel };
}

const columnIdOf = (id: string | number) => String(id).replace(/^drop:/, "");
