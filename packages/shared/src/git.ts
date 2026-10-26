import type {
  BranchNamingOptions,
  VcsRef,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t2code/contracts";
import { WORKTREE_BRANCH_PREFIX } from "@t2code/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";

export { WORKTREE_BRANCH_PREFIX };

const TEMP_WORKTREE_HEX_TOKEN = "[0-9a-f]{8}";
const tempWorktreeBranchPatternCache = new Map<string, RegExp>();

function escapeRegExpFragment(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recognized temporary-branch prefixes: the configured server prefix (when the
 * caller knows it) ahead of the canonical default.
 */
export function temporaryWorktreeBranchPrefixes(
  configuredPrefix?: string | null,
): ReadonlyArray<string> {
  const prefixes = [WORKTREE_BRANCH_PREFIX];
  const configured = sanitizeWorktreeBranchPrefix(configuredPrefix ?? "");
  if (!prefixes.includes(configured)) {
    prefixes.unshift(configured);
  }
  return prefixes;
}

function temporaryWorktreeBranchPattern(prefixes: ReadonlyArray<string>): RegExp {
  const key = prefixes.join("|");
  const cached = tempWorktreeBranchPatternCache.get(key);
  if (cached) return cached;
  const patterns = prefixes.map((prefix) => {
    const escapedPrefix = escapeRegExpFragment(prefix);
    return `(?:${escapedPrefix}\\/${TEMP_WORKTREE_HEX_TOKEN}|${escapedPrefix}-${TEMP_WORKTREE_HEX_TOKEN})`;
  });
  const pattern = new RegExp(`^(?:${patterns.join("|")})$`);
  tempWorktreeBranchPatternCache.set(key, pattern);
  return pattern;
}

/** Sanitize an arbitrary string into a valid single-segment branch prefix. */
export function sanitizeWorktreeBranchPrefix(raw: string): string {
  const prefix = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return prefix.length > 0 ? prefix : WORKTREE_BRANCH_PREFIX;
}

/**
 * Turn an LLM-generated branch suggestion into the worktree-namespace branch
 * name `<prefix>/<slug>`: lowercase, sanitized fragment, prefix re-applied.
 */
export function buildGeneratedWorktreeBranchName(
  raw: string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
): string {
  const branchPrefix = sanitizeWorktreeBranchPrefix(prefix);
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  // A generated suggestion may echo any namespace we own (the configured one
  // or a default/legacy one); strip it so the prefix below is the only one.
  const withoutPrefix = temporaryWorktreeBranchPrefixes(branchPrefix).reduce(
    (acc, namespace) => (acc.startsWith(`${namespace}/`) ? acc.slice(namespace.length + 1) : acc),
    normalized,
  );

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${branchPrefix}/${safeFragment}`;
}

export function sanitizeBranchFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/^[./\s_-]+|[./\s_-]+$/g, "");

  const branchFragment = normalized
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  return branchFragment.length > 0 ? branchFragment : "update";
}

export function formatGeneratedBranchName(raw: string, naming?: BranchNamingOptions): string {
  if (naming?.mode === "custom") return raw.trim();
  const branch = sanitizeBranchFragment(raw);
  if (naming?.mode !== "static") return branch;
  const prefix = naming.prefix
    .split("/")
    .map((part) =>
      part
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("/");
  return prefix ? `${prefix}/${branch}` : branch;
}

export function sanitizeFeatureBranchName(raw: string): string {
  const sanitized = sanitizeBranchFragment(raw);
  return sanitized.includes("/") ? sanitized : `feature/${sanitized}`;
}

const AUTO_FEATURE_BRANCH_FALLBACK = "feature/update";

export function resolveAutoFeatureBranchName(
  existingBranchNames: readonly string[],
  preferredBranch?: string,
): string {
  const preferred = preferredBranch?.trim();
  const resolvedBase = sanitizeFeatureBranchName(
    preferred && preferred.length > 0 ? preferred : AUTO_FEATURE_BRANCH_FALLBACK,
  );
  const existingNames = existingBranchNames.map((refName) => refName.toLowerCase());
  const existingRefs = new Set(existingNames);
  const parts = resolvedBase.split("/");
  let resolved = "";

  for (const [index, part] of parts.entries()) {
    const base = resolved ? `${resolved}/${part}` : part;
    let candidate = base;
    let suffix = 2;
    while (
      existingRefs.has(candidate) ||
      (index === parts.length - 1 &&
        existingNames.some((refName) => refName.startsWith(`${candidate}/`)))
    ) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    resolved = candidate;
  }

  return resolved;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

export function buildTemporaryWorktreeBranchName(
  randomHex: (byteLength: number) => string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
): string {
  const token = randomHex(4)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "")
    .slice(0, 8);
  return `${sanitizeWorktreeBranchPrefix(prefix)}/${token}`;
}

/**
 * Git stores refs as paths, so a plain prefix branch makes every nested ref
 * below it impossible. Move a temporary branch to the flat sibling form.
 */
export function flattenTemporaryWorktreeBranchName(
  refName: string,
  prefix: string = WORKTREE_BRANCH_PREFIX,
): string {
  const normalized = refName.trim().toLowerCase();
  const tokenStart = normalized.search(/[-/]/) + 1;
  const token = normalized.slice(tokenStart, tokenStart + 8);
  return `${sanitizeWorktreeBranchPrefix(prefix)}-${token}`;
}

export function isTemporaryWorktreeBranch(
  refName: string,
  prefixes: ReadonlyArray<string> = temporaryWorktreeBranchPrefixes(),
): boolean {
  return temporaryWorktreeBranchPattern(prefixes).test(refName.trim().toLowerCase());
}

function lowerCaseRemote(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/**
 * The host and repository path a remote names, lower case and without a port, or null for a
 * remote that names no host, such as a local path.
 */
export function parseGitRemoteRepository(
  value: string,
): { readonly host: string; readonly path: string } | null {
  const normalized = lowerCaseRemote(value);

  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try {
      const url = new URL(normalized);
      const repositorySegments = url.pathname.split("/").filter((segment) => segment.length > 0);
      if (url.hostname && repositorySegments.length > 1) {
        return { host: url.hostname, path: repositorySegments.join("/") };
      }
    } catch {
      return null;
    }
  }

  // A userless one-letter prefix is a Windows drive, not an SCP host.
  const scpStyleHostAndPath = /^[a-z]:/i.test(normalized)
    ? null
    : /^(?:[a-zA-Z0-9._-]+@)?([^@:/\\\s]+):\/?([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
  const scpHost = scpStyleHostAndPath?.[1];
  const scpPath = scpStyleHostAndPath?.[2];
  return scpHost && scpPath ? { host: scpHost, path: scpPath } : null;
}

/**
 * `host/path` for a remote that names a host, otherwise the remote itself, lower case. A host that
 * spells repositories differently over SSH has its source control registry's
 * `repositoryKeyFromRemote` rewrite this, so persisted keys come from that, not from here.
 */
export function normalizeGitRemoteUrl(value: string): string {
  const repository = parseGitRemoteRepository(value);
  return repository === null ? lowerCaseRemote(value) : `${repository.host}/${repository.path}`;
}

function parseGitConfigValue(raw: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\" && index + 1 < raw.length) {
      out += raw[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "#" || char === ";")) break;
    out += char;
  }
  return out.trim();
}

export function isBareGitConfig(configText: string): boolean {
  let inCore = false;
  let bare = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    let line = rawLine.trim();
    // Git accepts the first setting on the section header's own line.
    const header = /^\[\s*([^\]]*?)\s*\](.*)$/.exec(line);
    if (header !== null) {
      inCore = header[1]!.toLowerCase() === "core";
      line = header[2]!.trim();
    }
    if (!inCore) continue;
    const match = /^bare\s*(?:=(.*)|[#;].*)?$/i.exec(line);
    if (match === null) continue;
    const value = match[1] === undefined ? "true" : parseGitConfigValue(match[1]).toLowerCase();
    bare = value === "true" || value === "yes" || value === "on" || value === "1";
  }
  return bare;
}

export function parseOriginUrlFromGitConfig(configText: string): string | null {
  let section: string | null = null;
  let originUrl: string | null = null;
  let firstRemoteUrl: string | null = null;
  const joined = configText.replace(/\\\r?\n[ \t]*/g, "");
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    // Git preserves case in quoted remote subsections but lowercases legacy dotted ones.
    const header = /^\[\s*remote(?:\s+"([^"]+)"|\.([^\]\s]+))\s*\](?:\s*[#;].*)?$/i.exec(line);
    if (header) {
      section = header[1] ?? header[2]?.toLowerCase() ?? null;
      continue;
    }
    if (line.startsWith("[")) {
      section = null;
      continue;
    }
    if (section === null) continue;
    const match = /^url\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const url = parseGitConfigValue(match[1] ?? "");
    if (url.length === 0) continue;
    if (section === "origin") {
      originUrl ??= url;
    } else {
      firstRemoteUrl ??= url;
    }
  }
  return originUrl ?? firstRemoteUrl;
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

// Replace only Git-rejected whitespace; nonbreaking spaces are valid ref characters.
export function sanitizeNewRefName(rawName: string): string {
  return rawName.trim().replace(/[ \t\n\r\f\v]+/g, "-");
}

export function dedupeRemoteBranchesWithLocalMatches(
  refs: ReadonlyArray<VcsRef>,
): ReadonlyArray<VcsRef> {
  const localBranchNames = new Set(
    Arr.filterMap(refs, (refName) =>
      refName.isRemote ? Result.failVoid : Result.succeed(refName.name),
    ),
  );

  return refs.filter((refName) => {
    if (!refName.isRemote) {
      return true;
    }

    if (refName.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      refName.name,
      refName.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

const EMPTY_GIT_STATUS_REMOTE: VcsStatusRemoteResult = {
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
};

export function mergeGitStatusParts(
  local: VcsStatusLocalResult,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult {
  return {
    ...local,
    ...(remote ?? EMPTY_GIT_STATUS_REMOTE),
  };
}

function toRemoteStatusPart(status: VcsStatusResult): VcsStatusRemoteResult {
  return {
    hasUpstream: status.hasUpstream,
    aheadCount: status.aheadCount,
    behindCount: status.behindCount,
    ...(status.aheadOfDefaultCount === undefined
      ? {}
      : { aheadOfDefaultCount: status.aheadOfDefaultCount }),
    pr: status.pr,
  };
}

function toLocalStatusPart(status: VcsStatusResult): VcsStatusLocalResult {
  return {
    isRepo: status.isRepo,
    ...(status.sourceControlProvider
      ? { sourceControlProvider: status.sourceControlProvider }
      : {}),
    hasPrimaryRemote: status.hasPrimaryRemote,
    isDefaultRef: status.isDefaultRef,
    refName: status.refName,
    hasWorkingTreeChanges: status.hasWorkingTreeChanges,
    workingTree: status.workingTree,
    ...(status.branchChanges ? { branchChanges: status.branchChanges } : {}),
  };
}

export function applyGitStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  switch (event._tag) {
    case "snapshot":
      return mergeGitStatusParts(event.local, event.remote);
    case "localUpdated":
      return mergeGitStatusParts(event.local, current ? toRemoteStatusPart(current) : null);
    case "remoteUpdated":
      if (current === null) {
        return mergeGitStatusParts(
          {
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          },
          event.remote,
        );
      }
      return mergeGitStatusParts(toLocalStatusPart(current), event.remote);
  }
}
