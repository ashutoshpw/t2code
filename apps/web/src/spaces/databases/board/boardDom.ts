import type { Collision, CollisionDetection, KeyboardCoordinateGetter } from "@dnd-kit/core";

import { insertionIndex } from "./boardDrag";

/** The column whose horizontal extent holds the dragged card's center; columns do not overlap. */
export const columnCollision: CollisionDetection = ({
  collisionRect,
  droppableRects,
  droppableContainers,
}) => {
  const center = collisionRect.left + collisionRect.width / 2;
  const found: Collision[] = [];
  for (const container of droppableContainers) {
    const rect = droppableRects.get(container.id);
    if (rect !== undefined && center >= rect.left && center <= rect.left + rect.width)
      found.push({ id: container.id });
  }
  return found;
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
  const columns = droppableContainers
    .getEnabled()
    .flatMap((container) => {
      const rect = droppableRects.get(container.id);
      return rect === undefined ? [] : [rect];
    })
    .sort((a, b) => a.left - b.left);
  const center = collisionRect.left + collisionRect.width / 2;
  const here = columns.findIndex((rect) => center >= rect.left && center <= rect.left + rect.width);
  const next = columns[here + (code === "ArrowLeft" ? -1 : 1)];
  if (here < 0 || next === undefined) return undefined;
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
