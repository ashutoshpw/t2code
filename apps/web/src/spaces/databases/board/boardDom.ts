import type { Collision, CollisionDetection, KeyboardCoordinateGetter } from "@dnd-kit/core";

import { insertionIndex } from "./boardDrag";

/** The column whose horizontal extent holds the dragged card's center; columns do not overlap. */
export const columnCollision: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
}) => {
  const center = collisionRect.left + collisionRect.width / 2;
  const middle = collisionRect.top + collisionRect.height / 2;
  const found: Collision[] = [];
  const inside: Collision[] = [];
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (rect === undefined || center < rect.left || center > rect.left + rect.width) continue;
    found.push({ id: container.id });
    if (middle >= rect.top && middle <= rect.top + rect.height) inside.push({ id: container.id });
  }
  // Sub-group lanes stack the same column several times: the cell under the card wins.
  return found.length > 1 && inside.length > 0 ? inside : found;
};

const STEP = 8;

/** Arrow Left and Right jump a whole column; Up and Down move by one card height. */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context: { collisionRect, droppableRects, droppableContainers } },
) => {
  if (collisionRect === null) return undefined;
  const code = event.code;
  if (code === "ArrowUp" || code === "ArrowDown") {
    event.preventDefault();
    const step = collisionRect.height + STEP;
    return {
      x: currentCoordinates.x,
      y: currentCoordinates.y + (code === "ArrowUp" ? -step : step),
    };
  }
  if (code !== "ArrowLeft" && code !== "ArrowRight") return undefined;
  event.preventDefault();
  const rects = droppableContainers.getEnabled().flatMap((container) => {
    const rect = droppableRects.get(container.id);
    return rect === undefined ? [] : [rect];
  });
  const center = collisionRect.left + collisionRect.width / 2;
  const middle = collisionRect.top + collisionRect.height / 2;
  const horizontal = rects.filter(
    (rect) => center >= rect.left && center <= rect.left + rect.width,
  );
  const here =
    horizontal.find((rect) => middle >= rect.top && middle <= rect.top + rect.height) ??
    horizontal[0];
  if (here === undefined) return undefined;
  const beyond = rects.filter((rect) =>
    code === "ArrowLeft" ? rect.left < here.left - 1 : rect.left > here.left + 1,
  );
  if (beyond.length === 0) return undefined;
  const nearest = beyond.reduce((best, rect) =>
    Math.abs(rect.left - here.left) < Math.abs(best.left - here.left) ? rect : best,
  );
  // Sub-group lanes stack the same column; keep to the lane the card is in.
  const sameColumn = beyond.filter((rect) => Math.abs(rect.left - nearest.left) <= 1);
  const next = sameColumn.reduce((best, rect) => {
    const distance = (box: typeof rect) =>
      middle < box.top
        ? box.top - middle
        : middle > box.top + box.height
          ? middle - box.top - box.height
          : 0;
    return distance(rect) < distance(best) ? rect : best;
  });
  return {
    x: next.left + (next.width - collisionRect.width) / 2,
    y: Math.min(
      Math.max(currentCoordinates.y, next.top),
      next.top + Math.max(0, next.height - collisionRect.height),
    ),
  };
};

export interface DropTarget {
  readonly cards: ReadonlyArray<HTMLElement>;
  readonly index: number;
}

/** Where a card held at vertical center `y` would land in the column element, ignoring `skip`. */
export function locateDrop(column: Element, y: number, skip: string): DropTarget {
  const cards = [...column.querySelectorAll<HTMLElement>("[data-card-id]")].filter(
    (card) => card.dataset.cardId !== skip,
  );
  const mids = cards.map((card) => {
    const rect = card.getBoundingClientRect();
    return rect.top + rect.height / 2;
  });
  return { cards, index: insertionIndex(mids, y) };
}

/** The element carrying the drop line, so only it is written while dragging. */
export function markDrop(
  previous: HTMLElement | null,
  target: HTMLElement | null,
  side: "before" | "after" = "before",
): HTMLElement | null {
  const attribute = `data-drop-${side}`;
  if (previous === target && target?.hasAttribute(attribute) !== false) return target;
  previous?.removeAttribute("data-drop-before");
  previous?.removeAttribute("data-drop-after");
  target?.setAttribute(attribute, "");
  return target;
}

export function columnElement(root: ParentNode, columnId: string): Element | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-column-id]"))
    if (element.dataset.columnId === columnId) return element;
  return null;
}
