import { describe, expect, it } from "vite-plus/test";

import { SPACE_PAGE_ICONS, normalizeSpacePageIcon } from "./pageIcon.ts";

describe("normalizeSpacePageIcon", () => {
  it("accepts one emoji, including sequences", () => {
    expect(normalizeSpacePageIcon(" 🚀 ")).toBe("🚀");
    expect(normalizeSpacePageIcon("👨‍👩‍👧")).toBe("👨‍👩‍👧");
    expect(normalizeSpacePageIcon("🇯🇵")).toBe("🇯🇵");
  });

  it("rejects empty, text and multiple emoji", () => {
    for (const input of ["", "  ", "a", "ab", "🚀🔥", "🚀 x"])
      expect(normalizeSpacePageIcon(input)).toBeNull();
  });

  it("accepts every curated icon", () => {
    for (const icon of SPACE_PAGE_ICONS) expect(normalizeSpacePageIcon(icon)).toBe(icon);
  });
});
