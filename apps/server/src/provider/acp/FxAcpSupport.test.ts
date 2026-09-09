import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyFxAcpModelSelection,
  applyFxAcpSessionConfiguration,
  buildFxAcpSpawnInput,
  resolveFxAcpBaseModelId,
  resolveFxAcpModeId,
} from "./FxAcpSupport.ts";

describe("buildFxAcpSpawnInput", () => {
  it("starts the configured FX binary in ACP mode", () => {
    expect(
      buildFxAcpSpawnInput({ binaryPath: "/usr/local/bin/fx" }, "/tmp/project", {
        FX_API_KEY: "secret",
      }),
    ).toEqual({
      command: "/usr/local/bin/fx",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { FX_API_KEY: "secret" },
    });
  });

  it("uses fx when no binary path is configured", () => {
    expect(buildFxAcpSpawnInput({ binaryPath: "" }, "/tmp/project")).toEqual({
      command: "fx",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("does not add unsupported global flags for full-access sessions", () => {
    expect(buildFxAcpSpawnInput({ binaryPath: "fx" }, "/tmp/project", undefined)).toEqual({
      command: "fx",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("forces fx's native full-access permission mode for full-access sessions", () => {
    expect(
      buildFxAcpSpawnInput(
        { binaryPath: "fx" },
        "/tmp/project",
        { FX_MODEL: "model" },
        "full-access",
      ),
    ).toEqual({
      command: "fx",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { FX_MODEL: "model", FX_PERMISSION_MODE: "full-access" },
    });
  });
});

describe("resolveFxAcpBaseModelId", () => {
  it.each([undefined, null, "", "  ", "default"])(
    "does not send %s as a model override",
    (model) => {
      expect(resolveFxAcpBaseModelId(model)).toBeUndefined();
    },
  );

  it("preserves an explicit FX model id", () => {
    expect(resolveFxAcpBaseModelId("  openai/gpt-5.4  ")).toBe("openai/gpt-5.4");
  });
});

describe("resolveFxAcpModeId", () => {
  it.each([
    ["approval-required", undefined, "ask"],
    ["full-access", undefined, undefined],
    ["auto-accept-edits", "default", "ask"],
    ["auto", "plan", "ask"],
  ] as const)("maps %s/%s to %s", (runtimeMode, interactionMode, expected) => {
    expect(resolveFxAcpModeId(runtimeMode, interactionMode)).toBe(expected);
  });
});

describe("FX ACP session configuration", () => {
  it.effect("sets the stable model option before switching to code mode", () => {
    const calls: Array<string> = [];
    const runtime = {
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push(`${id}=${String(value)}`);
          return { configOptions: [] };
        }),
      getModeState: Effect.succeed({
        currentModeId: "ask",
        availableModes: [
          { id: "ask", name: "Ask" },
          { id: "code", name: "Code" },
        ],
      }),
      setSessionMode: (modeId: string) =>
        Effect.sync(() => {
          calls.push(`mode=${modeId}`);
          return {};
        }),
    };

    return Effect.gen(function* () {
      yield* applyFxAcpSessionConfiguration({
        runtime,
        runtimeMode: "auto",
        model: "  fx-model  ",
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual(["model=fx-model", "mode=code"]);
    });
  });

  it.effect("does not send an empty model selection", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* applyFxAcpModelSelection({
        runtime: {
          setConfigOption: (id: string, value: string | boolean) =>
            Effect.sync(() => {
              calls.push(`${id}=${String(value)}`);
              return { configOptions: [] };
            }),
        },
        model: "  ",
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual([]);
    });
  });

  it.effect("sends the default sentinel when returning to FX's active model", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      yield* applyFxAcpModelSelection({
        runtime: {
          setConfigOption: (id: string, value: string | boolean) =>
            Effect.sync(() => {
              calls.push(`${id}=${String(value)}`);
              return { configOptions: [] };
            }),
        },
        model: " default ",
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual(["model=default"]);
    });
  });
});
