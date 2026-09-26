/**
 * `t2code exec` — run one prompt through a native harness CLI and print its
 * final answer without opening that harness's interactive UI.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import { isCommandAvailable, resolveSpawnCommand } from "@t2code/shared/shell";

export const EXEC_PROVIDERS = ["claude", "codex", "opencode", "cursor", "grok", "fx"] as const;
export type ExecProvider = (typeof EXEC_PROVIDERS)[number];

export const execProviderGlobalFlag = GlobalFlag.Setting("exec-provider")({
  flag: Flag.Literals("provider", EXEC_PROVIDERS).pipe(
    Flag.withAlias("p"),
    Flag.withDescription(`Harness CLI to use (${EXEC_PROVIDERS.join(", ")}).`),
    Flag.optional,
  ),
});

interface HarnessInvocation {
  readonly command: string;
  readonly args: (prompt: string) => ReadonlyArray<string>;
  readonly output: "inherit" | "cursor-json";
}

const HARNESS_INVOCATIONS: Record<ExecProvider, HarnessInvocation> = {
  claude: {
    command: "claude",
    args: (prompt) => ["--print", prompt],
    output: "inherit",
  },
  codex: {
    command: "codex",
    args: (prompt) => ["exec", prompt],
    output: "inherit",
  },
  opencode: {
    command: "opencode",
    args: (prompt) => ["run", prompt],
    output: "inherit",
  },
  cursor: {
    command: "cursor-agent",
    args: (prompt) => ["-p", "--output-format", "json", prompt],
    output: "cursor-json",
  },
  grok: {
    command: "grok",
    args: (prompt) => ["-p", prompt, "--output-format", "plain"],
    output: "inherit",
  },
  fx: {
    command: "fx",
    args: (prompt) => ["ask", prompt],
    output: "inherit",
  },
};

export class ExecProviderRequiredError extends Schema.TaggedError<ExecProviderRequiredError>()(
  "ExecProviderRequiredError",
  {},
) {
  override get message(): string {
    return `Choose a harness with --provider (or -p), for example: t2code --provider claude exec "Summarize this project". Supported harnesses: ${EXEC_PROVIDERS.join(", ")}.`;
  }
}

export class ExecHarnessUnavailableError extends Schema.TaggedError<ExecHarnessUnavailableError>()(
  "ExecHarnessUnavailableError",
  { provider: Schema.String, command: Schema.String },
) {
  override get message(): string {
    return `The ${this.provider} CLI (${this.command}) was not found on PATH.`;
  }
}

export class ExecHarnessSpawnError extends Schema.TaggedError<ExecHarnessSpawnError>()(
  "ExecHarnessSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not start the harness CLI (${this.command}).`;
  }
}

const cursorFinalText = (stdout: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "result" in parsed &&
      typeof parsed.result === "string"
    ) {
      return parsed.result;
    }
  } catch {
    // Report a concise message below instead of leaking the structured output.
  }
  return undefined;
};

const runHarness = (input: {
  readonly invocation: HarnessInvocation;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}) =>
  Effect.callback<number, ExecHarnessSpawnError>((resume) => {
    let settled = false;
    let stdout = "";
    const finish = (result: Effect.Effect<number, ExecHarnessSpawnError>) => {
      if (settled) return;
      settled = true;
      resume(result);
    };

    try {
      const child = NodeChildProcess.spawn(input.invocation.command, [...input.args], {
        cwd: process.cwd(),
        stdio:
          input.invocation.output === "cursor-json" ? ["inherit", "pipe", "inherit"] : "inherit",
        shell: input.shell,
      });

      if (input.invocation.output === "cursor-json" && child.stdout !== null) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
      }

      child.once("error", (cause) => {
        finish(
          Effect.fail(new ExecHarnessSpawnError({ command: input.invocation.command, cause })),
        );
      });
      child.once("exit", (code, signal) => {
        if (code === 0 && input.invocation.output === "cursor-json") {
          const response = cursorFinalText(stdout);
          if (response === undefined) {
            process.stderr.write("Cursor CLI did not return a final text response.\n");
            finish(Effect.succeed(1));
            return;
          }
          process.stdout.write(
            response.endsWith("\n") || response.length === 0 ? response : `${response}\n`,
          );
        }
        finish(Effect.succeed(code ?? (signal === null ? 0 : 1)));
      });
    } catch (cause) {
      finish(Effect.fail(new ExecHarnessSpawnError({ command: input.invocation.command, cause })));
    }
  });

export const execCommand = Command.make("exec", {
  prompt: Argument.String("prompt").pipe(
    Argument.withDescription("Prompt to send to the harness."),
  ),
}).pipe(
  Command.withDescription("Run one prompt through a harness CLI and print its final response."),
  Command.withHandler(({ prompt }) =>
    Effect.gen(function* () {
      const selectedProvider = yield* execProviderGlobalFlag;
      if (Option.isNone(selectedProvider)) {
        return yield* new ExecProviderRequiredError();
      }

      const provider = selectedProvider.value;
      const invocation = HARNESS_INVOCATIONS[provider];
      if (!(yield* isCommandAvailable(invocation.command))) {
        return yield* new ExecHarnessUnavailableError({
          provider,
          command: invocation.command,
        });
      }

      const spawnSpec = yield* resolveSpawnCommand(invocation.command, invocation.args(prompt));
      const exitCode = yield* runHarness({
        invocation,
        args: spawnSpec.args,
        shell: spawnSpec.shell,
      });
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    }),
  ),
);
