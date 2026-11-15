// @effect-diagnostics nodeBuiltinImport:off - zero-dependency git readers for check-rebase-safety.
// Everything is read from commits, never from the working tree.
import * as NodeChildProcess from "node:child_process";

import { normalizeRename, significantLines, WORKFLOW_FILE } from "./rebase-safety-parsers.ts";

const isUpstreamReviewFile = (file: string) =>
  WORKFLOW_FILE.test(file) || file === "pnpm-workspace.yaml";
const STORE_LINK =
  "https?://(apps\\.apple\\.com|play\\.google\\.com|testflight\\.apple\\.com)/[^][ )\"'>`<]*";
const T3_TOKEN = "\\bT3\\b|\\bt3[_-]|T3CODE_";
const T3_EXEMPT = [
  /^\.repos\//,
  /(^|\/)pnpm-lock\.yaml$/,
  /^\.agents\/skills\/rebase-with-upstream\//,
  /^scripts\/(check-rebrand|rebrand-baseline)/,
  /legacyT3Identity/,
  /\.(ndjson|snap)$/,
];

export function git(args: ReadonlyArray<string>, cwd: string, allowFailure = false): string {
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

export const lines = (text: string) => text.split("\n").filter((line) => line !== "");

export function show(cwd: string, ref: string, file: string): string | null {
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

export function readBlobs(cwd: string, specs: ReadonlyArray<string>): ReadonlyMap<string, string> {
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

export function treeFiles(cwd: string, ref: string): ReadonlySet<string> {
  return new Set(
    git(["ls-tree", "-r", "--name-only", "-z", ref], cwd)
      .split("\0")
      .filter((file) => file !== ""),
  );
}

export function t3Counts(cwd: string, ref: string): Record<string, number> {
  const out = git(["grep", "-c", "-I", "-E", T3_TOKEN, ref, "--", ".", ":!.repos"], cwd, true);
  const counts: Record<string, number> = {};
  for (const row of lines(out)) {
    const match = /^(.*):(\d+)$/.exec(row.slice(ref.length + 1));
    if (match && !T3_EXEMPT.some((pattern) => pattern.test(match[1]!)))
      counts[match[1]!] = Number(match[2]);
  }
  return counts;
}

export function storeLinks(cwd: string, ref: string): ReadonlyArray<string> {
  const out = git(["grep", "-o", "-I", "-E", STORE_LINK, ref, "--", ".", ":!.repos"], cwd, true);
  return [...new Set(lines(out).map((row) => row.slice(ref.length + 1)))].toSorted();
}

const forkRepo = (row: string) => row.replaceAll("pingdotgg/t2code", "ashutoshpw/t2code");

/** Lines upstream added to workflow/pnpm files since the old base that the result does not carry. */
export function upstreamNotCarried(
  cwd: string,
  oldBase: string,
  upstreamRef: string,
  head: string,
): ReadonlyArray<string> {
  const changed = lines(
    git(["diff", "--name-only", "--no-renames", oldBase, upstreamRef], cwd, true),
  );
  return changed.filter(isUpstreamReviewFile).flatMap((file) => {
    const current = show(cwd, head, file);
    if (current === null) return [];
    const have = new Set([...significantLines(current)].map(forkRepo));
    const diff = git(
      ["diff", "-U0", "--no-color", "--no-ext-diff", oldBase, upstreamRef, "--", file],
      cwd,
      true,
    );
    const missing = diff
      .split("\n")
      .filter((row) => row.startsWith("+") && !row.startsWith("+++"))
      .map((row) => forkRepo(normalizeRename(row.slice(1).trim())))
      .filter((row) => /[A-Za-z0-9]{3}/.test(row) && !/blacksmith/.test(row) && !have.has(row));
    return [...new Set(missing)].slice(0, 12).map((row) => `${file}: ${row}`);
  });
}

export function changedBetween(cwd: string, from: string, to: string): ReadonlySet<string> {
  return new Set(lines(git(["diff", "--name-only", "--no-renames", from, to], cwd, true)));
}
