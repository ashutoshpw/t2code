import { describe, expect, it } from "vite-plus/test";

import {
  sendLaterDisabledReason,
  sendLaterTitle,
  SEND_LATER_TITLE_MAX_LENGTH,
} from "./sendLater.logic";

const ready = {
  isServerThread: true,
  environmentAvailable: true,
  canSchedule: true,
  isEditingQueuedMessage: false,
  hasNonTextContent: false,
  prompt: "Run the migration tomorrow morning.",
};

describe("sendLaterDisabledReason", () => {
  it("is available for a plain text message in a connected server thread", () => {
    expect(sendLaterDisabledReason(ready)).toBeNull();
  });

  it.each([
    [{ isServerThread: false }, "first message"],
    [{ environmentAvailable: false }, "disconnected"],
    [{ canSchedule: false }, "cannot schedule"],
    [{ isEditingQueuedMessage: true }, "queued message"],
    [{ hasNonTextContent: true }, "Text only"],
    [{ prompt: "  \n " }, "Write a message"],
  ])("explains why %o is unavailable", (override, expected) => {
    expect(sendLaterDisabledReason({ ...ready, ...override })).toContain(expected);
  });

  it("reports an over-long prompt instead of scheduling something that cannot send", () => {
    const reason = sendLaterDisabledReason({ ...ready, prompt: "x".repeat(2_000_000) });
    expect(reason).toContain("over the");
  });
});

describe("sendLaterTitle", () => {
  it("uses the first non-empty line", () => {
    expect(sendLaterTitle("\n  Ship the fix  \nmore detail")).toBe("Ship the fix");
  });

  it("truncates long first lines", () => {
    const title = sendLaterTitle("a".repeat(500));
    expect(title).toHaveLength(SEND_LATER_TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back for a blank prompt", () => {
    expect(sendLaterTitle("   ")).toBe("Scheduled message");
  });
});
