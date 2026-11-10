import { describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const imports = `import { thing } from "../apps/server/src/thing.ts";\nexport const value = thing;\n`;

describe("t2code/no-workspace-imports-in-scripts-tests", () => {
  const fresh = createOxlintRuleHarness("t2code/no-workspace-imports-in-scripts-tests", {
    filename: "scripts/new-feature.test.mjs",
  });
  fresh.invalid("reports a relative import of apps/*", imports);
  fresh.invalid(
    "reports a relative import of packages/*",
    `import { x } from "../packages/shared/src/x.ts";\nexport { x };\n`,
  );
  fresh.valid(
    "allows imports of scripts helpers and packages by name",
    `import { x } from "./lib/x.ts";\nimport { y } from "@t2code/shared/y";\nexport { x, y };\n`,
  );

  createOxlintRuleHarness("t2code/no-workspace-imports-in-scripts-tests", {
    filename: "apps/server/src/thing.test.ts",
  }).valid("only applies to tests directly under scripts/", imports);
});
