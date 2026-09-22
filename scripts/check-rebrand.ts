#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - zero-dependency git hook CLI; uses Node builtins and console directly.
// Brand guard for the T2 Code fork (ashutoshpw/t2code, upstream pingdotgg/t3code).
// Fails when a T3-brand string that the rebrand renamed is re-introduced on an
// added line, or when the upstream root project file is restored. This keeps
// rebase conflict resolutions honest: upstream commits routinely carry T3
// copy and configuration that the fork's rebrand commits predate.
//
// Modes:
//   --staged            added lines in the git index (pre-commit)
//   --push              added lines in every pushed ref range on stdin (pre-push)
//   --tree              every tracked file (local audit / CI)
//   --range <a..b>      added lines in one diff range
//   --check-baseline    fail when scripts/rebrand-baseline.json differs from the tree (CI)
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
// Trees where T3 mentions are the point: fork tooling describing the upstream
// and the vendored upstream checkout.
const GUARDED_DIRS = [".agents/", ".repos/"];

// These are intentionally narrower than a bare `T3` search. T3 remains in
// protocol/runtime compatibility names, while these identifiers and the path
// below are the retired first-party wordmark implementation.
// The fingerprint starts at the old second glyph because T2 intentionally
// retains the shared leading T contour.
const LEGACY_WORDMARK_PATH_FINGERPRINT =
  /M86\.7253\s+93\.96\s*C82\.832\s+93\.96\s+78\.9653\s+93\.4533\s+75\.1253\s+92\.44/;

// Upstream repository fixtures intentionally retain the original owner. They
// exercise URL/repository normalization and are not package or product brand
// references that the fork should rename.
const UPSTREAM_T3TOOLS_REPOSITORY_PREFIX = /(?:github\.com|gitlab\.com)(?::|\/)$/i;
const T3TOOLS_WORD = /\bt3tools\b/gi;

// First-party product URLs: the fork serves app.t2.codes, relay.t2.codes,
// clerk.t2.codes, and nightly.app.t2.codes. t3.codes and its subdomains are
// upstream references, so a hit means a link missed the T2 migration.
const UPSTREAM_FIRST_PARTY_URL = /(?<![\w-])t3\.codes\b/i;

// The env namespace is T2CODE_*/T2_* only: the legacy seam and the retained
// pre-rename identifiers were removed after the T2 migration completed.
const RETAINED_T3_IDENTIFIERS = new Set([] as string[]);

function hasLegacyEnvName(line: string): boolean {
  for (const match of line.matchAll(/(?<![A-Za-z0-9_])T3(?:CODE)?_[A-Z0-9_]+/g)) {
    if (!RETAINED_T3_IDENTIFIERS.has(match[0])) return true;
  }
  return false;
}

function hasUnapprovedT3ToolsReference(line: string): boolean {
  for (const match of line.matchAll(T3TOOLS_WORD)) {
    const index = match.index;
    if (index === undefined || !UPSTREAM_T3TOOLS_REPOSITORY_PREFIX.test(line.slice(0, index))) {
      return true;
    }
  }
  return false;
}

// Mechanical find/replace rebrands produce references that cannot exist: the
// upstream owner with the fork's repo name, the fork owner with the upstream
// repo name, or a bundle id no store has. Test fixtures intentionally use
// synthetic owners, so this rule skips test files.
const HALF_RENAMED_REFERENCE_PATTERNS = [
  /pingdotgg\/t2code\b/i,
  /ashutoshpw\/t3code\b/i,
  /com\.t2tools\.t2code\b/i,
];

function hasHalfRenamedReference(file: string, line: string): boolean {
  if (file.includes(".test.") || file.includes(".spec.")) return false;
  return HALF_RENAMED_REFERENCE_PATTERNS.some((pattern) => pattern.test(line));
}

type Rule = {
  id: string;
  hint: string;
  violates: (file: string, line: string) => boolean;
};

const FORBIDDEN_FILE_RULES: ReadonlyMap<string, Rule> = new Map([
  [
    "t3.json",
    {
      id: "t3-project-file",
      hint: 'the fork uses "t2.json" for checked-in project configuration; remove the upstream "t3.json" file',
      violates: (file) => file === "t3.json",
    },
  ],
]);

const RULES: Rule[] = [
  {
    id: "t3-connect-copy",
    hint: 'connect branding is "T2 Connect"; compatibility identifiers (module names, route ids, token types) are preserved separately',
    violates: (_file, line) => /\bT3\s+Connect\b/.test(line),
  },
  {
    id: "t3-wordmark-ref",
    hint: 'the retired wordmark component is "T2Wordmark"; do not reintroduce "T3Wordmark"',
    violates: (_file, line) => /\bT3Wordmark\b/.test(line),
  },
  {
    id: "t3-mark-ref",
    hint: 'the retired widget asset is "T2Mark"; do not reintroduce "T3Mark"',
    violates: (_file, line) => /\bT3Mark\b/.test(line),
  },
  {
    id: "t3-wordmark-label",
    hint: 'the wordmark accessibility label is "T2", not the bare legacy label "T3"',
    violates: (_file, line) => /(?:aria-label|accessibilityLabel)\s*=\s*(["'])T3\1/.test(line),
  },
  {
    id: "t3-wordmark-path",
    hint: "replace the retired T3 wordmark SVG path with the canonical T2 wordmark asset",
    violates: (_file, line) => LEGACY_WORDMARK_PATH_FINGERPRINT.test(line),
  },
  {
    id: "t3-copy",
    hint: 'user-facing copy is "T2 Code"; "T3 Code"/"T3Code" only survives as legacy-compat strings listed in the baseline',
    violates: (_file, line) => /(?<![\w/.:-])T3 ?Code(?![\w])/.test(line),
  },
  {
    id: "t3-first-party-url",
    hint: 'first-party URLs use the T2 domains (app.t2.codes, relay.t2.codes, clerk.t2.codes); "t3.codes" and its subdomains are upstream references',
    violates: (_file, line) => UPSTREAM_FIRST_PARTY_URL.test(line),
  },
  {
    id: "t3-home-copy",
    hint: 'the data directory is the "T2 home" (T2CODE_HOME, ~/.t2); "T3 home" survives only in the legacy adoption seam',
    violates: (_file, line) => /\bt3 home\b/i.test(line),
  },
  {
    id: "t3-server-copy",
    hint: 'user-facing copy says "T2 server"; the legacy "T3 server" transport error string is the only retained spelling',
    violates: (_file, line) => /\bt3 server\b/i.test(line),
  },
  {
    id: "t3-cli-scope",
    hint: 'the fork CLI package is "@t2code/cli"; upstream ships it unscoped as "t3", so "@t2code/" is at best an invented half-rename',
    violates: (_file, line) => /@t3code\//.test(line),
  },
  {
    id: "t3-scope",
    hint: 'the fork package scope is "@t2code"; "@t3/" is an invented upstream-adjacent scope',
    violates: (_file, line) => /@t3\//.test(line),
  },
  {
    id: "t3tools-scope",
    hint: 'fork internal packages are "@t2code/*"; "@t2code/" only exists upstream (.agents/ and apps/mobile/modules/ are exempt dirs)',
    violates: (_file, line) => /@t3tools\//.test(line),
  },
  {
    id: "t3-half-rename",
    hint: 'a mechanical rename left a reference that cannot exist (upstream owner + fork repo, fork owner + upstream repo, or the unpublished "com.t2tools.t2code" app id)',
    violates: (file, line) => hasHalfRenamedReference(file, line),
  },
  {
    id: "t3tools-brand",
    hint: 'repository-owned identifiers use "t2code"; preserve an existing compatibility/upstream hit only with an exact baseline entry',
    violates: (_file, line) => hasUnapprovedT3ToolsReference(line),
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
  {
    id: "t3-env-name",
    hint: "env vars use the T2CODE_/T2_ namespace only",
    violates: (_file, line) => hasLegacyEnvName(line),
  },
];

// Line rules only see added lines, so a renamed or newly added path carrying a
// T3 name would slip through. Path rules run once per file. "t3" not followed
// by a digit avoids false positives like "bit31" in vendored hashes.
const T3_BRAND_PATH = /t3(?![0-9])/i;
const PATH_RULES: Rule[] = [
  {
    id: "t3-named-path",
    hint: "tracked paths do not carry T3 names; grandfather an existing path with a baseline entry whose line is empty",
    violates: (file) => T3_BRAND_PATH.test(file),
  },
];

const pathBaselineKey = (file: string): string => `${file}\u0000`;

type Entry = { file: string; line: string };
type Violation = Entry & { rule: Rule };

function baselineKey(entry: Entry): string {
  return `${entry.file}\u0000${entry.line.trim()}`;
}

function loadBaseline(): Set<string> {
  return new Set(readBaselineEntries().map(baselineKey));
}

function readBaselineEntries(): Entry[] {
  try {
    return JSON.parse(NodeFS.readFileSync(BASELINE_PATH, "utf8")) as Entry[];
  } catch {
    return [];
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
  const reportedForbiddenFiles = new Set<string>();
  const reportedPaths = new Set<string>();
  for (const entry of entries) {
    const forbiddenFileRule = FORBIDDEN_FILE_RULES.get(entry.file);
    if (forbiddenFileRule) {
      if (!reportedForbiddenFiles.has(entry.file)) {
        reportedForbiddenFiles.add(entry.file);
        violations.push({ ...entry, rule: forbiddenFileRule });
      }
      continue;
    }
    if (!isExemptPath(entry.file) && !baseline.has(pathBaselineKey(entry.file))) {
      const pathRule = PATH_RULES.find((rule) => rule.violates(entry.file, entry.line));
      if (pathRule && !reportedPaths.has(entry.file)) {
        reportedPaths.add(entry.file);
        violations.push({ file: entry.file, line: `<path> ${entry.file}`, rule: pathRule });
      }
    }
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

// Collectors emit one { file, line: "" } entry per T3-named path so
// findViolations can flag the path itself; it dedupes per file and honors the
// baseline via pathBaselineKey.

function collectStaged(): Entry[] {
  const entries = addedLinesFromDiff(git(["diff", "--cached", "-U0"]));
  const stagedFiles = new Set(git(["ls-files", "--cached", "-z"]).split("\0").filter(Boolean));
  for (const file of stagedFiles) {
    if (isExemptPath(file)) continue;
    if (!PATH_RULES.some((rule) => rule.violates(file, ""))) continue;
    entries.push({ file, line: "" });
  }
  for (const file of FORBIDDEN_FILE_RULES.keys()) {
    if (stagedFiles.has(file) && !entries.some((entry) => entry.file === file)) {
      entries.push({ file, line: "" });
    }
  }
  return entries;
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
    for (const file of git(["diff", "--name-only", "-z", `${base}..${localSha}`])
      .split("\0")
      .filter(Boolean)) {
      if (isExemptPath(file)) continue;
      if (!PATH_RULES.some((rule) => rule.violates(file, ""))) continue;
      entries.push({ file, line: "" });
    }
    for (const file of FORBIDDEN_FILE_RULES.keys()) {
      if (git(["ls-tree", "-r", "--name-only", localSha, "--", file]).trim() === file) {
        entries.push({ file, line: "" });
      }
    }
  }
  return entries;
}

function scanTree(): {
  entries: Entry[];
  withLines: Array<Entry & { num: number }>;
  files: string[];
} {
  const entries: Entry[] = [];
  const withLines: Array<Entry & { num: number }> = [];
  const files = git(["ls-files", "-z"])
    .split("\0")
    .filter((file) => file && !isExemptPath(file));
  for (const file of files) {
    if (PATH_RULES.some((rule) => rule.violates(file, ""))) {
      // Path-level signal, before the binary skip so t3-named assets are seen.
      entries.push({ file, line: "" });
    }
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
  return { entries, withLines, files };
}

export function collectBaselineEntries(
  withLines: Array<Entry & { num: number }>,
  files: string[],
): Entry[] {
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const entry of withLines) {
    const key = baselineKey(entry);
    if (seen.has(key)) continue;
    if (!RULES.some((rule) => rule.violates(entry.file, entry.line))) continue;
    seen.add(key);
    const [file, line] = key.split("\u0000");
    entries.push({ file: file as string, line: line as string });
  }
  for (const file of files) {
    if (!PATH_RULES.some((rule) => rule.violates(file, ""))) continue;
    const key = pathBaselineKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ file, line: "" });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file) || a.line.localeCompare(b.line));
  return entries;
}

function report(violations: Violation[], scope: string, withNumbers?: Map<string, number>): number {
  console.error(
    `rebrand guard: ${violations.length} rebrand violation(s) found in this ${scope}. The fork ships as "T2 Code".`,
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
    "usage: node scripts/check-rebrand.ts [--staged | --push | --tree | --range <a..b> | --check-baseline | --update-baseline]",
  );
  return 2;
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) return usage();

  if (argv.includes("--update-baseline")) {
    const { withLines, files } = scanTree();
    const entries = collectBaselineEntries(withLines, files);
    NodeFS.writeFileSync(BASELINE_PATH, `${JSON.stringify(entries, null, 2)}\n`);
    process.stdout.write(
      `rebrand guard: baseline refreshed with ${entries.length} intentional hit(s)\n`,
    );
    return 0;
  }

  if (argv.includes("--check-baseline")) {
    const { withLines, files } = scanTree();
    const expected = collectBaselineEntries(withLines, files);
    const current = readBaselineEntries();
    const expectedKeys = new Set(expected.map(baselineKey));
    const currentKeys = new Set(current.map(baselineKey));
    const missing = expected.filter((entry) => !currentKeys.has(baselineKey(entry)));
    const stale = current.filter((entry) => !expectedKeys.has(baselineKey(entry)));
    if (missing.length > 0 || stale.length > 0) {
      console.error("rebrand guard: baseline is out of date with the tree.");
      for (const entry of missing) {
        console.error(`  missing  ${entry.file}: ${entry.line.trim() || "<path>"}`);
      }
      for (const entry of stale) {
        console.error(`  stale    ${entry.file}: ${entry.line.trim() || "<path>"}`);
      }
      console.error(
        "\nRefresh it and review the diff:\n\n  node scripts/check-rebrand.ts --update-baseline\n",
      );
      return 1;
    }
    process.stdout.write(
      `rebrand guard: baseline matches the tree (${expected.length} intentional hit(s))\n`,
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
