interface FitInput {
  /** Measured width of each tab, in view order. */
  readonly widths: ReadonlyArray<number>;
  readonly available: number;
  readonly gap: number;
  /** Width of the "N more…" button. */
  readonly moreWidth: number;
  /** -1 when no tab is active. */
  readonly activeIndex: number;
}

/** Which tabs show in the strip and which go to the overflow list; the active tab always shows, last when it was hidden. */
export function fitTabs({ widths, available, gap, moreWidth, activeIndex }: FitInput) {
  const count = widths.length;
  const all = widths.map((_, index) => index);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, count - 1);
  if (total <= available) return { visible: all, hidden: [] as number[] };
  const budget = available - moreWidth - gap;
  const visible: number[] = [];
  let used = 0;
  for (const [index, width] of widths.entries()) {
    const next = used + width + (visible.length > 0 ? gap : 0);
    if (next > budget) break;
    visible.push(index);
    used = next;
  }
  const active = activeIndex >= 0 && activeIndex < count ? activeIndex : -1;
  if (active >= 0 && !visible.includes(active)) {
    const need = (widths[active] ?? 0) + gap;
    while (visible.length > 0 && used + need > budget) {
      const dropped = visible.pop()!;
      used -= (widths[dropped] ?? 0) + (visible.length > 0 ? gap : 0);
    }
    visible.push(active);
  }
  if (visible.length === 0) visible.push(active >= 0 ? active : 0);
  const shown = new Set(visible);
  return { visible, hidden: all.filter((index) => !shown.has(index)) };
}

/** Views whose name contains the query, ignoring case, in their given order. */
export function matchViews<T extends { readonly name: string }>(
  views: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  return needle === "" ? views : views.filter((view) => view.name.toLowerCase().includes(needle));
}
