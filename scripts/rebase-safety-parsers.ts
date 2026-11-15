// @effect-diagnostics nodeBuiltinImport:off - zero-dependency pure helpers for check-rebase-safety.
// Parsers and comparers that read text only; the git and CLI plumbing lives in the sibling files.
import * as NodePath from "node:path";

export const DROP_MIN_LINES = 20;
export const DROP_RATIO = 0.5;
export const WORKFLOW_FILE = /^\.github\/workflows\/.+\.ya?ml$/;

export type MigrationEntry = readonly [id: number, name: string];
export type Budget = Readonly<Record<string, number>>;

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

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

export function testSourceFile(file: string): string {
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

/** Lines that carry meaning: rename-normalised, trimmed, and not just punctuation. */
export function significantLines(text: string, skipComments = false): ReadonlySet<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => normalizeRename(line.trim()))
      .filter((line) => /[A-Za-z0-9]{3}/.test(line) && !(skipComments && /^(#|\/\/)/.test(line))),
  );
}

/** Structural facts of a workflow: jobs, their needs/if/runs-on/matrix keys, step names, triggers. */
export function parseWorkflowFacts(source: string): ReadonlyArray<string> {
  const facts = new Set<string>();
  const rows = source
    .split("\n")
    .map((raw) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim() }))
    .filter((row) => row.text !== "" && !row.text.startsWith("#"));
  const keyOf = (text: string) =>
    text
      .replace(/^-\s+/, "")
      .replace(/\s*:.*$/, "")
      .replace(/["']/g, "");
  const valueOf = (text: string) => text.slice(text.indexOf(":") + 1).trim();
  const flat = (text: string) =>
    normalizeRename(text.replace(/\s+/g, " ").replace(/^(["'])(.*)\1$/, "$2"));
  const children = (from: number, indent: number) => {
    const out: string[] = [];
    for (let j = from + 1; j < rows.length && rows[j]!.indent > indent; j += 1)
      out.push(rows[j]!.text);
    return out;
  };
  let section = "";
  let job = "";
  let block = "";
  let sub = "";
  for (let i = 0; i < rows.length; i += 1) {
    const { indent, text } = rows[i]!;
    if (indent === 0) {
      section = keyOf(text);
      job = "";
      continue;
    }
    if (section === "on" && indent === 2) facts.add(`on:${keyOf(text)}`);
    if (section !== "jobs") continue;
    if (indent === 2) {
      job = keyOf(text);
      block = "";
      facts.add(`job:${job}`);
      continue;
    }
    if (job === "") continue;
    const at = `job:${job}`;
    if (indent === 4) {
      block = keyOf(text);
      sub = "";
      const inline = valueOf(text);
      const value = /^[>|][+-]?$/.test(inline) || inline === "" ? children(i, 4).join(" ") : inline;
      if (block === "if" || block === "runs-on") facts.add(`${at}|${block}:${flat(value)}`);
      if (block === "needs")
        for (const need of value.replace(/[[\]]/g, "").split(/[,\s]+/))
          if (need !== "" && need !== "-") facts.add(`${at}|needs:${need}`);
    } else if (block === "strategy") {
      if (indent === 6) {
        sub = keyOf(text);
        if (sub !== "matrix") facts.add(`${at}|strategy:${sub}`);
      } else if (sub === "matrix" && indent === 8) facts.add(`${at}|matrix:${keyOf(text)}`);
    } else if (block === "steps" && indent === 6 && text.startsWith("- ")) {
      const item = [text.slice(2), ...children(i, 6)];
      const named = item.map((row) => /^name:\s*(.+)$/.exec(row)?.[1]).find(Boolean);
      const used = item.map((row) => /^uses:\s*(.+)$/.exec(row)?.[1]).find(Boolean);
      if (named) facts.add(`${at}|step:${flat(named)}`);
      else if (used) facts.add(`${at}|uses:${flat(used)}`);
    }
  }
  return [...facts].toSorted();
}

const SINGLE_VALUED_FACT = /^(job:[^|]+\|(?:if|needs)):/;

/**
 * Workflow facts the old fork had and the result lost. A fact upstream still has is a loss.
 * A fork-owned fact survives unless upstream changed that attribute or removed the job.
 */
export function lostWorkflowFacts(
  fork: ReadonlyArray<string>,
  base: ReadonlyArray<string>,
  upstream: ReadonlyArray<string>,
  now: ReadonlyArray<string>,
): { readonly lost: ReadonlyArray<string>; readonly superseded: ReadonlyArray<string> } {
  const baseSet = new Set(base);
  const upstreamSet = new Set(upstream);
  const nowSet = new Set(now);
  const attribute = (facts: ReadonlyArray<string>, prefix: string) =>
    facts
      .filter((fact) => fact.startsWith(prefix))
      .toSorted()
      .join("\n");
  const lost: string[] = [];
  const superseded: string[] = [];
  for (const fact of fork) {
    if (nowSet.has(fact)) continue;
    if (upstreamSet.has(fact)) {
      lost.push(fact);
      continue;
    }
    if (baseSet.has(fact)) continue;
    const jobId = /^job:([^|]+)/.exec(fact)?.[1];
    const jobGone =
      jobId !== undefined && baseSet.has(`job:${jobId}`) && !upstreamSet.has(`job:${jobId}`);
    const prefix = SINGLE_VALUED_FACT.exec(fact)?.[1];
    const moved = prefix !== undefined && attribute(base, prefix) !== attribute(upstream, prefix);
    (jobGone || moved ? superseded : lost).push(fact);
  }
  return { lost, superseded };
}

const forkRepoName = (fact: string) => fact.replaceAll("pingdotgg/t2code", "ashutoshpw/t2code");
const BLACKSMITH_FACT = /\|runs-on:.*blacksmith|\|(?:uses|step):.*useblacksmith/;

/**
 * Facts upstream added since the base to a job the result still has, that the result lacks.
 * Blacksmith runner labels and steps are skipped: the fork runs on GitHub-hosted runners.
 */
export function missedUpstreamWorkflowFacts(
  base: ReadonlyArray<string>,
  upstream: ReadonlyArray<string>,
  now: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const baseSet = new Set(base.map(forkRepoName));
  const nowSet = new Set(now.map(forkRepoName));
  return upstream.map(forkRepoName).filter((fact) => {
    const jobId = /^job:([^|]+)\|/.exec(fact)?.[1];
    return (
      jobId !== undefined &&
      !baseSet.has(fact) &&
      !nowSet.has(fact) &&
      nowSet.has(`job:${jobId}`) &&
      !BLACKSMITH_FACT.test(fact)
    );
  });
}

/** Files the old fork changed that now carry no fork delta although upstream changed them too. */
export function resetToUpstreamFiles(
  before: Readonly<Record<string, number>>,
  now: Readonly<Record<string, number>>,
  present: ReadonlySet<string>,
  upstreamChanged: ReadonlySet<string>,
): ReadonlyArray<string> {
  return Object.entries(before)
    .filter(
      ([file, was]) =>
        was > 0 && (now[file] ?? 0) === 0 && present.has(file) && upstreamChanged.has(file),
    )
    .map(([file, was]) => `${file}: ${was} -> 0`)
    .toSorted();
}

/** Significant fork-added lines (vs base) that neither the result nor upstream's tip carries. */
export function lostPinnedLines(
  added: ReadonlyArray<string>,
  now: ReadonlySet<string>,
  upstream: ReadonlySet<string>,
): ReadonlyArray<string> {
  return added.filter((line) => !now.has(line) && !upstream.has(line));
}

export function parseBudget(source: string | null): Budget {
  try {
    const parsed = JSON.parse(source ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
}

/** Budgets must not drop below the fork's value unless upstream itself moved that number to this one. */
export function loweredBudgets(
  fork: Budget,
  base: Budget,
  upstream: Budget,
  now: Budget,
): ReadonlyArray<string> {
  return Object.entries(fork)
    .filter(([key, was]) => {
      const is = now[key];
      if (is !== undefined && is >= was) return false;
      return !(is !== undefined && upstream[key] === is && upstream[key] !== base[key]);
    })
    .map(([key, was]) => `${key}: ${was} -> ${now[key] ?? "missing"}`);
}

/** Per-file increase in T3-spelled tokens; files absent from the old fork count from zero. */
export function grownT3Files(
  before: Readonly<Record<string, number>>,
  now: Readonly<Record<string, number>>,
): ReadonlyArray<string> {
  return Object.entries(now)
    .filter(([file, count]) => count > (before[file] ?? 0))
    .map(([file, count]) => `${file}: ${before[file] ?? 0} -> ${count}`)
    .toSorted();
}

/** Commits that kept their subject but lost most of their added lines. */
export function shrunkCommits(
  before: ReadonlyArray<{ readonly subject: string; readonly lines: number }>,
  now: ReadonlyMap<string, { readonly lines: number }>,
): ReadonlyArray<string> {
  return before
    .map((commit) => [commit, now.get(commit.subject)?.lines] as const)
    .filter(
      ([commit, lines]) =>
        lines !== undefined &&
        commit.lines - lines >= DROP_MIN_LINES &&
        lines < commit.lines * DROP_RATIO,
    )
    .map(([commit, lines]) => `${commit.subject}: ${commit.lines} -> ${lines} added lines`);
}

/** Migration files in `dir` that the ledger source does not import. */
export function unlistedLedgerFiles(
  headFiles: ReadonlySet<string>,
  dir: string,
  source: string,
): ReadonlyArray<string> {
  const registered = new Set(
    [...source.matchAll(/from\s+"\.\/[A-Za-z]*Migrations\/([^"]+)"/g)].map((match) => match[1]!),
  );
  return [...headFiles]
    .filter((file) => file.startsWith(dir) && /\/\d+_[^/]+\.ts$/.test(file))
    .filter((file) => !/\.test\.ts$/.test(file))
    .filter((file) => !registered.has(NodePath.basename(file)))
    .toSorted();
}

export const ids = (entries: ReadonlyArray<MigrationEntry>) =>
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
