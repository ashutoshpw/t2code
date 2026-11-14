import { describe, expect, it } from "vite-plus/test";

import { fitTabs, matchViews } from "./viewTabs.logic";

const fitted = (widths: number[], available: number, activeIndex = 0) =>
  fitTabs({ widths, available, gap: 2, moreWidth: 40, activeIndex });

describe("fitTabs", () => {
  it("shows every tab that fits", () => {
    expect(fitted([50, 50, 50], 154)).toEqual({ visible: [0, 1, 2], hidden: [] });
  });

  it("shows the prefix that fits beside the more button", () => {
    expect(fitted([50, 50, 50, 50], 150)).toEqual({ visible: [0, 1], hidden: [2, 3] });
  });

  it("shows a hidden active tab last, dropping tabs from the end to make room", () => {
    expect(fitted([50, 50, 50, 50], 150, 3)).toEqual({ visible: [0, 3], hidden: [1, 2] });
  });

  it("keeps only the active tab when nothing else fits", () => {
    expect(fitted([80, 80, 80], 100, 2)).toEqual({ visible: [2], hidden: [0, 1] });
  });

  it("falls back to the first tab without an active one, even when it does not fit", () => {
    expect(fitted([80, 80], 60, -1)).toEqual({ visible: [0], hidden: [1] });
  });

  it("handles no tabs", () => {
    expect(fitted([], 100, -1)).toEqual({ visible: [], hidden: [] });
  });
});

describe("matchViews", () => {
  const views = [{ name: "All tasks" }, { name: "Board" }, { name: "Tasks by owner" }];
  it("matches names case-insensitively in input order", () => {
    expect(matchViews(views, "TASK").map((view) => view.name)).toEqual([
      "All tasks",
      "Tasks by owner",
    ]);
    expect(matchViews(views, "  ")).toBe(views);
  });
});
