import { describe, expect, it } from "@effect/vitest";

import { encodedFxPromptFrameBytes, FX_MAX_ACP_FRAME_BYTES } from "./FxAdapter.ts";

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
});
