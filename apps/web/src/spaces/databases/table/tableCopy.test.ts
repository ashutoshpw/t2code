import { expect, it } from "vite-plus/test";
import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";

import { cellCopyText } from "./tableCopy";

const context = { relatedPages: {}, optionHint: () => undefined, timeZone: "UTC" };
const known = (type: string, config: unknown = {}) =>
  ({ id: type, name: type, type, config, position: 0 }) as unknown as SpaceKnownDatabaseProperty;

it("copies dates as ISO days, numbers raw and the rest as plain text", () => {
  expect(cellCopyText({ start: "2026-01-02", end: "2026-01-05" }, known("date"), context)).toBe(
    "2026-01-02 → 2026-01-05",
  );
  expect(cellCopyText({ start: "2026-01-02" }, known("date"), context)).toBe("2026-01-02");
  expect(cellCopyText(1234.5, known("number", { format: "dollar" }), context)).toBe("1234.5");
  expect(cellCopyText("hello", known("title"), context)).toBe("hello");
  expect(cellCopyText(undefined, known("title"), context)).toBe("");
  expect(cellCopyText("x", null, context)).toBe("");
});
