// @effect-diagnostics nodeBuiltinImport:off
// The Windows cleanup shell must outlive this process (it deletes the
// directory this executable runs from), which Effect's scoped ChildProcess
// cannot express: it kills the child when the scope closes.
import * as NodeChildProcess from "node:child_process";

import {
  HostProcessEnvironment,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t2code/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";

import * as BootService from "../cloud/bootService.ts";
import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { bootServiceLayer } from "./service.ts";
import { findWindowsShim, launcherOwnsVersionsDir, resolveLauncherPath } from "./update.ts";

export class CliUninstallError extends Schema.TaggedError<CliUninstallError>()(
  "CliUninstallError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * What `t2code uninstall` would remove for one T2 home. Computed before anything
 * is touched so the user sees the whole plan in one place.
 */
export interface UninstallPlan {
  /** The background service serves this home and will be stopped and removed. */
  readonly service: boolean;
  /** The `t2`/`t3` launchers (symlinks or `.cmd` shims) that point into this home's runtime tree. */
  readonly launcher: ReadonlyArray<string>;
  /** `<home>/runtime`, holding every downloaded version, when it exists. */
  readonly runtimeDir: string | undefined;
  /** `<home>/userdata`, which is never removed; shown so the user knows where it is. */
  readonly userdataDir: string;
}

/**
 * Finds the launcher this install left on PATH. Only a launcher that points
 * into this home's `runtime/versions` is claimed: a plain copy of the
 * executable, or a launcher for another home, is not ours to delete.
 */
export const findOwnedLaunchers = Effect.fn("cli.uninstall.find_launchers")(function* (input: {
  readonly launchedAs: string | undefined;
  readonly versionsDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  if (input.launchedAs === undefined) return [];
  if (platform === "win32") {
    const shimPath = yield* findWindowsShim(input.launchedAs);
    if (shimPath === undefined) return [];
    const owned: string[] = [];
    for (const name of ["t2.cmd", "t3.cmd"]) {
      const candidate = path.join(path.dirname(shimPath), name);
      const contents = yield* fs.readFileString(candidate).pipe(Effect.option);
      const target = Option.isSome(contents) ? /^"([^"]+)"/m.exec(contents.value)?.[1] : undefined;
      if (target !== undefined && launcherOwnsVersionsDir(path, input.versionsDir, target)) {
        owned.push(candidate);
      }
    }
    return owned;
  }
  const dir = path.dirname(input.launchedAs);
  const owned: string[] = [];
  for (const candidate of new Set([`${dir}/t2`, `${dir}/t3`, input.launchedAs])) {
    const linkTarget = yield* fs.readLink(candidate).pipe(Effect.option);
    if (Option.isNone(linkTarget)) continue;
    const resolved = path.resolve(dir, linkTarget.value);
    if (launcherOwnsVersionsDir(path, input.versionsDir, resolved)) owned.push(candidate);
  }
  return owned;
});

const planUninstall = Effect.fn("cli.uninstall.plan")(function* (input: {
  readonly baseDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const servesThisHome =
    status.installedBaseDir !== undefined &&
    path.resolve(status.installedBaseDir) === path.resolve(input.baseDir);
  const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
  const runtimeDir = path.dirname(versionsDir);
  const launchedAs = (yield* HostProcessIsExecutable) ? yield* resolveLauncherPath : undefined;
  const plan: UninstallPlan = {
    service: status.supported && status.installed && servesThisHome,
    launcher: yield* findOwnedLaunchers({ launchedAs, versionsDir }),
    runtimeDir: (yield* fs.exists(runtimeDir).pipe(Effect.orElseSucceed(() => false)))
      ? runtimeDir
      : undefined,
    userdataDir: path.join(input.baseDir, "userdata"),
  };
  return plan;
});

export const uninstallCommand = Command.make("uninstall", {
  ...projectLocationFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Remove everything without asking. Required from a script, where there is no prompt.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Remove t2 from this machine: the background service, the launcher, and every downloaded version. Your projects and threads are kept.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      return yield* runUninstall({ baseDir: config.baseDir, assumeYes: flags.yes }).pipe(
        Effect.provide(bootServiceLayer(config)),
      );
    }),
  ),
);

const runUninstall = Effect.fn("cli.uninstall.run")(function* (input: {
  readonly baseDir: string;
  readonly assumeYes: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const service = yield* BootService.BootService;
  const plan = yield* planUninstall({ baseDir: input.baseDir });

  if (!plan.service && plan.launcher.length === 0 && plan.runtimeDir === undefined) {
    yield* Console.log(`Nothing to remove: t2 is not installed for ${input.baseDir}.`);
    if (!(yield* HostProcessIsExecutable)) {
      yield* Console.log(
        "  This t2 runs from a Node script, so it was installed by npm or built from source. Remove it the same way (`npm uninstall -g @t2code/cli`, or delete the checkout).",
      );
    }
    return;
  }

  yield* Console.log("This will remove:");
  if (plan.service) yield* Console.log("  the background service (stopping it first)");
  for (const launcher of plan.launcher) {
    yield* Console.log(`  the launcher at ${launcher}`);
  }
  if (plan.runtimeDir !== undefined) {
    yield* Console.log(`  every downloaded version under ${plan.runtimeDir}`);
  }
  yield* Console.log(
    `Your projects, threads, and settings under ${plan.userdataDir} are kept. Delete that directory yourself if you want them gone too.`,
  );

  if (!input.assumeYes) {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      return yield* new CliUninstallError({
        reason:
          "Not a terminal, so nothing was removed. Rerun with --yes to confirm from a script.",
      });
    }
    const confirmed = yield* Prompt.run(
      Prompt.Confirm({ message: "Remove t2 from this machine?", initial: false }),
    ).pipe(Effect.catchTag("QuitError", () => Effect.succeed(false)));
    if (!confirmed) {
      yield* Console.log("Left as is.");
      return;
    }
  }

  if (plan.service) {
    yield* service.uninstall;
    yield* Console.log("Removed the background service.");
  }
  for (const launcher of plan.launcher) {
    yield* fs
      .remove(launcher, { force: true })
      .pipe(
        Effect.mapError(
          () => new CliUninstallError({ reason: `Could not remove the launcher at ${launcher}.` }),
        ),
      );
    yield* Console.log(`Removed ${launcher}.`);
  }
  if (plan.runtimeDir !== undefined) {
    // This process runs from inside runtimeDir. POSIX unlinks a running
    // executable fine; Windows refuses, so the tree is removed after this
    // process exits by a detached shell, and the user is told either way.
    if (platform === "win32") {
      const runtimeDir = plan.runtimeDir;
      const comspec = environment["ComSpec"] ?? environment["COMSPEC"] ?? "cmd.exe";
      yield* Effect.try({
        try: () => {
          const child = NodeChildProcess.spawn(
            comspec,
            ["/d", "/c", `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${runtimeDir}"`],
            { detached: true, stdio: "ignore", windowsHide: true },
          );
          child.unref();
        },
        catch: () =>
          new CliUninstallError({
            reason: `Could not schedule removal of ${runtimeDir}. Delete it yourself once this window is closed.`,
          }),
      });
      yield* Console.log(`${runtimeDir} will be removed once t2 exits.`);
    } else {
      yield* fs
        .remove(plan.runtimeDir, { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            () => new CliUninstallError({ reason: `Could not remove ${plan.runtimeDir}.` }),
          ),
        );
      yield* Console.log(`Removed ${plan.runtimeDir}.`);
    }
  }
  yield* Console.log("");
  yield* Console.log("t2code is uninstalled. Thanks for trying T2 Code.");
});
