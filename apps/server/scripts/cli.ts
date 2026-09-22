#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import { resolveSpawnCommand } from "@t2code/shared/shell";
import {
  createNpmPublishInvocation,
  createNpmPublishPlan,
  type NpmPackageArtifactMetadata,
  runNpmPublishPlan,
  parseNpmPackageManifest,
  sha512File,
  waitForNpmPackagesVisibility,
  waitForNpmPackageVisibility,
} from "./npmPublish.ts";
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliExecutableImportError,
  ServerCliNpmPublishError,
} from "./cliErrors.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.StandardCommand,
  errorArgs: ReadonlyArray<string> = command.args,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: errorArgs,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// build-exe subcommand
// ---------------------------------------------------------------------------

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        "Cross-build for <platform>-<arch> in nodejs.org naming (for example darwin-x64); defaults to the host.",
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Building single-executable...");
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            T2CODE_PACK_EXE: "1",
            ...Option.match(config.target, {
              onNone: () => ({}),
              onSome: (target) => ({ T2CODE_PACK_EXE_TARGET: target }),
            }),
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // The executable can only `import` built-ins. A file-backed import
      // passes the bundler and `node dist/bin.mjs`, then throws inside the
      // binary, so read the emitted module graph rather than trusting config.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      yield* Effect.log(
        "[cli] Built dist-exe/t3 (expects client/, resource-monitor/, and the runtime-external node_modules beside it; scripts/build-cli-archive.ts assembles that tree)",
      );
    }),
).pipe(
  Command.withDescription(
    "Build the server as a Node single-executable (needs a Node 25.7+ host for --build-sea). The binary still resolves native packages from a node_modules tree beside it.",
  ),
);

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

/**
 * Publishes the tarballs scripts/build-npm-platform-packages.ts produced:
 * every `@t2code/t2-<platform>.tgz` first, `@t2code/cli.tgz` (the launcher) last, so
 * the launcher is never installable before the executables it depends on.
 * Tarballs rather than directories because `npm publish <dir>` strips the
 * `node_modules/` the executable loads its native addons from.
 */
const publishCmd = Command.make(
  "publish",
  {
    packagesDir: Flag.String("packages-dir").pipe(
      Flag.withDescription("Output dir of scripts/build-npm-platform-packages.ts."),
    ),
    tag: Flag.String("tag").pipe(Flag.withDefault("latest")),
    access: Flag.String("access").pipe(Flag.withDefault("public")),
    provenance: Flag.Boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    waitForVisibility: Flag.Boolean("wait-for-visibility").pipe(
      Flag.withDescription(
        "After real publishes, wait for the exact package versions and tarballs to be public on npm.",
      ),
      Flag.withDefault(false),
    ),
    otp: Flag.String("otp").pipe(
      Flag.withDescription("One-time password for npm authentication (local publishing only)."),
      Flag.optional,
    ),
    interactive: Flag.Boolean("interactive").pipe(
      Flag.withDescription("Run local npm publishing with inherited terminal input and output."),
      Flag.withDefault(false),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      // npm runs with cwd set to the packages dir below, so tarball paths are
      // resolved once here rather than joined twice.
      const packagesDir = path.resolve(config.packagesDir);
      const scopeDir = path.join(packagesDir, "@t2code");
      const launcherTarball = path.join(packagesDir, "@t2code/cli.tgz");
      const platformTarballs = (yield* fs
        .readDirectory(scopeDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
        .filter((entry) => entry.startsWith("t2-") && entry.endsWith(".tgz"))
        .sort()
        .map((entry) => path.join(scopeDir, entry));
      if (platformTarballs.length === 0) {
        return yield* new ServerCliBuildAssetMissingError({
          assetPath: path.join(scopeDir, "t2-<platform>.tgz"),
        });
      }
      if (!(yield* fs.exists(launcherTarball))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: launcherTarball });
      }

      const allTarballs = [...platformTarballs, launcherTarball];
      const manifests = new Map<string, NpmPackageArtifactMetadata>();
      for (const tarball of allTarballs) {
        const metadataPath = path.join(scopeDir, path.basename(tarball, ".tgz"), "package.json");
        const metadataJson = yield* fs.readFileString(metadataPath);
        const manifest = yield* Effect.try({
          try: () =>
            parseNpmPackageManifest(
              // The package directory is emitted beside the tarball by the
              // package builder and is the source package.json carried by it.
              // Read it before publishing so a malformed or stale launcher
              // cannot leave a partially usable release behind.
              metadataJson,
              metadataPath,
            ),
          catch: (cause) =>
            new ServerCliNpmPublishError({
              detail: `Invalid npm package metadata at ${metadataPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        const integrity = yield* Effect.tryPromise({
          try: () => sha512File(tarball),
          catch: (cause) =>
            new ServerCliNpmPublishError({
              detail: `Unable to hash npm package tarball ${tarball}: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        });
        manifests.set(tarball, { ...manifest, integrity });
      }

      const launcherManifest = manifests.get(launcherTarball);
      if (launcherManifest === undefined) {
        return yield* new ServerCliNpmPublishError({
          detail: "Missing launcher package metadata.",
        });
      }
      const platformMetadata = platformTarballs.map((tarball) => manifests.get(tarball)!);
      const releaseVersions = new Set(
        [...platformMetadata, launcherManifest].map((manifest) => manifest.version),
      );
      if (releaseVersions.size !== 1) {
        return yield* new ServerCliNpmPublishError({
          detail: `npm package metadata has inconsistent versions: ${[...releaseVersions].join(", ")}.`,
        });
      }
      const expectedOptionalDependencies = Object.fromEntries(
        platformMetadata.map((manifest) => [manifest.name, manifest.version]),
      );
      const optionalDependenciesMatch =
        Object.keys(launcherManifest.optionalDependencies).length ===
          Object.keys(expectedOptionalDependencies).length &&
        Object.entries(expectedOptionalDependencies).every(
          ([name, version]) => launcherManifest.optionalDependencies[name] === version,
        );
      if (launcherManifest.name !== "@t2code/cli" || !optionalDependenciesMatch) {
        return yield* new ServerCliNpmPublishError({
          detail:
            "The launcher optionalDependencies do not exactly match the platform package metadata.",
        });
      }

      const invocation = createNpmPublishInvocation({
        access: config.access,
        tag: config.tag,
        provenance: config.provenance,
        dryRun: config.dryRun,
        otp: Option.getOrUndefined(config.otp),
        interactive: config.interactive,
        verbose: config.verbose,
      });

      const publishTarball = (tarball: string) =>
        Effect.gen(function* () {
          const spawnCommand = yield* resolveSpawnCommand("npm", [...invocation.args, tarball]);
          yield* Effect.log(
            `[cli] npm ${[...invocation.logArgs, path.basename(tarball)].join(" ")}`,
          );
          yield* runCommand(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd: packagesDir,
              stdin: invocation.stdin,
              stdout: invocation.stdout,
              stderr: invocation.stderr,
              shell: spawnCommand.shell,
            }),
            [...invocation.errorArgs, path.basename(tarball)],
          );
        });

      const platformArtifacts = platformTarballs.map((tarball) => ({
        tarball,
        packageMetadata: manifests.get(tarball)!,
      }));
      const launcherArtifact = { tarball: launcherTarball, packageMetadata: launcherManifest };
      const plan = createNpmPublishPlan(
        platformArtifacts,
        launcherArtifact,
        config.waitForVisibility && !config.dryRun,
      );

      yield* runNpmPublishPlan(plan, (step) =>
        Effect.gen(function* () {
          switch (step._tag) {
            case "publish":
              yield* publishTarball(step.artifact.tarball);
              return;
            case "wait-for-platforms": {
              const visible = yield* Effect.tryPromise({
                try: () => waitForNpmPackagesVisibility(step.packages),
                catch: (cause) =>
                  new ServerCliNpmPublishError({
                    detail: `npm platform packages were published but are not publicly installable: ${cause instanceof Error ? cause.message : String(cause)}`,
                  }),
              });
              for (const packageMetadata of visible) {
                yield* Effect.log(
                  `[cli] npm package ${packageMetadata.name}@${packageMetadata.version} is publicly installable`,
                );
              }
              return;
            }
            case "wait-for-launcher": {
              const visible = yield* Effect.tryPromise({
                try: () => waitForNpmPackageVisibility(step.packageMetadata),
                catch: (cause) =>
                  new ServerCliNpmPublishError({
                    detail: `npm launcher ${step.packageMetadata.name}@${step.packageMetadata.version} was published but is not publicly installable: ${cause instanceof Error ? cause.message : String(cause)}`,
                  }),
              });
              yield* Effect.log(
                `[cli] npm package ${visible.name}@${visible.version} is publicly installable`,
              );
              return;
            }
          }
        }),
      );
    }),
).pipe(
  Command.withDescription(
    "Publish the @t2code/t2-<platform> tarballs and then the @t2code/cli launcher to npm.",
  ),
);

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T2 server build & publish CLI."),
  Command.withSubcommands([buildCmd, buildExeCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
