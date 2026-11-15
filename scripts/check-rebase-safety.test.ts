// @effect-diagnostics nodeBuiltinImport:off - builds throwaway git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  compareMigrationChains,
  findOrphans,
  grownT3Files,
  importedNames,
  isOrphanCandidate,
  loweredBudgets,
  lostPinnedLines,
  lostWorkflowFacts,
  missedUpstreamWorkflowFacts,
  resetToUpstreamFiles,
  normalizeRename,
  parseBudget,
  parseMigrationEntries,
  parseRegisteredCommands,
  parseRpcGroup,
  parseTestTitles,
  parseWorkflowFacts,
  shrunkCommits,
  significantLines,
  substantiveAddedLines,
  unlistedLedgerFiles,
} from "./rebase-safety-parsers.ts";
import { takeSnapshot, verifySnapshot } from "./check-rebase-safety.ts";

describe("check-rebase-safety parsers", () => {
  it("counts only added lines that are not rename-normalised copies of removed ones", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      '-const name = "t3code";',
      '+const name = "t2code";',
      "+const fork = 1;",
      "+",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "-removed",
    ].join("\n");
    expect(substantiveAddedLines(diff)).toEqual({ "a.ts": 1 });
    expect(normalizeRename("@t2code/shared T3 t3code")).toBe("@t2code/shared T2 t2code");
  });

  it("reads registered seams and test titles", () => {
    expect(parseMigrationEntries('  [74, "Foo", Migration0074],\n  [75, "Bar", M75]')).toEqual([
      [74, "Foo"],
      [75, "Bar"],
    ]);
    expect(
      parseRegisteredCommands(
        'import { execCommand } from "./exec.ts";\nconst cli = Command.withSubcommands([execCommand, authCommand]);',
      ),
    ).toEqual(["authCommand", "execCommand"]);
    expect(parseRegisteredCommands('import { lostCommand } from "./lost.ts";\n')).toEqual([]);
    expect(
      parseRpcGroup("const A = 1;\nexport const G = RpcGroup.make(WsOneRpc, WsTwoRpc);"),
    ).toEqual(["WsOneRpc", "WsTwoRpc"]);
    expect(
      parseTestTitles('it.effect("keeps t3 things", () => {});\ntest("plain", () => {});'),
    ).toEqual(["keeps t2 things", "plain"]);
  });

  it("flags an unimported fork source file but not entrypoints or platform variants", () => {
    const candidates = [
      "apps/server/src/cli/exec.ts",
      "apps/server/src/cli/lost.ts",
      "apps/mobile/src/native/Editor.android.tsx",
      "apps/web/src/routes/page.tsx",
    ].filter(isOrphanCandidate);
    const imported = importedNames(["./exec.ts", "../native/Editor", "@t2code/shared/Net"]);
    expect(findOrphans(candidates, imported)).toEqual(["apps/server/src/cli/lost.ts"]);
  });

  it("requires main-chain migrations to match upstream ids and names", () => {
    const upstream = [
      [73, "A"],
      [74, "B"],
    ] as const;
    expect(compareMigrationChains(upstream, upstream)).toEqual([]);
    expect(
      compareMigrationChains(
        [
          [73, "A"],
          [74, "ForkOnly"],
          [75, "B"],
        ],
        upstream,
      ),
    ).toEqual(['migration id 74 is "ForkOnly" in the fork but "B" upstream']);
  });
});

const WORKFLOW = `name: Release
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  preflight:
    runs-on: ubuntu-24.04
    steps:
      - name: Checkout
        uses: actions/checkout@v6
  test_web:
    needs: [preflight, build]
    if: >-
      \${{ !cancelled() &&
      github.repository == 't3code' }}
    runs-on: blacksmith-4vcpu-ubuntu-2404
    strategy:
      fail-fast: false
      matrix:
        shard: [1/2, 2/2]
    steps:
      - uses: actions/setup-node@v6
      - id: run
        name: Run web tests
        run: vp test
`;

describe("check-rebase-safety structure checks", () => {
  it("reads jobs, needs, if, runs-on, matrix keys, step names and triggers from a workflow", () => {
    expect(parseWorkflowFacts(WORKFLOW)).toEqual(
      [
        "on:schedule",
        "job:preflight",
        "job:preflight|runs-on:ubuntu-24.04",
        "job:preflight|step:Checkout",
        "job:test_web",
        "job:test_web|needs:preflight",
        "job:test_web|needs:build",
        "job:test_web|if:${{ !cancelled() && github.repository == 't2code' }}",
        "job:test_web|runs-on:blacksmith-4vcpu-ubuntu-2404",
        "job:test_web|strategy:fail-fast",
        "job:test_web|matrix:shard",
        "job:test_web|uses:actions/setup-node@v6",
        "job:test_web|step:Run web tests",
      ].toSorted(),
    );
  });

  it.each([
    {
      name: "a fork-added matrix key that disappeared",
      fork: ["job:t|matrix:shard"],
      base: [],
      upstream: ["job:t"],
      now: ["job:t"],
      lost: ["job:t|matrix:shard"],
    },
    {
      name: "a fact both fork and upstream have that the result lost",
      fork: ["job:t|step:Build"],
      base: ["job:t|step:Build"],
      upstream: ["job:t|step:Build"],
      now: ["job:t"],
      lost: ["job:t|step:Build"],
    },
    {
      name: "a step upstream removed",
      fork: ["job:t|step:Old"],
      base: ["job:t|step:Old"],
      upstream: ["job:t"],
      now: ["job:t"],
      lost: [],
    },
    {
      name: "a fork if that upstream also changed",
      fork: ["job:t|if:fork"],
      base: ["job:t|if:old"],
      upstream: ["job:t|if:new"],
      now: ["job:t|if:new"],
      lost: [],
      superseded: ["job:t|if:fork"],
    },
    {
      name: "a fork runs-on label that the result swapped for upstream's",
      fork: ["job:t|runs-on:ubuntu-24.04"],
      base: ["job:t|runs-on:blacksmith-4vcpu"],
      upstream: ["job:t|runs-on:blacksmith-8vcpu"],
      now: ["job:t|runs-on:blacksmith-8vcpu"],
      lost: ["job:t|runs-on:ubuntu-24.04"],
    },
    {
      name: "a fork job whose base job upstream deleted",
      fork: ["job:t|step:Fork"],
      base: ["job:t"],
      upstream: [],
      now: [],
      lost: [],
      superseded: ["job:t|step:Fork"],
    },
  ])("workflow facts: $name", ({ fork, base, upstream, now, lost, superseded }) => {
    const result = lostWorkflowFacts(fork, base, upstream, now);
    expect(result.lost).toEqual(lost);
    expect(result.superseded).toEqual(superseded ?? []);
  });

  it("flags upstream-added workflow facts the result lacks, except blacksmith ones", () => {
    expect(
      missedUpstreamWorkflowFacts(
        ["job:t", "job:t|step:Old"],
        [
          "job:t",
          "job:t|step:Old",
          "job:t|matrix:shard",
          "job:t|runs-on:blacksmith-4vcpu",
          "job:t|uses:useblacksmith/cache@v1",
          "job:t|if:github.repository == 'pingdotgg/t2code'",
          "job:gone|if:x",
        ],
        ["job:t", "job:t|if:github.repository == 'ashutoshpw/t2code'"],
      ),
    ).toEqual(["job:t|matrix:shard"]);
  });

  it("flags a file whose fork delta fell to zero while upstream changed it", () => {
    expect(
      resetToUpstreamFiles(
        { "a.ts": 10, "b.ts": 5, "c.ts": 4, "d.ts": 3 },
        { "b.ts": 2 },
        new Set(["a.ts", "b.ts", "d.ts"]),
        new Set(["a.ts", "b.ts", "c.ts"]),
      ),
    ).toEqual(["a.ts: 10 -> 0"]);
  });

  it("flags lowered budgets, lost pinned lines, grown T3 text, shrunk commits and unlisted migrations", () => {
    const budget = (value: number) => parseBudget(`{"mcpToolListJsonBytes": ${value}, "x": "s"}`);
    expect(loweredBudgets(budget(95), budget(48), budget(48), budget(48))).toEqual([
      "mcpToolListJsonBytes: 95 -> 48",
    ]);
    expect(loweredBudgets(budget(95), budget(48), budget(48), budget(96))).toEqual([]);
    expect(loweredBudgets(budget(95), budget(48), budget(90), budget(90))).toEqual([]);
    expect(loweredBudgets(budget(95), budget(48), budget(48), {})).toEqual([
      "mcpToolListJsonBytes: 95 -> missing",
    ]);

    const pinned = significantLines("# note\n  unenv: 2.0.0\n  x\n", true);
    expect([...pinned]).toEqual(["unenv: 2.0.0"]);
    expect(
      lostPinnedLines(["unenv: 2.0.0", "keep: 1.0.0"], new Set(), new Set(["keep: 1.0.0"])),
    ).toEqual(["unenv: 2.0.0"]);

    expect(grownT3Files({ "a.md": 1, "b.md": 2 }, { "a.md": 1, "b.md": 3, "c.md": 1 })).toEqual([
      "b.md: 2 -> 3",
      "c.md: 0 -> 1",
    ]);

    const commit = { subject: "feat", added: [], files: [], empty: false, lines: 100 };
    expect(shrunkCommits([commit], new Map([["feat", { lines: 40 }]]))).toEqual([
      "feat: 100 -> 40 added lines",
    ]);
    expect(shrunkCommits([commit], new Map([["feat", { lines: 90 }]]))).toEqual([]);

    const files = new Set([
      "a/Migrations/001_A.ts",
      "a/Migrations/002_B.ts",
      "a/Migrations/002_B.test.ts",
    ]);
    expect(
      unlistedLedgerFiles(files, "a/Migrations/", 'import M1 from "./Migrations/001_A.ts";'),
    ).toEqual(["a/Migrations/002_B.ts"]);
  });
});

describe("check-rebase-safety against a real repository", () => {
  const run = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  const write = (cwd: string, file: string, content: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, file), content);
  };
  const commit = (cwd: string, message: string) => {
    run(cwd, "add", "-A");
    run(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  };

  it("passes after a faithful replay and fails when a fork file, command, and test are lost", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebase-safety-"));
    try {
      run(cwd, "init", "-q", "-b", "main");
      write(cwd, "apps/server/src/binCli.ts", "Command.withSubcommands([execCommand]);\n");
      write(cwd, "apps/server/src/cli/exec.ts", "export const execCommand = 1;\n");
      write(cwd, "apps/server/src/feature.ts", "export const feature = 1;\n");
      write(
        cwd,
        "apps/server/src/feature.test.ts",
        'it("does the thing", () => {});\nit("does t3 too", () => {});\n',
      );
      commit(cwd, "upstream base");
      run(cwd, "branch", "upstream");

      write(
        cwd,
        "apps/server/src/fork.ts",
        Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n",
      );
      write(cwd, "apps/server/src/consumer.ts", 'import "./fork.ts";\n');
      commit(cwd, "feat: fork feature");

      const snapshot = takeSnapshot(cwd, "upstream");
      expect(snapshot.forkAdded).toContain("apps/server/src/fork.ts");
      expect(verifySnapshot(cwd, "upstream", snapshot).failures).toEqual([]);

      NodeFS.rmSync(NodePath.join(cwd, "apps/server/src/fork.ts"));
      NodeFS.rmSync(NodePath.join(cwd, "apps/server/src/feature.test.ts"));
      write(cwd, "apps/server/src/consumer.ts", "export {};\n");
      write(cwd, "apps/server/src/binCli.ts", "Command.withSubcommands([]);\n");
      commit(cwd, "chore: rebase fallout");

      const text = verifySnapshot(cwd, "upstream", snapshot).failures.join("\n");
      expect(text).toContain("fork-added file(s) disappeared");
      expect(text).toContain("apps/server/src/fork.ts");
      expect(text).toContain("execCommand");
      expect(text).toContain("upstream test file(s) missing");
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("flags an upstream test case dropped from a file that remains", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebase-safety-"));
    try {
      run(cwd, "init", "-q", "-b", "main");
      write(cwd, "a.ts", "export const a = 1;\n");
      write(cwd, "a.test.ts", 'it("first", () => {});\nit("second", () => {});\n');
      commit(cwd, "upstream base");
      run(cwd, "branch", "upstream");
      write(cwd, "b.ts", "export const b = 1;\n");
      commit(cwd, "feat: fork");
      const snapshot = takeSnapshot(cwd, "upstream");

      write(cwd, "a.test.ts", 'it("first", () => {});\n');
      commit(cwd, "fix: repair");
      expect(verifySnapshot(cwd, "upstream", snapshot).failures.join("\n")).toContain(
        "a.test.ts: second",
      );
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails on an upstream-added matrix the result dropped and a fork edit replaced by upstream's", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebase-safety-"));
    const plain =
      "on:\n  push:\njobs:\n  test_web:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Test\n        run: x\n";
    try {
      run(cwd, "init", "-q", "-b", "main");
      write(cwd, ".github/workflows/release.yml", plain);
      write(cwd, "src/AppBar.tsx", "a\nb\nc\nd\ne\nf\n");
      commit(cwd, "base");
      run(cwd, "checkout", "-q", "-b", "up");
      write(
        cwd,
        ".github/workflows/release.yml",
        plain.replace(
          "    steps:",
          "    strategy:\n      matrix:\n        shard: [1, 2]\n    steps:",
        ),
      );
      write(cwd, "src/AppBar.tsx", "a\nb\nc\nd\ne\nf\nupstream1\n");
      commit(cwd, "upstream: shard and appbar");
      run(cwd, "checkout", "-q", "main");
      write(cwd, "src/AppBar.tsx", "a\nfork1\nfork2\nfork3\ne\nf\n");
      commit(cwd, "fork: appbar");
      const snapshot = takeSnapshot(cwd, "up");
      expect(snapshot.delta["src/AppBar.tsx"]).toBe(3);

      run(cwd, "checkout", "-q", "-b", "result", "up");
      write(cwd, ".github/workflows/release.yml", plain);
      commit(cwd, "rebase: lose shard");
      const text = verifySnapshot(cwd, "up", snapshot).failures.join("\n");
      expect(text).toContain("job:test_web|matrix:shard");
      expect(text).toContain("src/AppBar.tsx: 3 -> 0");
      const accepted = verifySnapshot(cwd, "up", snapshot, "HEAD", ["src/AppBar.tsx"]);
      expect(accepted.failures.join("\n")).not.toContain("src/AppBar.tsx");
      expect(accepted.notes.join("\n")).toContain(
        "ACCEPTED (list in the report): src/AppBar.tsx: 3 -> 0",
      );
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails on each loss class a rebase has silently caused", () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rebase-safety-"));
    try {
      run(cwd, "init", "-q", "-b", "main");
      write(
        cwd,
        ".github/workflows/release.yml",
        "on:\n  push:\njobs:\n  test_web:\n    runs-on: ubuntu-24.04\n    steps:\n      - name: Test\n        run: x\n",
      );
      write(cwd, "pnpm-workspace.yaml", "overrides:\n  vite: 1.0.0\n");
      write(
        cwd,
        "apps/server/src/provider/agentContextBudget.json",
        '{"mcpToolListJsonBytes": 48}\n',
      );
      write(cwd, "oxlint-plugin-t3code/rules/no-sparkles-icon.ts", "export const rule = 1;\n");
      write(cwd, "README.md", "# T2 Code\n");
      commit(cwd, "upstream base");
      run(cwd, "branch", "upstream");

      write(
        cwd,
        ".github/workflows/release.yml",
        "on:\n  push:\njobs:\n  test_web:\n    runs-on: ubuntu-24.04\n    strategy:\n      matrix:\n        shard: [1, 2]\n    steps:\n      - name: Test\n        run: x\n",
      );
      write(cwd, "pnpm-workspace.yaml", "overrides:\n  vite: 1.0.0\n  unenv: 2.0.0-rc.24\n");
      write(
        cwd,
        "apps/server/src/provider/agentContextBudget.json",
        '{"mcpToolListJsonBytes": 95}\n',
      );
      write(
        cwd,
        "apps/server/src/spaces/Migrations.ts",
        'import M1 from "./Migrations/001_Spaces.ts";\nconst e = [\n  [1, "Spaces", M1],\n  [2, "Core", M2],\n] as const;\n',
      );
      write(cwd, "apps/server/src/spaces/Migrations/001_Spaces.ts", "export default 1;\n");
      write(
        cwd,
        "apps/server/scripts/migrate-dev-db.test.ts",
        'const cases = [\n  { name: "main and destination Spaces main" },\n  { name: "WAL and destination chat SHM" },\n];\n',
      );
      NodeFS.rmSync(NodePath.join(cwd, "oxlint-plugin-t3code"), { recursive: true });
      commit(cwd, "feat: fork delta");
      const snapshot = takeSnapshot(cwd, "upstream");
      expect(verifySnapshot(cwd, "upstream", snapshot).failures.join("\n")).toContain(
        "lint rule file(s)",
      );

      write(
        cwd,
        ".github/workflows/release.yml",
        "on:\n  push:\njobs:\n  test_web:\n    runs-on: blacksmith-4vcpu-ubuntu-2404\n    steps:\n      - name: Test\n        run: x\n",
      );
      write(cwd, "pnpm-workspace.yaml", "overrides:\n  vite: 1.0.0\n");
      write(
        cwd,
        "apps/server/src/provider/agentContextBudget.json",
        '{"mcpToolListJsonBytes": 48}\n',
      );
      write(
        cwd,
        "apps/server/src/spaces/Migrations.ts",
        'import M1 from "./Migrations/001_Spaces.ts";\nconst e = [\n  [1, "Spaces", M1],\n] as const;\n',
      );
      write(cwd, "apps/server/src/spaces/Migrations/002_Core.ts", "export default 2;\n");
      write(
        cwd,
        "apps/server/scripts/migrate-dev-db.test.ts",
        'const cases = [\n  { name: "WAL and destination chat SHM" },\n];\n',
      );
      write(
        cwd,
        "README.md",
        "# T2 Code\nGet it on the [App Store](https://apps.apple.com/us/app/t3-code/id1).\nThen someone takes over your T3\nConnect account.\n",
      );
      commit(cwd, "chore: rebase fallout");

      const text = verifySnapshot(cwd, "upstream", snapshot).failures.join("\n");
      expect(text).toContain("job:test_web|matrix:shard");
      expect(text).toContain("blacksmith-* runner labels");
      expect(text).toContain("pnpm-workspace.yaml: unenv: 2.0.0-rc.24");
      expect(text).toContain(
        'migrate-dev-db.test.ts: { name: "main and destination Spaces main" },',
      );
      expect(text).toContain("agentContextBudget.json was lowered");
      expect(text).toContain("Spaces migration(s) no longer registered: 2_Core");
      expect(text).toContain("002_Core.ts");
      expect(text).toContain("README.md: 0 -> 2");
      expect(text).toContain("README.md:https://apps.apple.com/us/app/t3-code/id1");
      expect(text).toContain("oxlint-plugin-t3code/rules/no-sparkles-icon.ts");

      const accepted = verifySnapshot(cwd, "upstream", snapshot, "HEAD", ["README.md"]);
      expect(accepted.failures.join("\n")).not.toContain("README.md");
      expect(accepted.notes.join("\n")).toContain("ACCEPTED");
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
