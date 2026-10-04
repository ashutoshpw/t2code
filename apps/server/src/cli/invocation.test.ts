import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t2code/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  formatCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/@t2code/cli/dist/bin.mjs", "npx @t2code/cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@t2code\\cli\\dist\\bin.mjs",
      "npx @t2code/cli serve",
    ],
    [
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/@t2code/cli/dist/bin.mjs",
      "pnpm dlx @t2code/cli serve",
    ],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/@t2code/cli/dist/bin.mjs",
      "pnpm dlx @t2code/cli serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\@t2code\\cli\\dist\\bin.mjs",
      "pnpm dlx @t2code/cli serve",
    ],
    ["/home/theo/.bun/install/cache/@t2code/cli@0.0.31/dist/bin.mjs", "bunx @t2code/cli serve"],
    [
      "/tmp/bunx-1000-@t2code-cli@latest/node_modules/@t2code/cli/dist/bin.mjs",
      "bunx @t2code/cli serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-@t2code-cli@latest\\node_modules\\@t2code\\cli\\dist\\bin.mjs",
      "bunx @t2code/cli serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/@t2code/cli/dist/bin.mjs",
    "/home/theo/Code/work/t2code/apps/server/dist/bin.mjs",
    "/home/theo/.t2/runtime/0.0.31/node_modules/@t2code/cli/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "t2code serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx @t2code/cli@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx @t2code/cli@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx @t2code/cli serve"],
    ["0.0.31", "npx @t2code/cli serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/@t2code/cli/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/@t2code/cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx @t2code/cli@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-@t2code-cli@latest/node_modules/@t2code/cli/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx @t2code/cli serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/@t2code/cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "t2code serve",
  );
});

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  /** `sudo t2code browser setup` as this process would render it, with `t2code` on PATH or not. */
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcessExecutablePath, input.node),
      Effect.provideService(HostProcessArguments, [input.node, input.entry]),
      Effect.provideService(HostProcessIsExecutable, input.executable ?? false),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { PATH: input.path ?? "", ...input.env }),
    );

  /** A directory holding an executable `t2code`, to stand in for one on PATH. */
  const pathWithT2 = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "t2code"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/@t2code/cli/dist/bin.mjs";
      // sudo's secure_path already has a system Node.
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo npx @t2code/cli browser setup",
      );
      // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" npx @t2code/cli browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/@t2code/cli/dist/bin.mjs",
          path: yield* pathWithT2,
        }),
      ).toBe('sudo env "PATH=$PATH" t2code browser setup');
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher when t2code is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "t2code");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_T2abc/t2code",
        entry: "/tmp/.mount_T2abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { T2CODE_CLI_PATH: shim },
      };
      // The desktop app's shim, quoted for the shell and run as root as is.
      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);
      // A `t2code` the person put on PATH still wins.
      expect(yield* rootCommand({ ...desktop, path: yield* pathWithT2 })).toBe(
        'sudo env "PATH=$PATH" t2code browser setup',
      );
      // A standalone binary names itself.
      expect(
        yield* rootCommand({
          node: "/opt/t2code/t2code",
          entry: "/opt/t2code/t2code",
          executable: true,
        }),
      ).toBe("sudo /opt/t2code/t2code browser setup");
      // A stale shim path, then no launcher at all, fall back to plain `t2code`.
      expect(
        yield* rootCommand({ ...desktop, env: { T2CODE_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" t2code browser setup');
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for both script and executable packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/@t2code/cli/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@t2code/t2-linux-x64/t2", "npx"],
        ["pnpm/dlx/hash/node_modules/@t2code/cli/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/@t2code/cli/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcessArguments, ["node", entry]),
          Effect.provideService(HostProcessExecutablePath, entry),
          Effect.provideService(HostProcessIsExecutable, entry.endsWith("/t2")),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/@t2code/cli");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/t2code");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"@t2code/cli","version":"0.0.45","bin":{"t2code":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessArguments, ["node", entry]),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated t2code command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcessPlatform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the native executable belongs to the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/@t2code/cli");
      const launcher = path.join(packageRoot, "bin/t2code.js");
      const entry = path.join(packageRoot, "node_modules/@t2code/t2-linux-x64/t2");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"@t2code/cli","version":"0.0.45","bin":{"t2code":"./bin/t2code.js"},"optionalDependencies":{"@t2code/t2-linux-x64":"0.0.45"}}',
      );
      yield* fs.symlink(launcher, path.join(prefix, "bin/t2code"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessExecutablePath, entry),
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      for (const [version, expected] of [
        ["0.0.44", null],
        ["0.0.45", { kind: "npm-global", prefix }],
      ]) {
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "package.json"),
          `{"name":"@t2code/t2-linux-x64","version":"${version}"}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/@t2code/cli/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".t2/runtime/0.0.45/t2code",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcessArguments, ["node", entry]),
            Effect.provideService(HostProcessIsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
