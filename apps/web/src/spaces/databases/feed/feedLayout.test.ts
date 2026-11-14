import { describe, expect, it } from "vite-plus/test";

import { cardHeight, FEED_GAP, feedPlan } from "./feedLayout";

describe("feedPlan", () => {
  it.each([
    [0, 88],
    [1, 136],
    [3, 216],
  ])("a card with %i preview blocks is %i px tall", (blocks, height) => {
    expect(cardHeight(blocks)).toBe(height);
  });

  it("stacks cards with a gap and totals to the last card's bottom", () => {
    const plan = feedPlan(3, 3);
    expect(plan.offsets).toEqual([0, 216 + FEED_GAP, 2 * (216 + FEED_GAP)]);
    expect(plan.total).toBe(plan.offsets[2]! + 216);
  });

  it("is empty without rows", () => {
    expect(feedPlan(0, 1)).toMatchObject({ offsets: [], total: 0 });
  });
});
