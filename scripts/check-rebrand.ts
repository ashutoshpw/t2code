#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - zero-dependency git hook CLI; uses Node builtins and console directly.
// Brand guard for the T2 Code fork (ashutoshpw/t2code, upstream pingdotgg/t3code).
// Fails when a T3-brand string that the rebrand renamed is re-introduced on an
// added line. This keeps rebase conflict resolutions honest: upstream commits
// routinely carry T3 copy that the fork's rebrand commits predate.
//
// Modes:
//   --staged            added lines in the git index (pre-commit)
//   --push              added lines in every pushed ref range on stdin (pre-push)
//   --tree              every tracked file (local audit / CI)
//   --range <a..b>      added lines in one diff range
//   --update-baseline   regenerate scripts/rebrand-baseline.json from the tree
//
// Intentional T3 strings (legacy compat, upstream references) are exempted via
// the allowlists below plus scripts/rebrand-baseline.json. Refresh the baseline
// consciously and review its diff like code; never bypass with --no-verify.
// Full classification guide: .agents/skills/rebase-with-upstream/SKILL.md

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const SELF_DIR = NodePath.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = NodePath.resolve(SELF_DIR, "..");
const BASELINE_PATH = NodePath.join(SELF_DIR, "rebrand-baseline.json");

// Files that necessarily spell out the T3 strings they guard against.
const GUARDED_FILES = new Set([
  "scripts/check-rebrand.ts",
  "scripts/check-rebrand.test.ts",
  "scripts/rebrand-baseline.json",
]);
// Trees where T3 mentions are the point: fork tooling describing the upstream,
// and vendored upstream-owned native modules.
const GUARDED_DIRS = [".agents/", "apps/mobile/modules/"];

type Rule = {
  id: string;
  hint: string;
  violates: (file: string, line: string) => boolean;
};

const RULES: Rule[] = [
  {
    id: "t3-copy",
    hint: 'user-facing copy is "T2 Code"; "T3 Code"/"T3Code" only survives as legacy-compat strings listed in the baseline',
    violates: (_file, line) => /(?<![\w/.:-])T3 ?Code(?![\w])/.test(line),
  },
  {
    id: "t3-cli-scope",
    hint: 'the fork CLI package is "@t2code/cli"; upstream ships it unscoped as "t3", so "@t3code/" is at best an invented half-rename',
    violates: (_file, line) => /@t3code\//.test(line),
  },
  {
    id: "t3tools-scope",
    hint: 'fork internal packages are "@t2code/*"; "@t2code/" only exists upstream (.agents/ and apps/mobile/modules/ are exempt dirs)',
    violates: (_file, line) => /@t3tools\//.test(line),
  },
  {
    id: "t3-port",
    hint: "the fork's default server port is 3772; 3773 (and derived 3_773/13_773 literals) is upstream-only",
    violates: (_file, line) => /\b(?:3773|3_773|13_773)\b/.test(line),
  },
  {
    id: "t3-scheme",
    hint: 'deep-link schemes are "t2code"/"t2code-dev"; bare "t3code" schemes no longer exist in the fork',
    violates: (_file, line) => /scheme/i.test(line) && /(['"])t3code(-dev)?\1/.test(line),
  },
  {
    id: "t3-scheme-preview",
    hint: 'the preview scheme is "t2code-preview"; "t3code-preview" only survives in legacy storage partition names',
    violates: (file, line) => /t3code-preview/.test(line) && !line.includes("persist:"),
  },
];

type Entry = { file: string; line: string };
type Violation = Entry & { rule: Rule };

function baselineKey(entry: Entry): string {
  return `${entry.file}\u0000${entry.line.trim()}`;
}

function loadBaseline(): Set<string> {
  try {
    const entries = JSON.parse(NodeFS.readFileSync(BASELINE_PATH, "utf8")) as Entry[];
    return new Set(entries.map(baselineKey));
  } catch {
    return new Set();
  }
}

function isExemptPath(file: string): boolean {
  return GUARDED_FILES.has(file) || GUARDED_DIRS.some((dir) => file.startsWith(dir));
}

function ruleFor(file: string, line: string, baseline: Set<string>): Rule | undefined {
  if (isExemptPath(file)) return undefined;
  if (baseline.has(baselineKey({ file, line }))) return undefined;
  return RULES.find((rule) => rule.violates(file, line));
}

export function findViolations(entries: Entry[], baseline: Set<string>): Violation[] {
  const violations: Violation[] = [];
  for (const entry of entries) {
    const rule = ruleFor(entry.file, entry.line, baseline);
    if (rule) violations.push({ ...entry, rule });
  }
  return violations;
}

function git(args: string[], input?: string): string {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function diffPath(raw: string): string {
  let p = raw;
  if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p) as string;
  return p;
}

function addedLinesFromDiff(diff: string): Entry[] {
  const entries: Entry[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = diffPath(raw.slice(6));
    } else if (raw.startsWith('+++ "')) {
      file = diffPath(raw.slice(4)).slice(2);
    } else if (raw.startsWith("+++ ")) {
      file = "";
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      entries.push({ file, line: raw.slice(1) });
    }
  }
  return entries.filter((entry) => entry.file !== "");
}

function collectStaged(): Entry[] {
  return addedLinesFromDiff(git(["diff", "--cached", "-U0"]));
}

function collectRange(range: string): Entry[] {
  return addedLinesFromDiff(git(["diff", "-U0", range]));
}

function collectPush(): Entry[] {
  const stdin = NodeFS.readFileSync(0, "utf8");
  const entries: Entry[] = [];
  for (const row of stdin.split("\n")) {
    const [localRef, localSha, , remoteSha] = row.trim().split(/\s+/);
    if (!localRef || !localSha || !remoteSha) continue;
    if (/^0+$/.test(localSha)) continue; // ref deletion
    let base = remoteSha;
    if (/^0+$/.test(remoteSha)) {
      // New ref: diff against the merge base with origin/main when it exists.
      try {
        base = git(["merge-base", "origin/main", localSha]).trim();
      } catch {
        console.error(`rebrand guard: skipping ${localRef} (new ref, no origin/main merge base)`);
        continue;
      }
    }
    // Push spread-args: a rebase-sized diff yields more added lines than
    // Function.prototype.apply can pass at once, so append iteratively.
    for (const entry of addedLinesFromDiff(git(["diff", "-U0", `${base}..${localSha}`]))) {
      entries.push(entry);
    }
  }
  return entries;
}

function scanTree(): { entries: Entry[]; withLines: Array<Entry & { num: number }> } {
  const entries: Entry[] = [];
  const withLines: Array<Entry & { num: number }> = [];
  const files = git(["ls-files", "-z"])
    .split("\0")
    .filter((file) => file && !isExemptPath(file));
  for (const file of files) {
    const full = NodePath.join(REPO_ROOT, file);
    let stat;
    try {
      stat = NodeFS.statSync(full);
    } catch {
      continue; // submodule / vanished
    }
    if (!stat.isFile()) continue;
    const buffer = NodeFS.readFileSync(full);
    if (buffer.includes(0)) continue; // binary
    const lines = buffer.toString("utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      entries.push({ file, line });
      withLines.push({ file, line, num: i + 1 });
    }
  }
  return { entries, withLines };
}

function report(violations: Violation[], scope: string, withNumbers?: Map<string, number>): number {
  console.error(
    `rebrand guard: ${violations.length} T3-brand string(s) added by this ${scope}. The fork ships as "T2 Code".`,
  );
  for (const v of violations) {
    const num = withNumbers?.get(baselineKey(v));
    console.error(`\n  ${v.rule.id}  ${v.file}${num ? `:${num}` : ""}`);
    console.error(`    + ${v.line.trim()}`);
    console.error(`    -> ${v.rule.hint}`);
  }
  console.error(
    `

Fix the string, or if a hit is genuinely intentional (legacy compat, upstream
reference), extend the allowlists in scripts/check-rebrand.ts or refresh
scripts/rebrand-baseline.json and review its diff:

  node scripts/check-rebrand.ts --update-baseline

Never bypass with --no-verify. Classification guide:
.agents/skills/rebase-with-upstream/SKILL.md`,
  );
  return 1;
}

function usage(): number {
  console.error(
    "usage: node scripts/check-rebrand.ts [--staged | --push | --tree | --range <a..b> | --update-baseline]",
  );
  return 2;
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) return usage();

  if (argv.includes("--update-baseline")) {
    const { withLines } = scanTree();
    const current = new Set(loadBaseline());
    const seen = new Set<string>();
    const entries: Entry[] = [];
    for (const entry of withLines) {
      if (current.has(baselineKey(entry))) continue; // keep as-is
      if (!RULES.some((rule) => rule.violates(entry.file, entry.line))) continue;
      const key = baselineKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      const [file, line] = key.split("\u0000");
      entries.push({ file: file as string, line: line as string });
    }
    entries.sort((a, b) => a.file.localeCompare(b.file) || a.line.localeCompare(b.line));
    NodeFS.writeFileSync(BASELINE_PATH, `${JSON.stringify(entries, null, 2)}\n`);
    process.stdout.write(
      `rebrand guard: baseline refreshed with ${entries.length} intentional hit(s)\n`,
    );
    return 0;
  }

  const baseline = loadBaseline();
  let violations: Violation[] = [];
  let scope = "";
  let withNumbers: Map<string, number> | undefined;

  if (argv.includes("--push")) {
    scope = "push";
    violations = findViolations(collectPush(), baseline);
  } else if (argv.includes("--tree")) {
    scope = "tree change";
    const { entries, withLines } = scanTree();
    violations = findViolations(entries, baseline);
    withNumbers = new Map(withLines.map((e) => [baselineKey(e), e.num]));
  } else if (argv.includes("--range")) {
    const range = argv[argv.indexOf("--range") + 1];
    if (!range) return usage();
    scope = `range ${range}`;
    violations = findViolations(collectRange(range), baseline);
  } else if (argv.includes("--staged")) {
    scope = "staged change";
    violations = findViolations(collectStaged(), baseline);
  } else {
    return usage();
  }

  if (violations.length > 0) return report(violations, scope, withNumbers);
  if (scope.startsWith("tree")) {
    process.stdout.write("rebrand guard: no T3-brand strings on tracked lines\n");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
