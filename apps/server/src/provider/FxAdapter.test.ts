// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ApprovalRequestId,
  FxSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t2code/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeFxAdapter } from "./FxAdapter.ts";

import { encodedFxPromptFrameBytes, FX_MAX_ACP_FRAME_BYTES } from "./FxAdapter.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const fxInstanceId = ProviderInstanceId.make("fx-test");
const mockAgentPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

async function makeFxMock(
  binaryDirectory: string,
  requestLogPath: string,
  env: Record<string, string>,
) {
  return writeFakeCli({
    directory: binaryDirectory,
    name: "fx",
    env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...env },
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

async function readRequestMethods(path: string): Promise<ReadonlyArray<string>> {
  const raw = await NodeFSP.readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { method?: unknown }).method)
    .filter((method): method is string => typeof method === "string");
}

function collectFxEvents(
  adapter: {
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
    readonly respondToRequest: (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel",
    ) => Effect.Effect<void, unknown>;
  },
  events: ProviderRuntimeEvent[],
) {
  return Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.gen(function* () {
      events.push(event);
      if (event.type === "request.opened" && event.requestId) {
        yield* adapter.respondToRequest(
          ThreadId.make(String(event.threadId)),
          ApprovalRequestId.make(String(event.requestId)),
          "accept",
        );
      }
    }),
  );
}

const fxAdapterTestLayer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-fx-adapter-test-" })),
    Effect.provide(NodeServices.layer),
  );

describe("FxAdapter", () => {
  it.effect("starts native ACP, applies model and mode, and translates approval events", () =>
    fxAdapterTestLayer(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-fx-mock-",
        });
        const requestLogPath = NodePath.join(directory, "requests.ndjson");
        const fxPath = yield* Effect.promise(() =>
          makeFxMock(directory, requestLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        const adapter = yield* makeFxAdapter(
          decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          { instanceId: fxInstanceId },
        );
        const events: ProviderRuntimeEvent[] = [];
        const eventFiber = yield* collectFxEvents(adapter, events).pipe(Effect.forkChild);
        const threadId = ThreadId.make("fx-approval-thread");

        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("fx"),
          providerInstanceId: fxInstanceId,
          cwd: process.cwd(),
          runtimeMode: "auto",
          modelSelection: { instanceId: fxInstanceId, model: "composer-2" },
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run the mock tool",
          attachments: [],
        });
        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(eventFiber);

        const methods = yield* Effect.promise(() => readRequestMethods(requestLogPath));
        assert.equal(session.provider, ProviderDriverKind.make("fx"));
        assert.equal(String(turn.threadId), String(threadId));
        assert.include(methods, "initialize");
        assert.include(methods, "session/new");
        assert.include(methods, "session/set_config_option");
        assert.include(methods, "session/set_mode");
        assert.include(methods, "session/prompt");
        assert.notInclude(methods, "authenticate");

        const requestOpened = events.find((event) => event.type === "request.opened");
        assert.isDefined(requestOpened);
        if (requestOpened?.type === "request.opened") {
          assert.deepEqual(requestOpened.payload.options, [
            { decision: "accept", label: "Allow once" },
            { decision: "acceptForSession", label: "Allow always" },
            { decision: "decline", label: "Reject" },
          ]);
        }
        assert.includeMembers(
          events.map((event) => event.type),
          [
            "session.started",
            "turn.started",
            "request.opened",
            "request.resolved",
            "content.delta",
            "turn.completed",
            "session.exited",
          ],
        );
      }),
    ),
  );

  it.effect("auto-approves full-access permissions without ACP mode downgrade", () =>
    fxAdapterTestLayer(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-fx-full-access-",
        });
        const requestLogPath = NodePath.join(directory, "requests.ndjson");
        const fxPath = yield* Effect.promise(() =>
          makeFxMock(directory, requestLogPath, { T3_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        const adapter = yield* makeFxAdapter(
          decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          { instanceId: fxInstanceId },
        );
        const events: ProviderRuntimeEvent[] = [];
        const eventFiber = yield* collectFxEvents(adapter, events).pipe(Effect.forkChild);
        const threadId = ThreadId.make("fx-full-access-thread");

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("fx"),
          providerInstanceId: fxInstanceId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "run without approval", attachments: [] });
        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(eventFiber);

        const methods = yield* Effect.promise(() => readRequestMethods(requestLogPath));
        assert.notInclude(
          events.map((event) => event.type),
          "request.opened",
        );
        assert.notInclude(methods, "session/set_mode");
        assert.notInclude(methods, "authenticate");
      }),
    ),
  );
});

describe("encodedFxPromptFrameBytes", () => {
  it("counts the complete ACP request envelope using UTF-8 bytes", () => {
    const sessionId = "fx-session-✓";
    const prompt = [{ type: "text" as const, text: "héllo" }];
    const expected = Buffer.byteLength(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: Number.MAX_SAFE_INTEGER,
        method: "session/prompt",
        params: { sessionId, prompt },
        headers: [],
      })}\n`,
      "utf8",
    );

    expect(encodedFxPromptFrameBytes(sessionId, prompt)).toBe(expected);
  });

  it("includes the runtime prompt and session id in the bounded frame", () => {
    const shortPrompt = [{ type: "text" as const, text: "x" }];
    const longPrompt = [{ type: "text" as const, text: "x".repeat(512) }];

    expect(encodedFxPromptFrameBytes("fx-session-short", longPrompt)).toBeGreaterThan(
      encodedFxPromptFrameBytes("fx-session-short", shortPrompt),
    );
    expect(encodedFxPromptFrameBytes("fx-session-long", shortPrompt)).toBeGreaterThan(
      encodedFxPromptFrameBytes("fx", shortPrompt),
    );
    expect(FX_MAX_ACP_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });

  it("accepts the exact byte limit and rejects the next byte", () => {
    const sessionId = "fx-session";
    const maxTextLength = (() => {
      let low = 0;
      let high = FX_MAX_ACP_FRAME_BYTES;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const bytes = encodedFxPromptFrameBytes(sessionId, [
          { type: "text" as const, text: "x".repeat(middle) },
        ]);
        if (bytes <= FX_MAX_ACP_FRAME_BYTES) low = middle;
        else high = middle - 1;
      }
      return low;
    })();

    const atLimit = encodedFxPromptFrameBytes(sessionId, [
      { type: "text" as const, text: "x".repeat(maxTextLength) },
    ]);
    const overLimit = encodedFxPromptFrameBytes(sessionId, [
      { type: "text" as const, text: "x".repeat(maxTextLength + 1) },
    ]);

    expect(atLimit).toBeLessThanOrEqual(FX_MAX_ACP_FRAME_BYTES);
    expect(overLimit).toBeGreaterThan(FX_MAX_ACP_FRAME_BYTES);
  });

  it("counts multibyte text and multiple image blocks", () => {
    const oneImage = [
      { type: "text" as const, text: "✓" },
      { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
    ];
    const twoImages = [
      ...oneImage,
      { type: "image" as const, data: "d29ybGQ=", mimeType: "image/jpeg" },
    ];

    expect(encodedFxPromptFrameBytes("fx", oneImage)).toBeGreaterThan(
      encodedFxPromptFrameBytes("fx", [{ type: "text" as const, text: "x" }]),
    );
    expect(encodedFxPromptFrameBytes("fx", twoImages)).toBeGreaterThan(
      encodedFxPromptFrameBytes("fx", oneImage),
    );
  });
});
