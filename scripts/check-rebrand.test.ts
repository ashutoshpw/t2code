import { describe, expect, it } from "vite-plus/test";

import { findViolations } from "./check-rebrand.ts";

const EMPTY_BASELINE = new Set<string>();

const LEGACY_USER_DATA_LINE = `const legacyUserDataDirName = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";`;
const REAL_BASELINE = new Set<string>([
  `apps/desktop/src/app/DesktopEnvironment.ts\u0000${LEGACY_USER_DATA_LINE}`,
]);

describe("check-rebrand", () => {
  it("flags T3 Code copy on added lines", () => {
    const violations = findViolations(
      [{ file: "apps/web/src/example.ts", line: `const TITLE = "T3 Code";` }],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-copy"]);
  });

  it("flags T3Code only outside URLs, owners, and identifiers", () => {
    const entries = [
      { file: "packages/shared/src/example.ts", line: `const NAME = "T3Code";` },
      {
        file: "packages/shared/src/example.ts",
        line: `normalizeGitRemoteUrl("git@github.com:T3Tools/T3Code.git")`,
      },
      { file: "infra/relay/alchemy.run.ts", line: `const relay = "T3CodeRelay";` },
    ];
    expect(findViolations(entries, EMPTY_BASELINE).map((v) => v.line)).toEqual([
      `const NAME = "T3Code";`,
    ]);
  });

  it("flags the upstream CLI scope", () => {
    const violations = findViolations(
      [{ file: "apps/web/src/example.ts", line: `import cli from "@t3code/cli";` }],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-cli-scope"]);
  });

  it("flags the upstream internal package scope", () => {
    const violations = findViolations(
      [
        { file: "apps/web/src/example.ts", line: `import { Overview } from "@t3tools/contracts";` },
        {
          file: "packages/shared/src/example.ts",
          line: `import { hostProcess } from "@t3tools/shared/hostProcess";`,
        },
        { file: "apps/web/src/example.ts", line: `appId: "com.t3tools.t3code"` },
        { file: "apps/web/src/example.ts", line: `git@github.com:T3Tools/T3Code.git` },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3tools-scope", "t3tools-scope"]);
  });

  it("flags the upstream port including separator literals", () => {
    const violations = findViolations(
      [
        { file: "apps/server/src/example.ts", line: `const PORT = 3773;` },
        { file: "apps/server/src/example.test.ts", line: `assert.equal(offset, 13_773)` },
        { file: "apps/server/src/example.ts", line: `const PORT = 3772;` },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-port", "t3-port"]);
  });

  it("flags every quoted legacy scheme line, including dual registrations", () => {
    const violations = findViolations(
      [
        { file: "apps/desktop/src/app/NewWindow.ts", line: `scheme: "t3code",` },
        {
          file: "apps/desktop/src/electron/ElectronProtocol.ts",
          line: `export const DESKTOP_PRODUCTION_SCHEME = "t3code";`,
        },
        {
          file: "scripts/build-desktop-artifact.ts",
          line: `schemes: ["t2code", "t2code-dev", "t3code", "t3code-dev"],`,
        },
        { file: "apps/mobile/src/example.test.ts", line: `title: "t3code",` },
      ],
      EMPTY_BASELINE,
    );
    expect(violations).toHaveLength(3);
    expect(new Set(violations.map((v) => v.rule.id))).toEqual(new Set(["t3-scheme"]));
  });

  it("flags the legacy preview scheme except storage partition names", () => {
    const violations = findViolations(
      [
        { file: "apps/mobile/src/App.tsx", line: `"t3code-preview://",` },
        {
          file: "apps/desktop/src/preview/Partition.ts",
          line: `partition: "persist:t3code-preview-abc123",`,
        },
        { file: "apps/web/src/example.ts", line: `scheme: "t3code-preview"` },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.file)).toEqual([
      "apps/mobile/src/App.tsx",
      "apps/web/src/example.ts",
    ]);
  });

  it("honors baseline entries for known legacy-compat strings", () => {
    const entries = [
      { file: "apps/desktop/src/app/DesktopEnvironment.ts", line: LEGACY_USER_DATA_LINE },
    ];
    expect(findViolations(entries, REAL_BASELINE)).toEqual([]);
    expect(findViolations(entries, EMPTY_BASELINE).map((v) => v.rule.id)).toEqual(["t3-copy"]);
  });

  it("exempts fork tooling describing upstream and upstream-owned modules", () => {
    const violations = findViolations(
      [
        {
          file: ".agents/skills/rebase-with-upstream/SKILL.md",
          line: "onto upstream T3 Code (pingdotgg/t3code)",
        },
        {
          file: "apps/mobile/modules/t3-terminal/T3TerminalNative.podspec",
          line: `s.summary = "T3 Code terminal"`,
        },
      ],
      EMPTY_BASELINE,
    );
    expect(violations).toEqual([]);
  });
});
