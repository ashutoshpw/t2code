// @effect-diagnostics nodeBuiltinImport:off - builds throwaway git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  compareMigrationChains,
  findOrphans,
  importedNames,
  isOrphanCandidate,
  normalizeRename,
  parseMigrationEntries,
  parseRegisteredCommands,
  parseRpcGroup,
  parseTestTitles,
  substantiveAddedLines,
  takeSnapshot,
  verifySnapshot,
} from "./check-rebase-safety.ts";

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
});
