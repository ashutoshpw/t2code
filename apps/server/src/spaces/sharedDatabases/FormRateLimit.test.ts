import { describe, expect, it } from "vite-plus/test";

import { makeRateLimiter } from "./FormRateLimit.ts";

describe("form rate limiter", () => {
  it("admits five a minute, then resets, and holds the hour cap across minutes", () => {
    const limiter = makeRateLimiter();
    const burst = (at: number) => Array.from({ length: 6 }, () => limiter.admit("a", at));
    expect(burst(0)).toEqual([true, true, true, true, true, false]);
    for (let minute = 1; minute < 12; minute++)
      expect(burst(minute * 61_000)).toEqual([true, true, true, true, true, false]);
    // Twelve minutes of five each is the hour's sixty; the next minute is open but the hour is not.
    expect(limiter.admit("a", 12 * 61_000)).toBe(false);
    expect(limiter.admit("a", 3_700_000)).toBe(true);
  });

  it("keeps keys independent", () => {
    const limiter = makeRateLimiter();
    for (let index = 0; index < 5; index++) limiter.admit("a", 0);
    expect(limiter.admit("a", 1)).toBe(false);
    expect(limiter.admit("b", 1)).toBe(true);
  });

  it("evicts an expired key first, otherwise the oldest, and never passes maxKeys", () => {
    const limiter = makeRateLimiter([{ ms: 1000, max: 1 }], 3);
    limiter.admit("old", 0);
    limiter.admit("b", 900);
    limiter.admit("c", 950);
    limiter.admit("d", 1100);
    expect(limiter.size()).toBe(3);
    expect(limiter.admit("b", 1200)).toBe(false);
    limiter.admit("e", 1150);
    expect(limiter.size()).toBe(3);
    expect(limiter.admit("b", 1200)).toBe(true);
    for (let index = 0; index < 20; index++) limiter.admit(`k${index}`, 1300);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
