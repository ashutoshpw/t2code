import type { ClipboardEvent, KeyboardEvent } from "react";

import type { GridEditStore } from "./gridEditStore";
import type { GridHandlers } from "./tableTypes";

const NAVIGATION = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
// Page-level shortcuts that must never reach the document while a cell has focus.
const SWALLOWED = /^[zZaAbBiIuU]$/;

const isTextTarget = (element: HTMLElement) =>
  element.matches("input, textarea, select") || element.isContentEditable;

/** The grid cell an event came from; null for anything else inside or outside the grid. */
export function cellOf(event: { currentTarget: Element; target: EventTarget }) {
  const target = event.target as HTMLElement;
  if (!event.currentTarget.contains(target) || target.getAttribute("role") !== "gridcell")
    return null;
  const { row, col } = target.dataset;
  return row === undefined || col === undefined ? null : { pageId: row, propertyId: col };
}

/** The row menu hangs on the title cell's trigger; a keyboard user reaches it from any cell of the row. */
function openRowMenu(grid: Element, pageId: string) {
  grid
    .querySelector<HTMLElement>(
      `[data-row="${CSS.escape(pageId)}"][data-col="title"] [aria-label="Row actions"]`,
    )
    ?.click();
}

export function handleGridKeyDown(
  event: KeyboardEvent<HTMLElement>,
  grid: GridHandlers,
  store: GridEditStore,
): void {
  const target = event.target as HTMLElement;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && SWALLOWED.test(event.key) && !isTextTarget(target)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const cell = cellOf(event);
  if (cell === null) return;
  const { pageId, propertyId } = cell;
  // The keydown that begins an IME composition opens the editor empty and lets the IME proceed.
  if (event.nativeEvent.isComposing || event.keyCode === 229) {
    grid.activate(pageId, propertyId);
    return;
  }
  const handled = () => {
    event.preventDefault();
    event.stopPropagation();
  };
  if (event.key === "Escape") {
    handled();
    store.park();
    event.currentTarget.focus();
  } else if (event.key === "Tab") {
    const moved = grid.navigate(cell, { key: "Tab", shift: event.shiftKey });
    if (moved) handled();
    // Shift+Tab out of the first cell lands on the grid root, which must not pull focus back in.
    else if (event.shiftKey) store.park();
  } else if (
    propertyId === "title" &&
    !mod &&
    !event.shiftKey &&
    (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
    grid.toggleRow(pageId, event.key === "ArrowRight")
  ) {
    handled();
  } else if (NAVIGATION.has(event.key)) {
    handled();
    grid.navigate(cell, { key: event.key, shift: event.shiftKey, mod });
  } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    handled();
    openRowMenu(event.currentTarget, pageId);
  } else if (event.key === "Enter" && mod) {
    handled();
    grid.open(pageId);
  } else if (event.key === "Enter" || event.key === "F2" || event.key === " ") {
    handled();
    grid.activate(pageId, propertyId);
  } else if (event.key === "Backspace" || event.key === "Delete") {
    handled();
    grid.clear(pageId, propertyId);
  } else if (event.key.length === 1 && !mod && !event.altKey) {
    handled();
    grid.activate(pageId, propertyId, event.key);
  }
}

export function handleGridCopy(event: ClipboardEvent<HTMLElement>, grid: GridHandlers): void {
  const cell = cellOf(event);
  if (cell === null) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", grid.copyText(cell.pageId, cell.propertyId));
}

export function handleGridPaste(event: ClipboardEvent<HTMLElement>, grid: GridHandlers): void {
  const cell = cellOf(event);
  if (cell === null) return;
  event.preventDefault();
  grid.pasteText(cell.pageId, cell.propertyId, event.clipboardData.getData("text/plain"));
}
