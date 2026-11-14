import { useState, type FocusEvent, type KeyboardEvent, type ReactNode, type UIEvent } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import type { DatabaseLayout } from "../blocks/DatabaseBlockHost";
import { itemAt, rowRange, sameRange } from "../table/gridWindow";

const NEAR_END_ITEMS = 6;
const INITIAL_SIZE = { w: 960, h: 600 };

export interface WindowPlan {
  readonly offsets: ReadonlyArray<number>;
  readonly total: number;
}

/** Items that take focus with the arrow keys carry `data-nav`; the item index is on the item. */
const NAV = "[data-nav]";

/**
 * A vertical scroller that mounts only the items near the viewport. The plan depends on the
 * width (a gallery re-flows), so it is built here from the measured width.
 */
export function WindowScroller<Plan extends WindowPlan>({
  plan,
  render,
  label,
  busy,
  pageLayout,
  onNearEnd,
  below,
}: {
  readonly plan: (width: number) => Plan;
  readonly render: (index: number, plan: Plan, width: number) => ReactNode;
  readonly label: string;
  readonly busy: boolean;
  readonly pageLayout: DatabaseLayout;
  readonly onNearEnd: () => void;
  readonly below: ReactNode;
}) {
  const [size, setSize] = useState(INITIAL_SIZE);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [attach] = useState(() => (element: HTMLDivElement | null) => {
    if (element === null) return;
    const measure = () =>
      setSize((previous) =>
        previous.w === element.clientWidth && previous.h === element.clientHeight
          ? previous
          : { w: element.clientWidth, h: element.clientHeight },
      );
    measure();
    return observeResize(element, measure);
  });

  const current = plan(size.w);
  const range = rowRange(current.offsets, current.total, scrollTop, size.h);
  const indices: number[] = [];
  for (let index = range.first; index < range.last; index += 1) indices.push(index);
  if (focusIndex !== null && focusIndex < current.offsets.length) {
    if (focusIndex < range.first) indices.unshift(focusIndex);
    else if (focusIndex >= range.last) indices.push(focusIndex);
  }

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop: top, clientHeight } = event.currentTarget;
    const next = rowRange(current.offsets, current.total, top, clientHeight);
    if (!sameRange(next, range)) setScrollTop(top);
    const lastVisible = itemAt(current.offsets, Math.min(current.total, top + clientHeight));
    if (current.offsets.length - 1 - lastVisible <= NEAR_END_ITEMS) onNearEnd();
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const holder = (event.target as HTMLElement).closest<HTMLElement>("[data-item-index]");
    const index = holder === null ? null : Number(holder.dataset.itemIndex);
    setFocusIndex((previous) => (previous === index ? previous : index));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || !target.matches(NAV)) return;
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>(NAV)];
    const next = all[all.indexOf(target) + (event.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div
      ref={attach}
      aria-busy={busy}
      className={cn(
        "relative overflow-y-auto overscroll-contain rounded-lg border bg-background",
        pageLayout === "page" ? "h-[calc(100dvh-15rem)] min-h-80" : "max-h-[min(36rem,70vh)]",
      )}
      onScroll={onScroll}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      <div role="list" aria-label={label} className="relative" style={{ height: current.total }}>
        {indices.map((index) => render(index, current, size.w))}
      </div>
      {below}
    </div>
  );
}
