import { describe, expect, it } from "vite-plus/test";
import type { SpaceDatabaseColor } from "@t2code/contracts/spaces";

import { nextOptionColor } from "./optionColor.ts";

describe("nextOptionColor", () => {
  it("walks the palette without repeats and wraps", () => {
    const used: SpaceDatabaseColor[] = [];
    const picked = new Set<string>();
    for (let i = 0; i < 9; i++) {
      const color = nextOptionColor(used);
      picked.add(color);
      used.push(color);
    }
    expect(picked.size).toBe(9);
    expect(nextOptionColor(used)).toBe("gray");
  });
});
