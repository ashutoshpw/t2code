#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - zero-dependency git CLI.
// Run around a rebase onto upstream: `snapshot` records what the fork carries
// over upstream, `verify` recomputes it afterwards and fails on silent loss.
//
//   node scripts/check-rebase-safety.ts snapshot [--file <path>] [--upstream <ref>] [--head <ref>]
//   node scripts/check-rebase-safety.ts verify   [--file <path>] [--upstream <ref>] [--head <ref>]
//
// --accept <text> (verify, repeatable) moves every failing item containing <text> to a note; use it
// only for losses the rebase report names as intentional, never to silence a guard.
// --head is the fork ref to read (default HEAD): snapshot a saved pre-rebase branch, or verify a
// pushed sha, without checking anything out.
//
// The snapshot defaults to a temp path and is never committed. Everything is read
// from commits (--head and the upstream ref), never from the working tree.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  compareMigrationChains,
  DROP_MIN_LINES,
  DROP_RATIO,
  grownT3Files,
  ids,
  isTestFile,
  lostPinnedLines,
  lostWorkflowFacts,
  missedUpstreamWorkflowFacts,
  resetToUpstreamFiles,
  loweredBudgets,
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
  testSourceFile,
  unlistedLedgerFiles,
  WORKFLOW_FILE,
  type Budget,
  type MigrationEntry,
  findOrphans,
  importedNames,
  isOrphanCandidate,
} from "./rebase-safety-parsers.ts";
import {
  changedBetween,
  git,
  lines,
  readBlobs,
  show,
  storeLinks,
  t3Counts,
  treeFiles,
  upstreamNotCarried,
} from "./rebase-safety-git.ts";

const DEFAULT_UPSTREAM = "upstream/main";

const CLI_FILE = "apps/server/src/binCli.ts";
const RPC_FILE = "packages/contracts/src/rpc.ts";
const MAIN_MIGRATIONS_FILE = "apps/server/src/persistence/Migrations.ts";
const FORK_MIGRATIONS_FILE = "apps/server/src/persistence/forkMigrations.ts";
const MIGRATIONS_DIR = "apps/server/src/persistence/Migrations/";

const SPACES_MIGRATIONS_FILE = "apps/server/src/spaces/Migrations.ts";
// Fork-only migration chains whose registered (id, name) entries and files must survive. The main
// chain is compared against upstream separately.
const LEDGERS = [
  { label: "fork", file: FORK_MIGRATIONS_FILE, dir: "apps/server/src/persistence/ForkMigrations/" },
  { label: "Spaces", file: SPACES_MIGRATIONS_FILE, dir: "apps/server/src/spaces/Migrations/" },
] as const;
// Files the fork edited in place: every line it added must survive, or be adopted by upstream.
const PINNED_FILES = [
  "pnpm-workspace.yaml",
  "apps/server/scripts/migrate-dev-db.test.ts",
  FORK_MIGRATIONS_FILE,
  SPACES_MIGRATIONS_FILE,
] as const;
const BUDGET_FILE = "apps/server/src/provider/agentContextBudget.json";
// Files where upstream's own added lines are listed for review when the result lacks them.

interface SnapshotCommit {
  readonly subject: string;
  readonly added: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
  readonly lines: number;
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
  readonly spacesMigrations: ReadonlyArray<MigrationEntry>;
  /** Structural facts of every workflow in the fork, and of the same files at the merge base. */
  readonly workflowFacts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly workflowBaseFacts: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Significant lines the fork added to each pinned file relative to the merge base. */
  readonly pinnedLines: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly budget: Budget;
  readonly budgetBase: Budget;
  readonly t3Counts: Readonly<Record<string, number>>;
  readonly storeLinks: ReadonlyArray<string>;
}

interface Findings {
  readonly failures: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

interface CurrentState {
  readonly files: ReadonlySet<string>;
  readonly delta: Readonly<Record<string, number>>;
  readonly subjects: ReadonlyMap<string, { readonly empty: boolean; readonly lines: number }>;
  readonly cliCommands: ReadonlyArray<string>;
  readonly rpcRegistered: ReadonlyArray<string>;
  readonly orphans: ReadonlyArray<string>;
  readonly droppedTests: ReadonlyArray<string>;
  readonly missingUpstreamTests: ReadonlyArray<string>;
  readonly workflows: ReadonlyArray<string>;
  readonly forkMigrations: ReadonlyArray<MigrationEntry>;
  readonly spacesMigrations: ReadonlyArray<MigrationEntry>;
  readonly upstreamMissing: ReadonlyArray<string>;
  readonly workflowFacts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly upstreamWorkflowFacts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly pinnedNow: Readonly<Record<string, ReadonlySet<string>>>;
  readonly pinnedUpstream: Readonly<Record<string, ReadonlySet<string>>>;
  readonly budget: Budget;
  readonly budgetUpstream: Budget;
  readonly t3Counts: Readonly<Record<string, number>>;
  readonly storeLinks: ReadonlyArray<string>;
  readonly upstreamNotCarried: ReadonlyArray<string>;
  readonly upstreamChanged: ReadonlySet<string>;
  readonly mainMigrationProblems: ReadonlyArray<string>;
  readonly unlistedMigrationFiles: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<{ readonly name: string; readonly onMain: boolean }>;
}

function compareState(
  before: Snapshot,
  now: CurrentState,
  accepted: ReadonlyArray<string> = [],
): Findings {
  const failures: string[] = [];
  const notes: string[] = [];
  // An item the rebase report accepted on purpose moves from failures to a note.
  const open = (items: ReadonlyArray<string>) => {
    const kept = items.filter((item) => !accepted.some((text) => item.includes(text)));
    if (kept.length < items.length)
      notes.push(
        `ACCEPTED (list in the report): ${items.filter((item) => !kept.includes(item)).join(" | ")}`,
      );
    return kept;
  };

  const lostFiles = open(before.forkAdded.filter((file) => !now.files.has(file)));
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
  const dropsOpen = open(drops.map(([f, was, is]) => `${f}: ${was} -> ${is}`));
  if (dropsOpen.length > 0)
    failures.push(
      `${dropsOpen.length} file(s) lost most of their fork delta (substantive added lines, before -> after):\n${dropsOpen.map((f) => `    ${f}`).join("\n")}`,
    );

  const dropped = new Set(drops.map(([file]) => file));
  const reset = open(
    resetToUpstreamFiles(before.delta, now.delta, now.files, now.upstreamChanged).filter(
      (entry) => !dropped.has(entry.split(": ")[0]!),
    ),
  );
  if (reset.length > 0)
    failures.push(
      `file(s) the old fork changed now equal upstream's version (fork delta before -> after; a conflict resolved toward upstream, or upstream now does the same):\n${reset.map((f) => `    ${f}`).join("\n")}`,
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
  const lostContentOpen = open(lostContent);
  if (lostContentOpen.length > 0)
    failures.push(
      `fork commit(s) are gone and the files they changed lost their fork delta:\n${lostContentOpen.map((s) => `    ${s}`).join("\n")}`,
    );
  if (squashed.length > 0)
    notes.push(
      `${squashed.length} fork commit subject(s) no longer exist (squashed or reworded; content survives).`,
    );

  const shrunk = open(shrunkCommits(before.commits, now.subjects));
  if (shrunk.length > 0)
    failures.push(
      `fork commit(s) kept their subject but shrank sharply:\n${shrunk.map((s) => `    ${s}`).join("\n")}`,
    );

  const lostFacts: string[] = [];
  for (const [file, facts] of Object.entries(before.workflowFacts)) {
    if (!now.files.has(file)) continue;
    const { lost, superseded } = lostWorkflowFacts(
      facts,
      before.workflowBaseFacts[file] ?? [],
      now.upstreamWorkflowFacts[file] ?? [],
      now.workflowFacts[file] ?? [],
    );
    lostFacts.push(...lost.map((fact) => `${file}: ${fact}`));
    if (superseded.length > 0)
      notes.push(
        `${file}: ${superseded.length} fork workflow fact(s) superseded by upstream's change: ${superseded.join("; ")}`,
      );
  }
  for (const [file, upstreamFacts] of Object.entries(now.upstreamWorkflowFacts)) {
    if (!now.files.has(file)) continue;
    lostFacts.push(
      ...missedUpstreamWorkflowFacts(
        before.workflowBaseFacts[file] ?? [],
        upstreamFacts,
        now.workflowFacts[file] ?? [],
      ).map((fact) => `${file}: ${fact} (upstream added it)`),
    );
  }
  const lostFactsOpen = open(lostFacts);
  if (lostFactsOpen.length > 0)
    failures.push(
      `workflow structure missing (fork-owned, or added by upstream to a kept job; job, needs, if, runs-on, matrix key, step name):\n${lostFactsOpen.map((f) => `    ${f}`).join("\n")}`,
    );
  const blacksmith = (facts: Readonly<Record<string, ReadonlyArray<string>>>) =>
    Object.entries(facts).flatMap(([file, list]) =>
      list.filter((fact) => /\|runs-on:.*blacksmith-/.test(fact)).map((fact) => `${file}: ${fact}`),
    );
  if (blacksmith(before.workflowFacts).length === 0 && blacksmith(now.workflowFacts).length > 0)
    failures.push(
      `upstream's blacksmith-* runner labels came back (the fork runs on GitHub-hosted runners):\n${blacksmith(
        now.workflowFacts,
      )
        .map((f) => `    ${f}`)
        .join("\n")}`,
    );
  if (now.upstreamNotCarried.length > 0)
    notes.push(
      `REVIEW: upstream added these workflow/pnpm lines since the old base and the result does not carry them. Each is either an intentional fork decision (say so in the report) or a conflict resolved toward the fork's older behavior:\n${now.upstreamNotCarried.map((l) => `    ${l}`).join("\n")}`,
    );

  const lostPinned: string[] = [];
  for (const [file, added] of Object.entries(before.pinnedLines))
    if (now.pinnedNow[file] !== undefined)
      lostPinned.push(
        ...lostPinnedLines(added, now.pinnedNow[file], now.pinnedUpstream[file] ?? new Set()).map(
          (line) => `${file}: ${line}`,
        ),
      );
    else lostPinned.push(`${file}: file is gone`);
  const lostPinnedOpen = open(lostPinned);
  if (lostPinnedOpen.length > 0)
    failures.push(
      `${lostPinnedOpen.length} line(s) the fork added to pinned files are gone (pnpm overrides, migrate-dev-db lists, migration entries):\n${lostPinnedOpen
        .slice(0, 40)
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );

  const lowered = loweredBudgets(before.budget, before.budgetBase, now.budgetUpstream, now.budget);
  if (lowered.length > 0)
    failures.push(
      `${BUDGET_FILE} was lowered or reset below the fork's value:\n${lowered.map((l) => `    ${l}`).join("\n")}`,
    );

  const grownT3 = open(grownT3Files(before.t3Counts, now.t3Counts));
  if (grownT3.length > 0)
    failures.push(
      `T3-spelled text came back (lines with T3 / t3_ / t3- tokens, before -> after). Rebrand each, or exempt a real compat hit in check-rebrand:\n${grownT3
        .slice(0, 60)
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );
  const newLinks = open(now.storeLinks.filter((link) => !before.storeLinks.includes(link)));
  if (newLinks.length > 0)
    failures.push(
      `new app-store link(s) (file:url) not in the old fork; upstream's links point at upstream's apps:\n${newLinks.map((l) => `    ${l}`).join("\n")}`,
    );

  const deleted = new Set(before.forkDeleted);
  const strayMissing = open(now.upstreamMissing.filter((file) => !deleted.has(file)));
  if (strayMissing.length > 0)
    failures.push(
      `${strayMissing.length} file(s) exist at upstream's tip, were not deleted by the old fork, and are missing from the result:\n${strayMissing
        .slice(0, 40)
        .map((f) => `    ${f}`)
        .join("\n")}`,
    );
  const lostRules = open(
    now.upstreamMissing.filter((file) => /^oxlint-plugin-[^/]+\/rules\//.test(file)),
  );
  if (lostRules.length > 0)
    failures.push(
      `lint rule file(s) upstream has are missing (also check where vite.config.ts enables each):\n${lostRules.map((f) => `    ${f}`).join("\n")}`,
    );
  const keptDeletions = now.upstreamMissing.filter(
    (file) => deleted.has(file) && !isTestFile(file) && /\.(ts|tsx|json|ya?ml|md)$/.test(file),
  );
  if (keptDeletions.length > 0)
    notes.push(
      `REVIEW: ${keptDeletions.length} non-test file(s) upstream still has were deleted by the fork and stay deleted (a lint rule, config or doc lost in an earlier replay looks the same as a deliberate removal):\n${keptDeletions
        .slice(0, 40)
        .map((f) => `    ${f}`)
        .join("\n")}`,
    );

  const goneSpaces = before.spacesMigrations.filter(
    ([id, name]) => !now.spacesMigrations.some(([i, n]) => i === id && n === name),
  );
  if (goneSpaces.length > 0)
    failures.push(`Spaces migration(s) no longer registered: ${ids(goneSpaces).join(", ")}`);

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

  const newOrphans = open(now.orphans.filter((file) => !before.orphans.includes(file)));
  if (newOrphans.length > 0)
    failures.push(
      `${newOrphans.length} fork file(s) exist but nothing imports them any more:\n${newOrphans.map((f) => `    ${f}`).join("\n")}`,
    );

  if (now.missingUpstreamTests.length > 0)
    failures.push(
      `upstream test file(s) missing in the fork while their source exists:\n${now.missingUpstreamTests.map((f) => `    ${f}`).join("\n")}`,
    );
  const newDrops = open(now.droppedTests.filter((entry) => !before.droppedTests.includes(entry)));
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
      `migration file(s) that their ledger does not register:\n${now.unlistedMigrationFiles.map((f) => `    ${f}`).join("\n")}`,
    );

  const offMain = now.tags.filter((tag) => !tag.onMain);
  notes.push(
    offMain.length === 0
      ? `release tags: the ${now.tags.length} most recent tag(s) are all ancestors of HEAD.`
      : `release tags NOT reachable from HEAD (report only): ${offMain.map((t) => t.name).join(", ")}`,
  );
  return { failures, notes };
}

function commitList(cwd: string, base: string, head: string) {
  const lineCounts = new Map<string, number>();
  for (const chunk of git(
    ["log", "--no-merges", "--numstat", "--no-renames", "--format=%x01%s", `${base}..${head}`],
    cwd,
  )
    .split("\u0001")
    .filter((c) => c.trim() !== "")) {
    const [subject = "", ...rest] = chunk.split("\n");
    const added = rest.reduce((sum, row) => sum + (Number(row.split("\t")[0]) || 0), 0);
    lineCounts.set(subject, (lineCounts.get(subject) ?? 0) + added);
  }
  const out = git(
    ["log", "--no-merges", "--name-status", "--no-renames", "--format=%x01%s", `${base}..${head}`],
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
        lines: lineCounts.get(subject) ?? 0,
        empty: entries.length === 0,
      };
    });
}

function importedSpecifiers(cwd: string, head: string): ReadonlyArray<string> {
  const out = git(
    [
      "grep",
      "-h",
      "-o",
      "-E",
      "(from|import\\(|require\\()\\s*[\"'][^\"']+[\"']",
      head,
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

function collectState(
  cwd: string,
  upstreamRef: string,
  forkAdded: ReadonlyArray<string>,
  headRef: string,
) {
  const base = git(["merge-base", headRef, upstreamRef], cwd).trim();
  const head = git(["rev-parse", headRef], cwd).trim();
  const headFiles = treeFiles(cwd, head);
  const baseFiles = treeFiles(cwd, base);

  const status = git(["diff", "--name-status", "--no-renames", "-z", base, head], cwd)
    .split("\0")
    .filter((entry) => entry !== "");
  const added: string[] = [];
  const deleted: string[] = [];
  for (let index = 0; index + 1 < status.length; index += 2) {
    if (status[index] === "A") added.push(status[index + 1]!);
    if (status[index] === "D") deleted.push(status[index + 1]!);
  }

  const delta = substantiveAddedLines(
    git(["diff", "-U0", "--no-color", "--no-renames", "--no-ext-diff", base, head], cwd),
  );
  const commits = commitList(cwd, base, head);

  const cliSource = show(cwd, head, CLI_FILE) ?? "";
  const rpcSource = show(cwd, head, RPC_FILE) ?? "";
  const mainSource = show(cwd, head, MAIN_MIGRATIONS_FILE) ?? "";
  const mainEntries = parseMigrationEntries(mainSource);
  const upstreamMain = parseMigrationEntries(show(cwd, base, MAIN_MIGRATIONS_FILE) ?? "");
  const unlistedMigrationFiles = [
    ...unlistedLedgerFiles(headFiles, MIGRATIONS_DIR, mainSource),
    ...LEDGERS.flatMap(({ file, dir }) =>
      unlistedLedgerFiles(headFiles, dir, show(cwd, head, file) ?? ""),
    ),
  ];

  const candidates = (forkAdded.length > 0 ? forkAdded : added).filter(
    (file) => headFiles.has(file) && isOrphanCandidate(file),
  );
  const orphans = findOrphans(candidates, importedNames(importedSpecifiers(cwd, head)));

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
    pairs.map(({ here }) => `${head}:${here}`),
  );
  for (const { file, here } of pairs) {
    const ours = new Set(parseTestTitles(oursBlobs.get(`${head}:${here}`) ?? ""));
    for (const title of parseTestTitles(theirsBlobs.get(`${base}:${file}`) ?? ""))
      if (!ours.has(title)) droppedTests.push(`${here}: ${title}`);
  }

  const upstreamFiles = treeFiles(cwd, upstreamRef);
  const workflowFilesOf = (files: ReadonlySet<string>) =>
    [...files].filter((file) => WORKFLOW_FILE.test(file)).toSorted();
  const factsAt = (ref: string, files: ReadonlyArray<string>) => {
    const blobs = readBlobs(
      cwd,
      files.map((file) => `${ref}:${file}`),
    );
    return Object.fromEntries(
      files.flatMap((file) => {
        const text = blobs.get(`${ref}:${file}`);
        return text === undefined ? [] : [[file, parseWorkflowFacts(text)] as const];
      }),
    );
  };
  const pinnedAt = (ref: string) =>
    Object.fromEntries(
      PINNED_FILES.flatMap((file) => {
        const text = show(cwd, ref, file);
        return text === null ? [] : [[file, significantLines(text, true)] as const];
      }),
    );
  const pinnedNow = pinnedAt(head);
  const pinnedBase = pinnedAt(base);
  const pinnedLines = Object.fromEntries(
    Object.entries(pinnedNow).map(([file, set]) => [
      file,
      [...set].filter((line) => !pinnedBase[file]?.has(line)).toSorted(),
    ]),
  );

  const upstreamMissing = [...upstreamFiles]
    .filter(
      (f) => !f.startsWith(".repos/") && !headFiles.has(f) && !headFiles.has(normalizeRename(f)),
    )
    .toSorted();

  const tags = lines(git(["tag", "--list", "v*", "--sort=-creatordate"], cwd, true))
    .slice(0, 20)
    .map((name) => ({
      name,
      onMain: execFileSyncOk(["merge-base", "--is-ancestor", name, head], cwd),
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
    forkMigrations: parseMigrationEntries(show(cwd, head, FORK_MIGRATIONS_FILE) ?? ""),
    mainMigrationProblems: compareMigrationChains(mainEntries, upstreamMain),
    unlistedMigrationFiles,
    tags,
    upstreamMissing,
    spacesMigrations: parseMigrationEntries(show(cwd, head, SPACES_MIGRATIONS_FILE) ?? ""),
    workflowFacts: factsAt(head, workflowFilesOf(headFiles)),
    workflowBaseFacts: factsAt(base, workflowFilesOf(baseFiles)),
    upstreamWorkflowFacts: factsAt(upstreamRef, workflowFilesOf(upstreamFiles)),
    pinnedNow,
    pinnedUpstream: pinnedAt(upstreamRef),
    pinnedLines,
    budget: parseBudget(show(cwd, head, BUDGET_FILE)),
    budgetBase: parseBudget(show(cwd, base, BUDGET_FILE)),
    budgetUpstream: parseBudget(show(cwd, upstreamRef, BUDGET_FILE)),
    t3Counts: t3Counts(cwd, head),
    storeLinks: storeLinks(cwd, head),
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

export function takeSnapshot(cwd: string, upstreamRef: string, headRef = "HEAD"): Snapshot {
  const state = collectState(cwd, upstreamRef, [], headRef);
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    upstreamRef,
    mergeBase: state.base,
    head: state.head,
    forkAdded: state.added.toSorted(),
    forkDeleted: state.deleted.toSorted(),
    delta: state.delta,
    commits: state.commits.map(({ subject, added, files, lines, empty }) => ({
      subject,
      added,
      files,
      lines,
      empty,
    })),
    cliCommands: state.cliCommands,
    rpcRegistered: state.rpcRegistered,
    orphans: state.orphans,
    droppedTests: state.droppedTests,
    workflows: state.workflows,
    forkMigrations: state.forkMigrations,
    spacesMigrations: state.spacesMigrations,
    workflowFacts: state.workflowFacts,
    workflowBaseFacts: state.workflowBaseFacts,
    pinnedLines: state.pinnedLines,
    budget: state.budget,
    budgetBase: state.budgetBase,
    t3Counts: state.t3Counts,
    storeLinks: state.storeLinks,
  };
}

export function verifySnapshot(
  cwd: string,
  upstreamRef: string,
  before: Snapshot,
  headRef = "HEAD",
  accepted: ReadonlyArray<string> = [],
): Findings {
  const state = collectState(cwd, upstreamRef, before.forkAdded, headRef);
  const subjects = new Map<string, { empty: boolean; lines: number }>();
  for (const c of state.commits) {
    const seen = subjects.get(c.subject);
    subjects.set(c.subject, {
      empty: c.empty && (seen?.empty ?? true),
      lines: c.lines + (seen?.lines ?? 0),
    });
  }
  return compareState(
    before,
    {
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
      spacesMigrations: state.spacesMigrations,
      upstreamMissing: state.upstreamMissing,
      workflowFacts: state.workflowFacts,
      upstreamWorkflowFacts: state.upstreamWorkflowFacts,
      pinnedNow: state.pinnedNow,
      pinnedUpstream: state.pinnedUpstream,
      budget: state.budget,
      budgetUpstream: state.budgetUpstream,
      t3Counts: state.t3Counts,
      storeLinks: state.storeLinks,
      upstreamChanged: changedBetween(cwd, before.mergeBase, upstreamRef),
      upstreamNotCarried: upstreamNotCarried(cwd, before.mergeBase, upstreamRef, state.head),
      mainMigrationProblems: state.mainMigrationProblems,
      unlistedMigrationFiles: state.unlistedMigrationFiles,
      tags: state.tags,
    },
    accepted,
  );
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
  const head = option(argv, "--head", "HEAD");
  const accepted = argv.flatMap((arg, i) =>
    arg === "--accept" && argv[i + 1] ? [argv[i + 1]!] : [],
  );
  if (mode === "snapshot") {
    const snapshot = takeSnapshot(cwd, upstream, head);
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
    const { failures, notes } = verifySnapshot(cwd, upstream, before, head, accepted);
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
    "usage: node scripts/check-rebase-safety.ts <snapshot|verify> [--file <path>] [--upstream <ref>] [--head <ref>] [--accept <text>]...",
  );
  return 2;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
