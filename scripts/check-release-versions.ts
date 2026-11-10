#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - zero-dependency CI and git hook CLI.
// Fails when the packages that release together disagree on their version.
// The aligned set is releasePackageFiles in update-release-package-versions.ts;
// apps/mobile versions independently through EAS and is not part of it.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { releasePackageFiles } from "./update-release-package-versions.ts";

export function findVersionMismatches(
  versions: ReadonlyArray<{ readonly file: string; readonly version: unknown }>,
): ReadonlyArray<string> {
  const expected = versions[0]?.version;
  return versions
    .filter(({ version }) => typeof version !== "string" || version !== expected)
    .map(({ file, version }) => `${file}: ${String(version)}`);
}

export function readReleaseVersions(rootDir: string) {
  return releasePackageFiles.map((file) => ({
    file,
    version: JSON.parse(NodeFS.readFileSync(NodePath.join(rootDir, file), "utf8")).version,
  }));
}

if (import.meta.main) {
  const rootDir = NodePath.resolve(import.meta.dirname, "..");
  const versions = readReleaseVersions(rootDir);
  const mismatches = findVersionMismatches(versions);
  if (mismatches.length > 0) {
    console.error(
      `Release packages must share one version (expected ${String(versions[0]?.version)}):\n${mismatches.join("\n")}\nRun: node scripts/update-release-package-versions.ts <version>`,
    );
    process.exit(1);
  }
}
