// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NetService from "@t2code/shared/Net";
import * as HostProcess from "@t2code/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  checkPortAvailabilityOnHosts,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  resolveModePortOffsets,
  runDevRunnerWithInput,
} from "./dev-runner.ts";

const emptyConfigLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
const netServiceLayer = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(49_152),
  findAvailablePort: (port) => Effect.succeed(port),
});

function mockProcess(exit: number | PlatformError.PlatformError) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      typeof exit === "number"
        ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
        : Effect.fail(exit),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const devServerInput = {
  mode: "dev:server",
  t2Home: "/tmp/t2code-dev-runner",
  browser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: 13_772,
  devUrl: undefined,
  dryRun: false,
  share: false,
  built: false,
  runArgs: ["--inspect", "secret-token-value"],
} as const;

it.layer(NodeServices.layer)("dev-runner", (it) => {
  it.effect("accepts a dry run without the optional browser flag", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const output = yield* spawner.string(
        ChildProcess.make(process.execPath, ["scripts/dev-runner.ts", "dev", "--dry-run"], {
          cwd: path.resolve(import.meta.dirname, ".."),
        }),
      );

      assert.include(output, "[dev-runner] mode=dev");
    }),
  );

  describe("getDevRunnerModeArgs", () => {
    it.effect("lets Vite+ honor the desktop dev task graph", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(getDevRunnerModeArgs("dev:desktop"), [
          "run",
          "--filter=@t2code/desktop",
          "--filter=@t2code/web",
          "dev",
        ]);
      }),
    );

    it.effect("places Vite+ run flags before the task name", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(getDevRunnerModeArgs("dev"), [
          "run",
          "--filter=@t2code/contracts",
          "--filter=@t2code/web",
          "--filter=@t2code/cli",
          "--parallel",
          "dev",
        ]);
      }),
    );
  });

  describe("resolveOffset", () => {
    it.effect("uses explicit T2CODE_PORT_OFFSET when provided", () =>
      Effect.gen(function* () {
        const result = yield* resolveOffset({ portOffset: 12, devInstance: undefined });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "T2CODE_PORT_OFFSET=12",
        });
      }),
    );

    it.effect("hashes non-numeric instance values", () =>
      Effect.gen(function* () {
        const result = yield* resolveOffset({
          portOffset: undefined,
          devInstance: "feature-branch",
        });
        assert.ok(result.offset >= 1);
        assert.ok(result.offset <= 3000);
      }),
    );

    it.effect("returns structured context for a negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* resolveOffset({ portOffset: -1, devInstance: undefined }).pipe(
          Effect.flip,
        );

        assert.equal(error._tag, "DevRunnerInvalidPortOffsetError");
        assert.equal(error.configKey, "T2CODE_PORT_OFFSET");
        assert.equal(error.portOffset, -1);
        assert.equal(error.minimum, 0);
        assert.ok(!("cause" in error));
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    it.effect("forwards the reusable auth token to web dev and removes it for desktop", () =>
      Effect.gen(function* () {
        const input = {
          baseEnv: { T2CODE_DEV_AUTH_TOKEN: "reusable-dev-auth-token-that-is-long-enough" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const web = yield* createDevRunnerEnv({ ...input, mode: "dev" });
        const desktop = yield* createDevRunnerEnv({ ...input, mode: "dev:desktop" });

        assert.equal(web.T2CODE_DEV_AUTH_TOKEN, input.baseEnv.T2CODE_DEV_AUTH_TOKEN);
        assert.equal(desktop.T2CODE_DEV_AUTH_TOKEN, undefined);
      }),
    );
    it.effect("leaves the shared home implicit and disables browser auto-open", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_HOME, undefined);
        assert.equal(env.T2CODE_NO_BROWSER, "1");
      }),
    );

    it.effect("allows browser auto-open to be explicitly enabled", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_NO_BROWSER, "0");
      }),
    );

    it.effect("requires the browser flag even when the environment enables auto-open", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { T2CODE_NO_BROWSER: "0" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: false,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_NO_BROWSER, "1");
      }),
    );

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t2Home: "/tmp/custom-t3",
          browser: false,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.T2CODE_HOME, path.resolve("/tmp/custom-t3"));
        assert.equal(env.T2CODE_PORT, "4222");
        assert.equal(env.VITE_HTTP_URL, "http://localhost:4222");
        assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
        assert.equal(env.T2CODE_NO_BROWSER, "1");
        assert.equal(env.T2CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.T2CODE_LOG_WS_EVENTS, "1");
        assert.equal(env.T2CODE_HOST, "0.0.0.0");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
      }),
    );

    it.effect("turns product analytics off unless the developer opts in", () =>
      Effect.gen(function* () {
        const input = {
          mode: "dev",
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const byDefault = yield* createDevRunnerEnv({ ...input, baseEnv: {} });
        const optedIn = yield* createDevRunnerEnv({
          ...input,
          baseEnv: { T3CODE_TELEMETRY_ENABLED: "true" },
        });

        assert.equal(byDefault.T3CODE_TELEMETRY_ENABLED, "false");
        assert.equal(optedIn.T3CODE_TELEMETRY_ENABLED, "true");
      }),
    );

    it.effect("strips inherited service-launcher context", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            T2_SERVICE_LAUNCHER_CONTEXT: '{"childVersion":"9.9.9"}',
            T2_BOOT_SERVICE_UNIT: "t2code.service",
          },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2_SERVICE_LAUNCHER_CONTEXT, undefined);
        assert.equal(env.T2_BOOT_SERVICE_UNIT, undefined);
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            T2CODE_LOG_WS_EVENTS: "keep-me-out",
          },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_MODE, "web");
        assert.equal(env.T2CODE_LOG_WS_EVENTS, undefined);
      }),
    );

    it.effect("forwards explicit websocket logging false without coercing it away", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            T2CODE_LOG_WS_EVENTS: "1",
          },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: false,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_LOG_WS_EVENTS, "0");
      }),
    );

    it.effect("uses custom t2Home when provided", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t2Home: "/tmp/my-t3",
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_HOME, path.resolve("/tmp/my-t3"));
      }),
    );

    it.effect("pins desktop dev to a stable backend port and websocket url", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {
            T2CODE_PORT: "13772",
            T2CODE_MODE: "web",
            T2CODE_NO_BROWSER: "0",
            T2CODE_HOST: "0.0.0.0",
            VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
            VITE_WS_URL: "ws://localhost:13772",
          },
          serverOffset: 0,
          webOffset: 0,
          t2Home: "/tmp/my-t3",
          browser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "127.0.0.1",
          port: 4222,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_HOME, path.resolve("/tmp/my-t3"));
        assert.equal(env.PORT, "5733");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://127.0.0.1:5733");
        assert.equal(env.HOST, "127.0.0.1");
        assert.equal(env.T2CODE_PORT, "4222");
        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:4222");
        assert.equal(env.T2CODE_MODE, undefined);
        assert.equal(env.T2CODE_NO_BROWSER, undefined);
        assert.equal(env.T2CODE_HOST, undefined);
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:4222");
      }),
    );

    it.effect("defaults dev server mode to the higher backend port range", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_PORT, "13772");
        assert.equal(env.PORT, "5733");
      }),
    );

    it.effect.each(["dev", "dev:web"] as const)(
      "leaves the client backend URLs unset in %s mode",
      (mode) =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: {
              VITE_HTTP_URL: "http://localhost:1234",
              VITE_WS_URL: "ws://localhost:1234",
            },
            serverOffset: 0,
            webOffset: 0,
            t2Home: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.VITE_HTTP_URL, undefined);
          assert.equal(env.VITE_WS_URL, undefined);
          assert.equal(env.T2CODE_PORT, "13772");
          // Deleting the keys is not sufficient — vite.config.ts merges
          // `.env`/`.env.local` underneath this env and would revive them, so
          // the intent has to be stated positively.
          assert.equal(env.T2CODE_SINGLE_ORIGIN_DEV, "1");
        }),
    );

    it.effect("clears the single-origin marker in dev:desktop mode", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: { T2CODE_SINGLE_ORIGIN_DEV: "1" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_SINGLE_ORIGIN_DEV, undefined);
        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:13772");
      }),
    );

    it.effect("clears the single-origin marker in dev:server mode", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: { T2CODE_SINGLE_ORIGIN_DEV: "1" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_SINGLE_ORIGIN_DEV, undefined);
        assert.equal(env.VITE_HTTP_URL, "http://localhost:13772");
      }),
    );

    it.effect.each(["dev", "dev:web"] as const)("drops an inherited HOST in %s mode", (mode) =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode,
          baseEnv: { HOST: "0.0.0.0" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.HOST, undefined);
      }),
    );

    it.effect("drops an inherited HOST even when --host is given", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { HOST: "0.0.0.0" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "0.0.0.0",
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.HOST, undefined);
        assert.equal(env.T2CODE_HOST, "0.0.0.0");
      }),
    );

    it.effect("still pins HOST for dev:desktop", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: { HOST: "0.0.0.0" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.HOST, "127.0.0.1");
      }),
    );

    it.effect("keeps explicit backend URLs for the desktop renderer", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:13772");
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:13772");
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([13772, 13773, 5733, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("skips browser-blocked web ports before probing availability", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];
        const offset = yield* findFirstAvailableOffset({
          // 5733 + 833 = 6566, which browsers block as sane-port.
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.equal(offset, 834);
        assert.deepStrictEqual(probed, [
          { port: 14_606, role: "server" },
          { port: 6567, role: "web" },
        ]);
      }),
    );

    it.effect("does not reject a server-only offset because its unused web port is blocked", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 833);
      }),
    );

    it.effect("allows offsets where the non-required server port exceeds max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_802,
          requireServerPort: false,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_802);
      }),
    );

    it.effect("reports the exhausted range and required port set", () =>
      Effect.gen(function* () {
        const error = yield* findFirstAvailableOffset({
          startOffset: 51_764,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        }).pipe(Effect.flip);

        if (error._tag !== "DevRunnerPortExhaustedError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.startOffset, 51_764);
        assert.equal(error.requireServerPort, true);
        assert.equal(error.requireWebPort, false);
        assert.equal(error.baseServerPort, 13_772);
        assert.equal(error.baseWebPort, 5_733);
        assert.equal(error.maximumPort, 65_535);
        assert.ok(!("cause" in error));
      }),
    );
  });

  describe("isBrowserAllowedPort", () => {
    it.each([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697])(
      "rejects Fetch-blocked web port %s from the worktree offset range",
      (port) => {
        assert.equal(isBrowserAllowedPort(port), false);
      },
    );

    it.each([5733, 5900, 6567, 6670, 8733])("allows browser-safe web port %s", (port) => {
      assert.equal(isBrowserAllowedPort(port), true);
    });
  });

  describe("checkPortAvailabilityOnHosts", () => {
    it.effect("checks overlapping hosts sequentially to avoid self-interference", () =>
      Effect.gen(function* () {
        let inFlightCount = 0;
        const calls: Array<[number, string]> = [];

        const available = yield* checkPortAvailabilityOnHosts(
          13_772,
          ["127.0.0.1", "0.0.0.0", "::"],
          (port, host) =>
            Effect.promise(async () => {
              calls.push([port, host]);
              inFlightCount += 1;
              const overlapped = inFlightCount > 1;
              await Promise.resolve();
              inFlightCount -= 1;
              return !overlapped;
            }),
        );

        assert.equal(available, true);
        assert.deepStrictEqual(calls, [
          [13_772, "127.0.0.1"],
          [13_772, "0.0.0.0"],
          [13_772, "::"],
        ]);
      }),
    );
  });

  describe("devPortProbeHosts", () => {
    it.effect("passes the port role so only the server port sees the bind host", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];

        yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.deepStrictEqual(probed, [
          { port: 13_772, role: "server" },
          { port: 5733, role: "web" },
        ]);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([13772, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([13772]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });

  describe("runDevRunnerWithInput", () => {
    it.effect("preserves process spawn context and the exact platform cause", () => {
      const cause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "vp was not found",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(cause)),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.operation, "spawn");
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    // `tailscale serve` config outlives the process, so a dry run that shared
    // would replace and then tear down whatever mapping the port already had.
    // Base-dir precedence (--home-dir > worktree .t2 > ambient T2CODE_HOME)
    // lives in runDevRunnerWithInput; the env builder must not consult the
    // ambient variable on its own, or it would silently outrank the worktree
    // default and land dev state on the user's real database.
    it.effect("ignores an ambient T2CODE_HOME when no home is resolved", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { T2CODE_HOME: "/home/user/.t2" },
          serverOffset: 0,
          webOffset: 0,
          t2Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T2CODE_HOME, undefined);
      }),
    );

    it.effect("rejects a specific non-loopback --host for browser dev modes", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          host: "192.168.1.10",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerHostNotProxiableError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev");
        assert.equal(error.host, "192.168.1.10");
        assert.include(error.message, "0.0.0.0");
        assert.include(error.message, "--share");
      });
    });

    // A shared origin means a remote browser, where unbundled dev's
    // per-module waterfall pays a tailnet round trip per import level. The
    // runner defaults bundled dev on for the spawned stack, but only
    // defaults: an explicit T2CODE_BUNDLED_DEV (even "0") must pass through.
    describe("--share spawn wiring", () => {
      const shareSpawned = (input: {
        readonly ambientBundledDev?: string | undefined;
        readonly built?: boolean;
        readonly host?: string;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          let vpArgs: ReadonlyArray<string> = [];
          const tailscaleCalls: Array<ReadonlyArray<string>> = [];
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const spawned = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options?: { readonly env?: Record<string, string | undefined> };
              };
              if (spawned.command === "vp") {
                captured = spawned.options?.env;
                vpArgs = spawned.args;
                return Effect.succeed(mockProcess(0));
              }
              tailscaleCalls.push(spawned.args);
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(2),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: spawned.args.includes("status")
                    ? Stream.make(
                        new TextEncoder().encode(
                          JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }),
                        ),
                      )
                    : Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              );
            }),
          );

          yield* runDevRunnerWithInput({
            ...devServerInput,
            mode: "dev",
            port: undefined,
            share: true,
            built: input.built ?? false,
            host: input.host,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(
              HostProcess.Environment,
              input.ambientBundledDev === undefined
                ? {}
                : { T2CODE_BUNDLED_DEV: input.ambientBundledDev },
            ),
          );

          return { env: captured, vpArgs, tailscaleCalls };
        });

      it.effect("keeps an explicit T2CODE_BUNDLED_DEV=0 opt-out", () =>
        Effect.gen(function* () {
          const { env } = yield* shareSpawned({ ambientBundledDev: "0" });
          assert.equal(env?.T2CODE_BUNDLED_DEV, "0");
        }),
      );

      it.effect("--built serves the backend on the web port's tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({ built: true });
          assert.include(vpArgs, "dev:built");
          assert.equal(env?.T3CODE_BUILT_DEV, "1");
          assert.equal(env?.T3CODE_BUNDLED_DEV, undefined);
          assert.equal(env?.VITE_DEV_SERVER_URL, `https://host.example.ts.net:${env?.PORT}/`);
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.deepEqual(serve?.slice(-2), [
            `--https=${env?.PORT}`,
            `http://127.0.0.1:${env?.T3CODE_PORT}`,
          ]);
        }),
      );

      it.effect("--built --host ::1 targets the backend's IPv6 loopback", () =>
        Effect.gen(function* () {
          const { env, tailscaleCalls } = yield* shareSpawned({ built: true, host: "::1" });
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://[::1]:${env?.T3CODE_PORT}`);
        }),
      );

      it.effect("without --built keeps Vite behind the tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({});
          assert.include(vpArgs, "dev");
          assert.notInclude(vpArgs, "dev:built");
          assert.equal(env?.T2CODE_BUNDLED_DEV, "1");
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://localhost:${env?.PORT}`);
        }),
      );
    });

    it.effect.each([
      { mode: "dev", share: false },
      { mode: "dev:web", share: true },
      { mode: "dev:desktop", share: true },
    ] as const)("rejects --built for $mode with share=$share", ({ mode, share }) => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode,
          port: undefined,
          share,
          built: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        assert.equal(error._tag, "DevRunnerBuiltNeedsShareError");
      });
    });

    it.effect("reports non-zero exits without manufacturing a cause", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(17))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessExitError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.exitCode, 17);
        assert.ok(!("cause" in error));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    describe("t2 home precedence", () => {
      const makeWorktree = Effect.acquireRelease(
        Effect.sync(() => {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devrunner-"));
          NodeFS.writeFileSync(
            NodePath.join(root, ".git"),
            "gitdir: /elsewhere/.git/worktrees/x\n",
          );
          return root;
        }),
        (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );

      const spawnedHome = (input: {
        readonly t2Home: string | undefined;
        readonly cwd: string;
        readonly ambientHome: string | undefined;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured = (
                command as {
                  readonly options?: { readonly env?: Record<string, string | undefined> };
                }
              ).options?.env;
              return Effect.succeed(mockProcess(0));
            }),
          );

          yield* runDevRunnerWithInput({ ...devServerInput, t2Home: input.t2Home }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.WorkingDirectory, input.cwd),
            // No ~/.t3 here, so these runs never seed from this machine's install.
            Effect.provideService(HostProcess.HomeDirectory, input.cwd),
            Effect.provideService(
              HostProcess.Environment,
              input.ambientHome === undefined ? {} : { T2CODE_HOME: input.ambientHome },
            ),
          );

          return captured?.T2CODE_HOME;
        });

      it.effect("prefers an explicit --home-dir over the worktree default", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t2Home: "/tmp/explicit-home",
            cwd: root,
            ambientHome: "/home/user/.t2",
          });
          assert.equal(home, path.resolve("/tmp/explicit-home"));
        }).pipe(Effect.scoped),
      );

      it.effect("treats a blank --home-dir as unset rather than as a selection", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t2Home: "   ",
            cwd: root,
            ambientHome: "/home/user/.t2",
          });
          assert.equal(home, path.join(path.resolve(root), ".t2"));
        }).pipe(Effect.scoped),
      );

      it.effect("prefers the worktree .t2 over an ambient T2CODE_HOME", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t2Home: undefined,
            cwd: root,
            ambientHome: "/home/user/.t2",
          });
          assert.equal(home, path.join(path.resolve(root), ".t2"));
        }).pipe(Effect.scoped),
      );

      it.effect("seeds a worktree database from ~/.t2 only when it has none", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = path.join(root, "home");
          NodeFS.mkdirSync(path.join(home, ".t2", "userdata"), { recursive: true });
          NodeFS.writeFileSync(path.join(home, ".t2", "userdata", "statev2.sqlite"), "");

          const spawnedArgs = (seed: boolean | undefined) =>
            Effect.gen(function* () {
              const spawned: Array<ReadonlyArray<string>> = [];
              const spawnerLayer = Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) => {
                  spawned.push(
                    (command as unknown as { readonly args: ReadonlyArray<string> }).args,
                  );
                  return Effect.succeed(mockProcess(0));
                }),
              );
              yield* runDevRunnerWithInput({ ...devServerInput, t2Home: undefined, seed }).pipe(
                Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
                Effect.provideService(HostProcess.Platform, "linux"),
                Effect.provideService(HostProcess.WorkingDirectory, root),
                Effect.provideService(HostProcess.HomeDirectory, home),
                Effect.provideService(HostProcess.Environment, {}),
              );
              return spawned.filter((args) =>
                args.some((arg) => arg.endsWith("migrate-dev-db.ts")),
              );
            });

          assert.deepStrictEqual(yield* spawnedArgs(false), []);
          const [seedArgs] = yield* spawnedArgs(undefined);
          assert.includeMembers([...(seedArgs ?? [])], ["--base-dir", path.join(root, ".t2")]);

          // Either database means the worktree already has data.
          for (const name of ["state.sqlite", "statev2.sqlite"]) {
            const file = path.join(root, ".t2", "userdata", name);
            NodeFS.mkdirSync(path.dirname(file), { recursive: true });
            NodeFS.writeFileSync(file, "");
            assert.deepStrictEqual(yield* spawnedArgs(undefined), []);
            NodeFS.rmSync(file);
          }
        }).pipe(Effect.scoped),
      );

      it.effect("falls back to an ambient T2CODE_HOME outside a worktree", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = yield* spawnedHome({
            t2Home: undefined,
            cwd: NodeOS.tmpdir(),
            ambientHome: "/home/user/.t2",
          });
          assert.equal(home, path.resolve("/home/user/.t2"));
        }),
      );
    });
  });
});
