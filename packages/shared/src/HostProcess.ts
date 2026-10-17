import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeDns from "node:dns";
import * as NodeOS from "node:os";
import * as NodeSea from "node:sea";

export const Platform = Context.Reference<NodeJS.Platform>("@t2code/shared/HostProcess/Platform", {
  defaultValue: () => process.platform,
});

export const Architecture = Context.Reference<NodeJS.Architecture>(
  "@t2code/shared/HostProcess/Architecture",
  {
    defaultValue: () => process.arch,
  },
);

export const Hostname = Context.Reference<string>("@t2code/shared/HostProcess/Hostname", {
  defaultValue: () => NodeOS.hostname(),
});

export const Username = Context.Reference<string | null>("@t2code/shared/HostProcess/Username", {
  defaultValue: () => {
    try {
      return NodeOS.userInfo().username.trim() || null;
    } catch {
      return null;
    }
  },
});

export const HomeDirectory = Context.Reference<string>(
  "@t2code/shared/HostProcess/HomeDirectory",
  {
    defaultValue: () => NodeOS.homedir(),
  },
);

export const Environment = Context.Reference<NodeJS.ProcessEnv>(
  "@t2code/shared/HostProcess/Environment",
  {
    defaultValue: () => process.env,
  },
);

export const WorkingDirectory = Context.Reference<string>(
  "@t2code/shared/HostProcess/WorkingDirectory",
  {
    defaultValue: () => process.cwd(),
  },
);

export const ExecutablePath = Context.Reference<string>(
  "@t2code/shared/HostProcess/ExecutablePath",
  {
    defaultValue: () => process.execPath,
  },
);

export const Arguments = Context.Reference<ReadonlyArray<string>>(
  "@t2code/shared/HostProcess/Arguments",
  {
    defaultValue: () => process.argv,
  },
);

/**
 * The command the shell was given, before Node resolved it to the binary:
 * `t3` for a PATH lookup, `./t3` or the launcher symlink for an explicit
 * path. `process.argv[0]` and `execPath` are always the resolved binary.
 */
export const InvokedAs = Context.Reference<string>("@t2code/shared/HostProcess/InvokedAs", {
  defaultValue: () => process.argv0,
});

export const IsExecutable = Context.Reference<boolean>("@t2code/shared/HostProcess/IsExecutable", {
  defaultValue: () => NodeSea.isSea(),
});

/** Includes hostname-resolved addresses absent from interfaces, such as Debian's 127.0.1.1 used by Firefox locks. */
export const Addresses = Context.Reference<Effect.Effect<ReadonlySet<string>>>(
  "@t2code/shared/HostProcess/Addresses",
  {
    // The enclosing operation owns the span for this inline handler.
    defaultValue: Effect.fnUntraced(function* () {
      const interfaces = Object.values(NodeOS.networkInterfaces())
        .flat()
        .flatMap((entry) => (entry ? [entry.address] : []));
      const resolved = yield* Effect.tryPromise(() =>
        NodeDns.promises.lookup(NodeOS.hostname(), { all: true }),
      ).pipe(
        Effect.map((entries) => entries.map((entry) => entry.address)),
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
      );
      return new Set([...interfaces, ...resolved]);
    }),
  },
);

/** Undefined on platforms without POSIX uids (Windows). */
export const UserId = Context.Reference<number | undefined>("@t2code/shared/HostProcess/UserId", {
  defaultValue: () => process.getuid?.(),
});

export const isWindows = Effect.map(Platform, (platform) => platform === "win32");
