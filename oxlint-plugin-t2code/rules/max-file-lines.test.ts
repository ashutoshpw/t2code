import { describe } from "@effect/vitest";

import grandfathered from "../grandfathered.json" with { type: "json" };
import { createOxlintRuleHarness } from "../test/utils.ts";

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `export const a${i} = ${i};`).join("\n");

describe("t2code/max-file-lines", () => {
  const source = createOxlintRuleHarness("t2code/max-file-lines", {
    filename: "apps/server/src/NewService.ts",
  });
  source.valid("allows a source file at the limit", lines(800));
  source.invalid("reports a source file past the limit", lines(801));

  const test = createOxlintRuleHarness("t2code/max-file-lines", {
    filename: "apps/server/src/NewService.test.ts",
  });
  test.valid("allows a test file between the source and test limits", lines(1500));
  test.invalid("reports a test file past the test limit", lines(2001));

  createOxlintRuleHarness("t2code/max-file-lines", {
    filename: grandfathered.maxLines[0]!,
  }).valid("skips a grandfathered file", lines(801));
});
