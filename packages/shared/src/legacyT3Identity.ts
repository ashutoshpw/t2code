/**
 * The only place that spells the upstream T3 Code identity (`~/.t3`, `T3CODE_*`).
 * Users coming from an upstream install keep their data and settings through
 * the copy and fallbacks here; nothing in this file writes to the legacy side.
 * Worktrees stay where they are, and copied threads keep their absolute paths into them.
 */
// @effect-diagnostics nodeBuiltinImport:off - one-shot synchronous copy shared by the desktop pre-ready path and the server.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as ConfigProvider from "effect/ConfigProvider";

const LEGACY_HOME_DIRNAME = ".t3";
const CURRENT_HOME_DIRNAME = ".t2";
const LEGACY_ENV_PREFIX = "T3CODE_";
const CURRENT_ENV_PREFIX = "T2CODE_";

const LEGACY_HOME_COPY_MAX_BYTES = 500 * 1024 * 1024;

// Worktrees are git checkouts whose metadata hardcodes their old location; caches rebuild.
const SKIPPED_TOP_LEVEL = new Set(["worktrees", "caches"]);
// A copied runtime record would point at the legacy server's pid and port.
const SKIPPED_FILES = new Set(["server-runtime.json"]);

export type LegacyEnvResult = {
  readonly env: NodeJS.ProcessEnv;
  readonly usedLegacyNames: ReadonlyArray<string>;
};

/** Fills each unset T2CODE_* name from its T3CODE_* twin. */
export function applyLegacyEnv(env: NodeJS.ProcessEnv): LegacyEnvResult {
  const merged: NodeJS.ProcessEnv = { ...env };
  const usedLegacyNames: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const currentName = CURRENT_ENV_PREFIX + name.slice(LEGACY_ENV_PREFIX.length);
    if (env[currentName] !== undefined) continue;
    merged[currentName] = value;
    usedLegacyNames.push(name);
  }
  return { env: merged, usedLegacyNames };
}

export function legacyEnvProvider(env: NodeJS.ProcessEnv) {
  const { env: merged, usedLegacyNames } = applyLegacyEnv(env);
  return {
    provider: ConfigProvider.fromEnv({
      env: Object.fromEntries(
        Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    }),
    usedLegacyNames,
  };
}

/** True when T2CODE_HOME, or its T3CODE_HOME twin, names a home explicitly. */
export function hasExplicitHomeEnv(env: NodeJS.ProcessEnv): boolean {
  return (applyLegacyEnv(env).env.T2CODE_HOME ?? "").trim().length > 0;
}

export function legacyEnvDeprecationMessage(usedLegacyNames: ReadonlyArray<string>): string {
  const pairs = usedLegacyNames.map(
    (name) => `${name} -> ${CURRENT_ENV_PREFIX}${name.slice(LEGACY_ENV_PREFIX.length)}`,
  );
  return `Deprecated environment variables are still being read; rename them: ${pairs.join(", ")}.`;
}

export type LegacyHomeCopyResult =
  | { readonly _tag: "skipped" }
  | {
      readonly _tag: "copied";
      readonly source: string;
      readonly target: string;
      readonly bytes: number;
    }
  | { readonly _tag: "tooLarge"; readonly source: string; readonly limitBytes: number }
  | { readonly _tag: "failed"; readonly source: string; readonly message: string };

const exists = (path: string): boolean => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isSkipped = (root: string, path: string): boolean => {
  const relative = NodePath.relative(root, path);
  if (relative.length === 0) return false;
  const [top] = relative.split(NodePath.sep);
  return (
    (top !== undefined && SKIPPED_TOP_LEVEL.has(top)) || SKIPPED_FILES.has(NodePath.basename(path))
  );
};

// Stops as soon as the limit is crossed so a huge tree is never fully walked.
function measureBytes(root: string, limitBytes: number): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0 && total <= limitBytes) {
    const directory = stack.pop()!;
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (isSkipped(root, path)) continue;
      if (entry.isDirectory()) stack.push(path);
      else total += NodeFS.lstatSync(path).size;
    }
  }
  return total;
}

/**
 * Copies `<home>/.t3` to `<home>/.t2` when only the former exists. The copy is
 * staged beside the target and renamed into place, so a failure leaves neither
 * side changed. Callers must not call this when a home was chosen explicitly.
 */
export function copyLegacyHome(input: {
  readonly homeDirectory: string;
  readonly maxBytes?: number;
}): LegacyHomeCopyResult {
  const source = NodePath.join(input.homeDirectory, LEGACY_HOME_DIRNAME);
  const target = NodePath.join(input.homeDirectory, CURRENT_HOME_DIRNAME);
  const limitBytes = input.maxBytes ?? LEGACY_HOME_COPY_MAX_BYTES;
  if (exists(target) || !exists(source)) return { _tag: "skipped" };

  const staging = `${target}.migrating-${process.pid}`;
  try {
    if (!NodeFS.statSync(source).isDirectory()) return { _tag: "skipped" };
    const bytes = measureBytes(source, limitBytes);
    if (bytes > limitBytes) return { _tag: "tooLarge", source, limitBytes };
    NodeFS.cpSync(source, staging, {
      recursive: true,
      filter: (path) => !isSkipped(source, path),
    });
    NodeFS.renameSync(staging, target);
    return { _tag: "copied", source, target, bytes };
  } catch (cause) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    return {
      _tag: "failed",
      source,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function describeLegacyHomeCopy(result: LegacyHomeCopyResult): string | undefined {
  switch (result._tag) {
    case "skipped":
      return undefined;
    case "copied":
      return `Copied the legacy home ${result.source} to ${result.target} (${result.bytes} bytes); the original was left untouched. Worktrees were not copied, so threads that use one keep working inside ${result.source}.`;
    case "tooLarge":
      return `The legacy home ${result.source} exceeds ${result.limitBytes / (1024 * 1024)} MiB, so it was not copied. Copy it to ~/.t2 yourself, or point T2CODE_HOME at it.`;
    case "failed":
      return `Could not copy the legacy home ${result.source} (${result.message}); nothing was changed and it was left untouched.`;
  }
}
