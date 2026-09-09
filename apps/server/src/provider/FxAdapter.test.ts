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
