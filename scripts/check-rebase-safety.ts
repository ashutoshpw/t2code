#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - zero-dependency git CLI.
// Run around a rebase onto upstream: `snapshot` records what the fork carries
// over upstream, `verify` recomputes it afterwards and fails on silent loss.
//
//   node scripts/check-rebase-safety.ts snapshot [--file <path>] [--upstream <ref>]
//   node scripts/check-rebase-safety.ts verify   [--file <path>] [--upstream <ref>]
//
// The snapshot defaults to a temp path and is never committed. Everything is read
// from commits (HEAD and the upstream ref), never from the working tree.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const DEFAULT_UPSTREAM = "upstream/main";
const DROP_MIN_LINES = 20;
const DROP_RATIO = 0.5;

const CLI_FILE = "apps/server/src/binCli.ts";
const RPC_FILE = "packages/contracts/src/rpc.ts";
const MAIN_MIGRATIONS_FILE = "apps/server/src/persistence/Migrations.ts";
const FORK_MIGRATIONS_FILE = "apps/server/src/persistence/forkMigrations.ts";
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations/";

type MigrationEntry = readonly [id: number, name: string];

interface SnapshotCommit {
  readonly subject: string;
  readonly added: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly empty: boolean;
}

interface Snapshot {
  readonly version: 1;
  readonly createdAt: string;
  readonly upstreamRef: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly forkAdded: ReadonlyArray<string>;
  readonly forkDeleted: ReadonlyArray<string>;
  readonly delta: Readonly<Record<string, number>>;
  readonly commits: ReadonlyArray<SnapshotCommit>;
  readonly cliCommands: ReadonlyArray<string>;
  readonly rpcRegistered: ReadonlyArray<string>;
  readonly orphans: ReadonlyArray<string>;
  readonly droppedTests: ReadonlyArray<string>;
  readonly workflows: ReadonlyArray<string>;
  readonly forkMigrations: ReadonlyArray<MigrationEntry>;
}

interface Findings {
  readonly failures: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

/** Spelling-insensitive form: upstream's t3 and the fork's t2 compare equal. */
export function normalizeRename(text: string): string {
  return text
    .replace(/t3tools/g, "t2code")
    .replace(/t3/g, "t2")
    .replace(/T3/g, "T2");
}

/** Added lines per file that are not a rename-normalised copy of a removed line in the same file. */
export function substantiveAddedLines(diff: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let file: string | null = null;
  let removed = new Map<string, number>();
  let added: string[] = [];
  const flush = () => {
    if (file === null) return;
    let count = 0;
    for (const line of added) {
      const left = removed.get(line) ?? 0;
      if (left > 0) removed.set(line, left - 1);
      else count += 1;
    }
    if (count > 0) counts[file] = count;
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      file = null;
      removed = new Map();
      added = [];
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? null : raw.slice(6);
      continue;
    }
    if (raw.startsWith("--- ") || file === null) continue;
    const sign = raw[0];
    if (sign !== "+" && sign !== "-") continue;
    const line = normalizeRename(raw.slice(1).trim());
    if (line === "") continue;
    if (sign === "+") added.push(line);
    else removed.set(line, (removed.get(line) ?? 0) + 1);
  }
  flush();
  return counts;
}

export function parseMigrationEntries(source: string): ReadonlyArray<MigrationEntry> {
  return [...source.matchAll(/\[\s*(\d+)\s*,\s*"([A-Za-z0-9_]+)"\s*,\s*[A-Za-z0-9_]+\s*\]/g)].map(
    (match) => [Number(match[1]), match[2]!] as const,
  );
}

/** Command symbols referenced in the CLI entry outside import statements. */
export function parseRegisteredCommands(source: string): ReadonlyArray<string> {
  const body = source.replace(/^import[\s\S]*?;\s*$/gm, "");
  return [...new Set(body.match(/\b[a-zA-Z]+Command\b/g) ?? [])]
    .filter((name) => name !== "Command")
    .toSorted();
}

/** Identifiers passed to the first `RpcGroup.make(` call. */
export function parseRpcGroup(source: string): ReadonlyArray<string> {
  const start = source.indexOf("RpcGroup.make(");
  if (start < 0) return [];
  let depth = 0;
  let end = start;
  for (let index = start + "RpcGroup.make".length; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) {
      end = index;
      break;
    }
  }
  const args = source.slice(start + "RpcGroup.make(".length, end);
  return [...new Set(args.match(/\b[A-Za-z][A-Za-z0-9_]*\b/g) ?? [])].filter((name) =>
    /Rpc$|Rpcs$/.test(name),
  );
}

export function parseTestTitles(source: string): ReadonlyArray<string> {
  const pattern = /\b(?:it|test)(?:\.[a-zA-Z]+)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  return [...source.matchAll(pattern)].map((match) => normalizeRename(match[2]!));
}

const TEST_FILE = /\.(?:browser\.)?test\.(?:ts|tsx)$/;

function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

function testSourceFile(file: string): string {
  return file.replace(/\.(?:browser\.)?test\.(ts|tsx)$/, ".$1");
}

const ENTRYPOINT = [
  /\.d\.ts$/,
  /\.config\./,
  /(^|\/)(bin|main|index|worker|server|entry|preload)\.(ts|tsx)$/,
  /\.nitro\.ts$/,
  /\/(routes|pages|app|migrations|Migrations|ForkMigrations|scripts|fixtures|testkit|test)\//,
];

export function isOrphanCandidate(file: string): boolean {
  return (
    /\.(ts|tsx)$/.test(file) &&
    file.includes("/src/") &&
    !isTestFile(file) &&
    !ENTRYPOINT.some((pattern) => pattern.test(file))
  );
}

export function importedNames(specifiers: ReadonlyArray<string>): ReadonlySet<string> {
  const names = new Set<string>();
  for (const specifier of specifiers) {
    const parts = specifier.split("/").filter((part) => part !== "." && part !== "..");
    const last = parts.at(-1)?.replace(/\.(?:[cm]?[jt]sx?)$/, "");
    if (last) names.add(last);
  }
  return names;
}

export function findOrphans(
  candidates: ReadonlyArray<string>,
  imported: ReadonlySet<string>,
): ReadonlyArray<string> {
  return candidates
    .filter(
      (file) =>
        !imported.has(
          NodePath.basename(file)
            .replace(/\.(ts|tsx)$/, "")
            .replace(/\.(android|ios|web|native)$/, ""),
        ),
    )
    .toSorted();
}

const ids = (entries: ReadonlyArray<MigrationEntry>) =>
  entries.map(([id, name]) => `${id}_${name}`);

/** Main-chain (id, name) pairs must equal upstream's, in order, for every id upstream has. */
export function compareMigrationChains(
  fork: ReadonlyArray<MigrationEntry>,
  upstream: ReadonlyArray<MigrationEntry>,
): ReadonlyArray<string> {
  const forkById = new Map(fork);
  const upstreamIds = new Set(upstream.map(([id]) => id));
  const problems: string[] = [];
  for (const [id, name] of upstream) {
    const forkName = forkById.get(id);
    if (forkName === undefined) problems.push(`migration ${id}_${name} is missing from the fork`);
    else if (forkName !== name)
      problems.push(`migration id ${id} is "${forkName}" in the fork but "${name}" upstream`);
  }
  for (const [id, name] of fork) {
    if (!upstreamIds.has(id) && upstream.length > 0 && id <= Math.max(...upstreamIds))
      problems.push(`fork-only migration ${id}_${name} sits inside upstream's id range`);
  }
  return problems;
}

interface CurrentState {
  readonly files: ReadonlySet<string>;
  readonly delta: Readonly<Record<string, number>>;
  readonly subjects: ReadonlyMap<string, { readonly empty: boolean }>;
  readonly cliCommands: ReadonlyArray<string>;
  readonly rpcRegistered: ReadonlyArray<string>;
  readonly orphans: ReadonlyArray<string>;
  readonly droppedTests: ReadonlyArray<string>;
  readonly missingUpstreamTests: ReadonlyArray<string>;
  readonly workflows: ReadonlyArray<string>;
  readonly forkMigrations: ReadonlyArray<MigrationEntry>;
  readonly mainMigrationProblems: ReadonlyArray<string>;
  readonly unlistedMigrationFiles: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<{ readonly name: string; readonly onMain: boolean }>;
}

function compareState(before: Snapshot, now: CurrentState): Findings {
  const failures: string[] = [];
  const notes: string[] = [];

  const lostFiles = before.forkAdded.filter((file) => !now.files.has(file));
  if (lostFiles.length > 0)
    failures.push(
      `${lostFiles.length} fork-added file(s) disappeared:\n${lostFiles.map((f) => `    ${f}`).join("\n")}`,
    );

  const drops = Object.entries(before.delta)
    .map(([file, was]) => [file, was, now.delta[file] ?? 0] as const)
    .filter(
      ([file, was, is]) =>
        now.files.has(file) && was - is >= DROP_MIN_LINES && is < was * DROP_RATIO,
    );
  if (drops.length > 0)
    failures.push(
      `${drops.length} file(s) lost most of their fork delta (substantive added lines, before -> after):\n${drops.map(([f, was, is]) => `    ${f}: ${was} -> ${is}`).join("\n")}`,
    );

  const emptied: string[] = [];
  const lostContent: string[] = [];
  const squashed: string[] = [];
  for (const commit of before.commits) {
    const found = now.subjects.get(commit.subject);
    if (found) {
      if (found.empty && !commit.empty) emptied.push(commit.subject);
      continue;
    }
    const lost = commit.files.filter(
      (file) => (before.delta[file] ?? 0) > 0 && (now.delta[file] ?? 0) === 0,
    );
    if (lost.length > 0) lostContent.push(`${commit.subject} (${lost.slice(0, 3).join(", ")})`);
    else squashed.push(commit.subject);
  }
  if (emptied.length > 0)
    failures.push(
      `fork commit(s) kept their subject but carry no content:\n${emptied.map((s) => `    ${s}`).join("\n")}`,
    );
  if (lostContent.length > 0)
    failures.push(
      `fork commit(s) are gone and the files they changed lost their fork delta:\n${lostContent.map((s) => `    ${s}`).join("\n")}`,
    );
  if (squashed.length > 0)
    notes.push(
      `${squashed.length} fork commit subject(s) no longer exist (squashed or reworded; content survives).`,
    );

  const unregistered = before.cliCommands.filter((name) => !now.cliCommands.includes(name));
  if (unregistered.length > 0)
    failures.push(`CLI command(s) no longer registered in ${CLI_FILE}: ${unregistered.join(", ")}`);
  const unregisteredRpcs = before.rpcRegistered.filter((name) => !now.rpcRegistered.includes(name));
  if (unregisteredRpcs.length > 0)
    failures.push(`RPC(s) no longer registered in WsRpcGroup: ${unregisteredRpcs.join(", ")}`);
  const missingWorkflows = before.workflows.filter((file) => !now.files.has(file));
  if (missingWorkflows.length > 0)
    failures.push(`workflow file(s) disappeared: ${missingWorkflows.join(", ")}`);
  const goneForkMigrations = before.forkMigrations.filter(
    ([id, name]) => !now.forkMigrations.some(([i, n]) => i === id && n === name),
  );
  if (goneForkMigrations.length > 0)
    failures.push(`fork migration(s) no longer registered: ${ids(goneForkMigrations).join(", ")}`);

  const newOrphans = now.orphans.filter((file) => !before.orphans.includes(file));
  if (newOrphans.length > 0)
    failures.push(
      `${newOrphans.length} fork file(s) exist but nothing imports them any more:\n${newOrphans.map((f) => `    ${f}`).join("\n")}`,
    );

  if (now.missingUpstreamTests.length > 0)
    failures.push(
      `upstream test file(s) missing in the fork while their source exists:\n${now.missingUpstreamTests.map((f) => `    ${f}`).join("\n")}`,
    );
  const newDrops = now.droppedTests.filter((entry) => !before.droppedTests.includes(entry));
  if (newDrops.length > 0)
    failures.push(
      `upstream test case(s) present at the merge base but missing in the fork's copy of the file:\n${newDrops.map((e) => `    ${e}`).join("\n")}`,
    );

  if (now.mainMigrationProblems.length > 0)
    failures.push(
      `main-chain server migrations differ from upstream's:\n${now.mainMigrationProblems.map((p) => `    ${p}`).join("\n")}`,
    );
  if (now.unlistedMigrationFiles.length > 0)
    failures.push(
      `migration file(s) in ${MIGRATIONS_DIR} that Migrations.ts does not register:\n${now.unlistedMigrationFiles.map((f) => `    ${f}`).join("\n")}`,
    );

  const offMain = now.tags.filter((tag) => !tag.onMain);
  notes.push(
    offMain.length === 0
      ? `release tags: the ${now.tags.length} most recent tag(s) are all ancestors of HEAD.`
      : `release tags NOT reachable from HEAD (report only): ${offMain.map((t) => t.name).join(", ")}`,
  );
  return { failures, notes };
}

function git(args: ReadonlyArray<string>, cwd: string, allowFailure = false): string {
  try {
    return NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1 << 30,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

function show(cwd: string, ref: string, file: string): string | null {
  try {
    return NodeChildProcess.execFileSync("git", ["show", `${ref}:${file}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function readBlobs(cwd: string, specs: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (specs.length === 0) return out;
  const buffer = NodeChildProcess.execFileSync("git", ["cat-file", "--batch"], {
    cwd,
    input: `${specs.join("\n")}\n`,
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let offset = 0;
  for (const spec of specs) {
    const end = buffer.indexOf(10, offset);
    const header = buffer.toString("utf8", offset, end);
    offset = end + 1;
    const size = Number(header.split(" ")[2]);
    if (header.endsWith(" missing") || Number.isNaN(size)) continue;
    out.set(spec, buffer.toString("utf8", offset, offset + size));
    offset += size + 1;
  }
  return out;
}

function treeFiles(cwd: string, ref: string): ReadonlySet<string> {
  return new Set(
    git(["ls-tree", "-r", "--name-only", "-z", ref], cwd)
      .split("\0")
      .filter((file) => file !== ""),
  );
}

function commitList(cwd: string, base: string) {
  const out = git(
    ["log", "--no-merges", "--name-status", "--no-renames", "--format=%x01%s", `${base}..HEAD`],
    cwd,
  );
  return out
    .split("\u0001")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => {
      const [subject = "", ...rest] = chunk.split("\n");
      const entries = rest
        .filter((l) => l.includes("\t"))
        .map((l) => l.split("\t") as [string, string]);
      return {
        subject,
        added: entries.filter(([s]) => s === "A").map(([, f]) => f),
        files: entries.filter(([s]) => s !== "D").map(([, f]) => f),
        empty: entries.length === 0,
      };
    });
}

function importedSpecifiers(cwd: string): ReadonlyArray<string> {
  const out = git(
    [
      "grep",
      "-h",
      "-o",
      "-E",
      "(from|import\\(|require\\()\\s*[\"'][^\"']+[\"']",
      "HEAD",
      "--",
      "*.ts",
      "*.tsx",
      "*.mts",
      "*.cts",
      "*.js",
      "*.mjs",
      "*.cjs",
    ],
    cwd,
    true,
  );
  return lines(out).map((entry) => entry.replace(/^[^"']*["']/, "").replace(/["']$/, ""));
}

function collectState(cwd: string, upstreamRef: string, forkAdded: ReadonlyArray<string>) {
  const base = git(["merge-base", "HEAD", upstreamRef], cwd).trim();
  const head = git(["rev-parse", "HEAD"], cwd).trim();
  const headFiles = treeFiles(cwd, "HEAD");
  const baseFiles = treeFiles(cwd, base);

  const status = git(["diff", "--name-status", "--no-renames", "-z", base, "HEAD"], cwd)
    .split("\0")
    .filter((entry) => entry !== "");
  const added: string[] = [];
  const deleted: string[] = [];
  for (let index = 0; index + 1 < status.length; index += 2) {
    if (status[index] === "A") added.push(status[index + 1]!);
    if (status[index] === "D") deleted.push(status[index + 1]!);
  }

  const delta = substantiveAddedLines(
    git(["diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", base, "HEAD"], cwd),
  );
  const commits = commitList(cwd, base);

  const cliSource = show(cwd, "HEAD", CLI_FILE) ?? "";
  const rpcSource = show(cwd, "HEAD", RPC_FILE) ?? "";
  const mainSource = show(cwd, "HEAD", MAIN_MIGRATIONS_FILE) ?? "";
  const mainEntries = parseMigrationEntries(mainSource);
  const upstreamMain = parseMigrationEntries(show(cwd, base, MAIN_MIGRATIONS_FILE) ?? "");
  const registeredMigrationFiles = new Set(
    [...mainSource.matchAll(/from\s+"\.\/Migrations\/([^"]+)"/g)].map((match) => match[1]!),
  );
  const unlistedMigrationFiles = [...headFiles]
    .filter((file) => file.startsWith(MIGRATIONS_DIR) && /\/\d+_[^/]+\.ts$/.test(file))
    .filter((file) => !/\.test\.ts$/.test(file))
    .filter((file) => !registeredMigrationFiles.has(NodePath.basename(file)))
    .toSorted();

  const candidates = (forkAdded.length > 0 ? forkAdded : added).filter(
    (file) => headFiles.has(file) && isOrphanCandidate(file),
  );
  const orphans = findOrphans(candidates, importedNames(importedSpecifiers(cwd)));

  const missingUpstreamTests: string[] = [];
  const droppedTests: string[] = [];
  const pairs: Array<{ file: string; here: string }> = [];
  for (const file of baseFiles) {
    if (!isTestFile(file)) continue;
    const mapped = normalizeRename(file);
    const here = headFiles.has(file) ? file : headFiles.has(mapped) ? mapped : null;
    if (here === null) {
      if (headFiles.has(testSourceFile(mapped)) || headFiles.has(testSourceFile(file)))
        missingUpstreamTests.push(file);
    } else pairs.push({ file, here });
  }
  const theirsBlobs = readBlobs(
    cwd,
    pairs.map(({ file }) => `${base}:${file}`),
  );
  const oursBlobs = readBlobs(
    cwd,
    pairs.map(({ here }) => `HEAD:${here}`),
  );
  for (const { file, here } of pairs) {
    const ours = new Set(parseTestTitles(oursBlobs.get(`HEAD:${here}`) ?? ""));
    for (const title of parseTestTitles(theirsBlobs.get(`${base}:${file}`) ?? ""))
      if (!ours.has(title)) droppedTests.push(`${here}: ${title}`);
  }

  const tags = lines(git(["tag", "--list", "v*", "--sort=-creatordate"], cwd, true))
    .slice(0, 20)
    .map((name) => ({
      name,
      onMain: execFileSyncOk(["merge-base", "--is-ancestor", name, "HEAD"], cwd),
    }));

  return {
    base,
    head,
    added,
    deleted,
    delta,
    commits,
    headFiles,
    cliCommands: parseRegisteredCommands(cliSource),
    rpcRegistered: parseRpcGroup(rpcSource),
    orphans,
    droppedTests: droppedTests.toSorted(),
    missingUpstreamTests: missingUpstreamTests.toSorted(),
    workflows: [...headFiles].filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f)).toSorted(),
    forkMigrations: parseMigrationEntries(show(cwd, "HEAD", FORK_MIGRATIONS_FILE) ?? ""),
    mainMigrationProblems: compareMigrationChains(mainEntries, upstreamMain),
    unlistedMigrationFiles,
    tags,
  };
}

function execFileSyncOk(args: ReadonlyArray<string>, cwd: string): boolean {
  try {
    NodeChildProcess.execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function takeSnapshot(cwd: string, upstreamRef: string): Snapshot {
  const state = collectState(cwd, upstreamRef, []);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    upstreamRef,
    mergeBase: state.base,
    head: state.head,
    forkAdded: state.added.toSorted(),
    forkDeleted: state.deleted.toSorted(),
    delta: state.delta,
    commits: state.commits.map(({ subject, added, files, empty }) => ({
      subject,
      added,
      files,
      empty,
    })),
    cliCommands: state.cliCommands,
    rpcRegistered: state.rpcRegistered,
    orphans: state.orphans,
    droppedTests: state.droppedTests,
    workflows: state.workflows,
    forkMigrations: state.forkMigrations,
  };
}

export function verifySnapshot(cwd: string, upstreamRef: string, before: Snapshot): Findings {
  const state = collectState(cwd, upstreamRef, before.forkAdded);
  const subjects = new Map(state.commits.map((c) => [c.subject, { empty: c.empty }]));
  return compareState(before, {
    files: state.headFiles,
    delta: state.delta,
    subjects,
    cliCommands: state.cliCommands,
    rpcRegistered: state.rpcRegistered,
    orphans: state.orphans,
    droppedTests: state.droppedTests,
    missingUpstreamTests: state.missingUpstreamTests,
    workflows: state.workflows,
    forkMigrations: state.forkMigrations,
    mainMigrationProblems: state.mainMigrationProblems,
    unlistedMigrationFiles: state.unlistedMigrationFiles,
    tags: state.tags,
  });
}

function option(argv: ReadonlyArray<string>, name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
}

function main(argv: ReadonlyArray<string>, cwd = process.cwd()): number {
  const mode = argv[0];
  const file = option(
    argv,
    "--file",
    NodePath.join(NodeOS.tmpdir(), "t2code-rebase-snapshot.json"),
  );
  const upstream = option(argv, "--upstream", DEFAULT_UPSTREAM);
  if (mode === "snapshot") {
    const snapshot = takeSnapshot(cwd, upstream);
    NodeFS.writeFileSync(file, JSON.stringify(snapshot));
    console.log(
      `Snapshot written to ${file}\n  merge-base ${snapshot.mergeBase.slice(0, 10)}, ${snapshot.commits.length} fork commits, ${snapshot.forkAdded.length} fork-added files, ${Object.keys(snapshot.delta).length} files with fork delta.\n  Not recorded as failures: ${snapshot.orphans.length} unimported fork file(s), ${snapshot.droppedTests.length} dropped upstream test case(s) already present at snapshot time.`,
    );
    return 0;
  }
  if (mode === "verify") {
    if (!NodeFS.existsSync(file)) {
      console.error(`No snapshot at ${file}. Run \`snapshot\` before the rebase.`);
      return 2;
    }
    const before = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Snapshot;
    const { failures, notes } = verifySnapshot(cwd, upstream, before);
    for (const note of notes) console.log(`note: ${note}`);
    if (failures.length > 0) {
      console.error(`\nRebase safety check FAILED (${failures.length}):\n`);
      for (const failure of failures) console.error(`- ${failure}\n`);
      console.error(
        "Restore each item from the commit that lost it. Do not edit the snapshot to make this pass.",
      );
      return 1;
    }
    console.log("Rebase safety check passed.");
    return 0;
  }
  console.error(
    "usage: node scripts/check-rebase-safety.ts <snapshot|verify> [--file <path>] [--upstream <ref>]",
  );
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
