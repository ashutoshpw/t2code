#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - zero-dependency git hook CLI; uses Node builtins and console directly.
// Offline link checker for tracked Markdown. Relative link targets must exist
// and heading anchors must resolve, so a rename like
// docs/internals/t3-connect.md -> t2-connect.md cannot leave stale links
// behind. External URLs are intentionally not fetched (flaky and rate limited).
//
// Usage:
//   node scripts/check-doc-links.ts

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const SELF_DIR = NodePath.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = NodePath.resolve(SELF_DIR, "..");

// Trees whose Markdown describes vendored or upstream sources; their relative
// links are not ours to maintain.
const SKIPPED_PREFIXES = [".agents/", ".repos/", "node_modules/"];

const ANGLE_LINK_PATTERN = /!?\[[^\]]*\]\(\s*<([^>]+)>\s*\)/g;
const PLAIN_LINK_PATTERN = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const REFERENCE_DEFINITION_PATTERN = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/;
const INLINE_CODE_PATTERN = /`[^`]*`/g;

export type DocLink = { line: number; target: string };
export type DocLinkViolation = { file: string; line: number; target: string; reason: string };

function isExternalTarget(target: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

function isSkippedPath(file: string): boolean {
  return SKIPPED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractDocLinks(markdown: string): DocLink[] {
  const links: DocLink[] = [];
  let inFence = false;
  for (const [index, rawLine] of markdown.split("\n").entries()) {
    if (/^\s{0,3}(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const line = rawLine.replace(INLINE_CODE_PATTERN, "");
    const targets: string[] = [];
    const withoutAngleLinks = line.replace(ANGLE_LINK_PATTERN, (_match, target: string) => {
      targets.push(target);
      return "";
    });
    for (const match of withoutAngleLinks.matchAll(PLAIN_LINK_PATTERN)) {
      targets.push(match[1] as string);
    }
    const definition = REFERENCE_DEFINITION_PATTERN.exec(line);
    if (definition) targets.push(definition[1] as string);

    for (const target of targets) {
      if (isExternalTarget(target)) continue;
      links.push({ line: index + 1, target });
    }
  }
  return links;
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`~]/g, "")
    .replace(/<[^>]+>/g, "");
}

// Mirrors GitHub's heading slugger: punctuation is dropped (which can leave
// consecutive spaces, and therefore consecutive hyphens) and every remaining
// whitespace character becomes one hyphen.
export function githubHeadingSlug(heading: string): string {
  return stripInlineMarkdown(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function markdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let inFence = false;
  for (const rawLine of markdown.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(rawLine);
    if (heading) {
      const base = githubHeadingSlug((heading[1] as string).replace(/\s*#+\s*$/, ""));
      if (base.length === 0) continue;
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of rawLine.matchAll(/<a\s+(?:name|id)="([^"]+)"/gi)) {
      anchors.add(match[1] as string);
    }
    for (const match of rawLine.matchAll(/\bid="([^"]+)"/gi)) {
      anchors.add(match[1] as string);
    }
  }
  return anchors;
}

function checkTarget(
  file: string,
  target: string,
  files: ReadonlyMap<string, string>,
  exists: (repoPath: string) => boolean,
): string | undefined {
  const hashIndex = target.indexOf("#");
  const withoutHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : safeDecode(target.slice(hashIndex + 1));
  const path = safeDecode(withoutHash.split("?")[0] as string);

  if (path.length === 0) {
    if (hash.length === 0) return undefined;
    return anchorExists(file, hash, files) ? undefined : `missing anchor "#${hash}"`;
  }
  if (path.startsWith("/")) return undefined;

  const resolved = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(file), path),
  );
  if (resolved.startsWith("..")) return "target escapes the repository";
  if (isSkippedPath(resolved)) return undefined;
  if (!exists(resolved)) return "target does not exist";
  if (hash.length === 0 || !resolved.endsWith(".md")) return undefined;

  const content = files.get(resolved);
  if (content === undefined) return undefined;
  return markdownAnchors(content).has(hash) ? undefined : `missing anchor "#${hash}"`;
}

function anchorExists(file: string, hash: string, files: ReadonlyMap<string, string>): boolean {
  const content = files.get(file);
  return content === undefined ? true : markdownAnchors(content).has(hash);
}

export function findDocLinkViolations(
  files: ReadonlyMap<string, string>,
  exists: (repoPath: string) => boolean,
): DocLinkViolation[] {
  const violations: DocLinkViolation[] = [];
  for (const [file, content] of files) {
    for (const link of extractDocLinks(content)) {
      const reason = checkTarget(file, link.target, files, exists);
      if (reason) violations.push({ file, line: link.line, target: link.target, reason });
    }
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return violations;
}

function trackedMarkdownFiles(): string[] {
  const output = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "*.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return output
    .split("\0")
    .filter((file) => file.length > 0 && !isSkippedPath(file))
    .sort();
}

function main(): number {
  const files = new Map<string, string>();
  for (const file of trackedMarkdownFiles()) {
    files.set(file, NodeFS.readFileSync(NodePath.join(REPO_ROOT, file), "utf8"));
  }
  const violations = findDocLinkViolations(files, (repoPath) =>
    NodeFS.existsSync(NodePath.join(REPO_ROOT, repoPath)),
  );
  if (violations.length === 0) {
    process.stdout.write(`doc links: ${files.size} Markdown files, no broken relative links\n`);
    return 0;
  }
  console.error(`doc links: ${violations.length} broken relative link(s) found.`);
  for (const violation of violations) {
    console.error(`\n  ${violation.file}:${violation.line}`);
    console.error(`    -> ${violation.target} (${violation.reason})`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
