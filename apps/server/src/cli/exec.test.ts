// @effect-diagnostics nodeBuiltinImport:off - exec tests stage fake harness executables on a temp PATH.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t2code/shared/HostProcess";
import * as NetService from "@t2code/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cursorFinalText, execCommand, execProviderGlobalFlag } from "./exec.ts";

const cli = Command.make("t2code").pipe(
  Command.withGlobalFlags([execProviderGlobalFlag]),
  Command.withSubcommands([execCommand]),
);

const layers = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const withFakeBin = (scripts: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t2-exec-"));
      for (const [name, body] of Object.entries(scripts)) {
        const file = NodePath.join(dir, name);
        NodeFS.writeFileSync(file, `#!/bin/sh\n${body}\n`);
        NodeFS.chmodSync(file, 0o755);
      }
      return dir;
    }),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const runExec = (args: ReadonlyArray<string>, binDir: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(Command.runWith(cli, { version: "0.0.0" })(args));
    const lines = yield* TestConsole.logLines;
    return { exit, lines };
  }).pipe(
    Effect.provideService(HostProcess.Environment, { PATH: binDir }),
    Effect.provide(Layer.mergeAll(layers, TestConsole.layer)),
  );

const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const error: unknown = exit.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [reason.error] : [],
  )[0];
  return typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
};

// oxlint-disable-next-line t2code/no-global-process-runtime -- the fake harnesses are POSIX shell scripts
describe.skipIf(NodeOS.platform() === "win32")("exec command", () => {
  it.effect("fails with a typed error when no harness is selected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bin = yield* withFakeBin({});
        const { exit } = yield* runExec(["exec", "hi"], bin);
        expect(failureTag(exit)).toBe("ExecProviderRequiredError");
      }),
    ),
  );

  it.effect("rejects the removed fx harness", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bin = yield* withFakeBin({});
        const { exit } = yield* runExec(["--provider", "fx", "exec", "hi"], bin);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureTag(exit)).not.toBe("ExecHarnessUnavailableError");
      }),
    ),
  );

  it.effect("reports a harness that is not on PATH", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bin = yield* withFakeBin({});
        const { exit } = yield* runExec(["-p", "claude", "exec", "hi"], bin);
        expect(failureTag(exit)).toBe("ExecHarnessUnavailableError");
      }),
    ),
  );

  it.effect("maps a non-zero harness exit to a typed failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bin = yield* withFakeBin({ codex: "exit 3" });
        const { exit } = yield* runExec(["--provider", "codex", "exec", "hi"], bin);
        expect(failureTag(exit)).toBe("ExecHarnessExitError");
      }),
    ),
  );

  it.effect("prints the cursor final result and fails when it is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ok = yield* withFakeBin({ "cursor-agent": `echo '{"result":"done"}'` });
        const success = yield* runExec(["-p", "cursor", "exec", "hi"], ok);
        expect(Exit.isSuccess(success.exit)).toBe(true);
        expect(success.lines).toEqual(["done"]);

        const bad = yield* withFakeBin({ "cursor-agent": "echo not-json" });
        const failure = yield* runExec(["-p", "cursor", "exec", "hi"], bad);
        expect(failureTag(failure.exit)).toBe("ExecCursorResponseError");
      }),
    ),
  );

  it("extracts only string results from cursor JSON", () => {
    expect(cursorFinalText('{"result":"x"}')).toBe("x");
    expect(cursorFinalText('{"result":1}')).toBeUndefined();
    expect(cursorFinalText("nope")).toBeUndefined();
  });
});
