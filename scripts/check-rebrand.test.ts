import { describe, expect, it } from "vite-plus/test";

import { findViolations } from "./check-rebrand.ts";

const EMPTY_BASELINE = new Set<string>();

const LEGACY_USER_DATA_LINE = `const legacyUserDataDirName = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";`;
const REAL_BASELINE = new Set<string>([
  `apps/desktop/src/app/DesktopEnvironment.ts\u0000${LEGACY_USER_DATA_LINE}`,
]);

describe("check-rebrand", () => {
  it("rejects old Connect display copy while preserving compatibility identifiers", () => {
    const violations = findViolations(
      [
        { file: "apps/web/src/example.tsx", line: "<h2>T3 Connect</h2>" },
        { file: "apps/mobile/src/example.tsx", line: 'title: "T3 Connect"' },
        {
          file: "packages/client-runtime/src/example.ts",
          line: 'message: "Sign in to T3 Connect"',
        },
        { file: "docs/user/remote-access.md", line: "## T3 Connect" },
        { file: "apps/web/src/example.tsx", line: "<h2>T2 Connect</h2>" },
        {
          file: "apps/web/src/example.tsx",
          line: 'import { T3ConnectUserProfilePage } from "./T3ConnectUserProfilePage";',
        },
        {
          file: "packages/shared/src/example.ts",
          line: 'const tokenType = "t3-link-challenge+jwt";',
        },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(Array(4).fill("t3-connect-copy"));
  });

  it("rejects Connect copy outside the client surfaces too", () => {
    const violations = findViolations(
      [
        { file: "packages/contracts/src/relay.ts", line: "// T3 Connect relay link" },
        { file: "AGENTS.md", line: "leaning in fully with T3 Connect" },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-connect-copy", "t3-connect-copy"]);
  });

  it("flags the invented @t3 package scope", () => {
    const violations = findViolations(
      [{ file: "apps/web/src/example.ts", line: `import { x } from "@t3/util";` }],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-scope"]);
  });

  it("flags T3-named paths once per file, including binary assets", () => {
    const violations = findViolations(
      [
        { file: "apps/web/src/components/T3Sidebar.tsx", line: "export function T3Sidebar()" },
        {
          file: "apps/web/src/components/T3Sidebar.tsx",
          line: "export const T3SidebarProps = {};",
        },
        { file: "apps/marketing/public/t3-hero.png", line: "" },
        { file: "packages/shared/src/bit31-ordering.ts", line: "const order = 31;" },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.filter((v) => v.rule.id === "t3-named-path").map((v) => v.file)).toEqual([
      "apps/web/src/components/T3Sidebar.tsx",
      "apps/marketing/public/t3-hero.png",
    ]);
  });

  it("honors baseline path entries and exempt dirs for t3-named paths", () => {
    const entries = [
      { file: "apps/server/scripts/t3-sqlite-state.ts", line: "const x = 1;" },
      { file: "apps/mobile/modules/t2-terminal/T3TerminalModule.swift", line: "let x = 1" },
    ];
    const baseline = new Set<string>(["apps/server/scripts/t3-sqlite-state.ts\u0000"]);
    expect(findViolations(entries, baseline)).toEqual([]);
    expect(
      findViolations(entries, EMPTY_BASELINE)
        .filter((v) => v.rule.id === "t3-named-path")
        .map((v) => v.file),
    ).toEqual(["apps/server/scripts/t3-sqlite-state.ts"]);
  });

  it("flags retired wordmark and widget mark references without matching similar module names", () => {
    const violations = findViolations(
      [
        {
          file: "apps/web/src/components/SidebarChrome.tsx",
          line: `import { T3Wordmark } from "../T3Wordmark";`,
        },
        {
          file: "apps/mobile/src/widgets/AgentActivity.tsx",
          line: `<Image assetName="T3Mark" modifiers={[resizable()]} />`,
        },
        {
          file: "packages/shared/src/example.ts",
          line: `import T3MarkdownText from "./T3MarkdownText";`,
        },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-wordmark-ref", "t3-mark-ref"]);
  });

  it("flags the bare legacy wordmark accessibility labels only", () => {
    const violations = findViolations(
      [
        { file: "apps/web/src/example.tsx", line: `<svg aria-label="T3" />` },
        { file: "apps/mobile/src/example.tsx", line: `<Svg accessibilityLabel='T3' />` },
        { file: "apps/web/src/example.tsx", line: `<svg aria-label="T3 badge" />` },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-wordmark-label", "t3-wordmark-label"]);
  });

  it("flags the retired wordmark path fingerprint without matching a different path", () => {
    const violations = findViolations(
      [
        {
          file: "assets/prod/logo.svg",
          line: `<path d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509 M86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44" />`,
        },
        {
          file: "assets/prod/t2-logo.svg",
          line: `<path d="M33.4509 93V47.56H15.5309V37H64.3309 M65.3653 93.96V86.04" />`,
        },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(["t3-wordmark-path"]);
  });

  it("leaves compatibility values and guard fixtures outside the narrow rules", () => {
    const entries = [
      { file: "apps/server/src/runtime.ts", line: `const protocolName = "T3";` },
      { file: "scripts/check-rebrand.ts", line: `const guarded = "T3Wordmark";` },
      { file: "scripts/check-rebrand.test.ts", line: `const fixture = "T3Mark";` },
    ];
    expect(findViolations(entries, EMPTY_BASELINE)).toEqual([]);
  });

  it("flags the upstream root project file", () => {
    const violations = findViolations(
      [
        { file: "t3.json", line: "{" },
        { file: "t3.json", line: '  \"scripts\": []' },
      ],
      EMPTY_BASELINE,
    );

    expect(violations.map((v) => v.rule.id)).toEqual(["t3-project-file"]);
  });

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
      [{ file: "apps/web/src/example.ts", line: `import cli from "@t2code/cli";` }],
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
        { file: "apps/web/src/example.ts", line: `appId: "com.t2tools.t2code"` },
        { file: "apps/web/src/example.ts", line: `git@github.com:T3Tools/T3Code.git` },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual([
      "t3tools-scope",
      "t3tools-scope",
      "t3tools-brand",
    ]);
  });

  it("flags repository-owned t3tools metadata while retaining upstream repository fixtures", () => {
    const violations = findViolations(
      [
        { file: "apps/mobile/src/example.ts", line: `const homepage = "https://t3tools.com";` },
        { file: "apps/web/src/example.ts", line: `namespace: "t3tools-composer-editor"` },
        {
          file: "packages/shared/src/git.test.ts",
          line: `git@github.com:T3Tools/T3Code.git`,
        },
        {
          file: "apps/web/src/example.ts",
          line: `const metadata = "https://github.com/t3tools/t3code (com.t2tools.t2code)";`,
        },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual([
      "t3tools-brand",
      "t3tools-brand",
      "t3tools-brand",
    ]);
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
          file: "apps/mobile/modules/t2-terminal/T3TerminalNative.podspec",
          line: `s.summary = "T3 Code terminal"`,
        },
      ],
      EMPTY_BASELINE,
    );
    expect(violations).toEqual([]);
  });

  it("flags legacy env names outside the compat surfaces", () => {
    const violations = findViolations(
      [
        { file: "apps/server/src/cli/config.ts", line: 'Config.string("T3CODE_HOME")' },
        { file: "packages/ssh/src/tunnel.ts", line: "T3_ARCHIVE_VERSION=@@T3_ARCHIVE_VERSION@@" },
        { file: "apps/web/src/example.ts", line: "process.env.T3_RELEASE_BASE_URL" },
      ],
      EMPTY_BASELINE,
    );
    expect(violations.map((v) => v.rule.id)).toEqual(Array(3).fill("t2-env-name"));
  });

  it("allows retained T3 identifiers that are not env vars", () => {
    const violations = findViolations(
      [
        {
          file: "packages/shared/src/themePalettes.ts",
          line: "export const T3_CHAT_THEME: ThemeDefinition = {",
        },
        {
          file: "apps/web/src/pierre-icons.ts",
          line: "export const T3_FILE_ICON_SPRITE = `...`;",
        },
        {
          file: "packages/client-runtime/src/work-log/presentation.ts",
          line: "const T3_MCP_TOOL_LABELS: Record<string, Labels> = {",
        },
        {
          file: "apps/web/src/themePalette.ts",
          line: 'const LEGACY_T3_CHAT_DARK_THEME_ID = "t3-chat-dark";',
        },
      ],
      EMPTY_BASELINE,
    );
    expect(violations).toEqual([]);
  });

  it("honors baseline entries for legacy env fallback lines", () => {
    const legacyFallbackLine = '["T2CODE_HOME", firstSet("T2CODE_HOME", "T3CODE_HOME")],';
    const entries = [
      { file: "apps/desktop/scripts/electron-launcher.mjs", line: legacyFallbackLine },
    ];
    expect(findViolations(entries, EMPTY_BASELINE).map((v) => v.rule.id)).toEqual(["t2-env-name"]);
    expect(
      findViolations(
        entries,
        new Set([`apps/desktop/scripts/electron-launcher.mjs\u0000${legacyFallbackLine}`]),
      ),
    ).toEqual([]);
  });
});
