import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t2code/shared/HostProcess";

import { findOwnedLaunchers, spawnWindowsRemoval } from "./uninstall.ts";
it.layer(NodeServices.layer)("t2 uninstall launcher", (it) => {
  it.effect("claims only launchers that point into this home's runtime tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t2-uninstall-" });
      const versionsDir = path.join(root, "runtime/versions");
      const exe = path.join(versionsDir, "1.0.0/t2");
      const otherExe = path.join(root, "other/runtime/versions/1.0.0/t2");
      const copy = path.join(root, "copy/t2");
      for (const file of [exe, otherExe, copy]) {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "");
      }
      const ours = path.join(root, "bin/t2");
      const theirs = path.join(root, "other/bin/t2");
      yield* fs.makeDirectory(path.dirname(ours), { recursive: true });
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.symlink(exe, ours);
      yield* fs.symlink(otherExe, theirs);

      assert.deepEqual(yield* findOwnedLaunchers({ launchedAs: ours, versionsDir }), [ours]);
      assert.deepEqual(yield* findOwnedLaunchers({ launchedAs: theirs, versionsDir }), []);
      assert.deepEqual(yield* findOwnedLaunchers({ launchedAs: copy, versionsDir }), []);
      assert.deepEqual(yield* findOwnedLaunchers({ launchedAs: undefined, versionsDir }), []);
    }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "linux")),
  );
});

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "t3 uninstall has cmd.exe remove the runtime directory, preserving spaces and literal environment-variable syntax",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-uninstall-" });
      const runtimeDir = path.join(root, "t3 home %COMSPEC% !COMSPEC! & data", "runtime");
      yield* fs.makeDirectory(path.join(runtimeDir, "versions", "1.0.0"), { recursive: true });
      yield* fs.writeFileString(path.join(runtimeDir, "versions", "1.0.0", "t3.exe"), "");

      const child = spawnWindowsRemoval(process.env.ComSpec ?? "cmd.exe", runtimeDir);
      yield* Effect.callback<void, Error>((resume) => {
        child.once("error", (error) => resume(Effect.fail(error)));
        child.once("exit", (code) =>
          resume(code === 0 ? Effect.void : Effect.die(`cmd.exe exited with ${code}`)),
        );
      });

      assert.isFalse(yield* fs.exists(runtimeDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
