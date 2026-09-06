import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionImportInput } from "./agentSessions.ts";

const decodeInput = Schema.decodeUnknownSync(AgentSessionImportInput);

describe("AgentSessionImportInput", () => {
  it("accepts an absent or null since window", () => {
    expect(decodeInput({ projectId: "p1" }).since).toBeUndefined();
    expect(decodeInput({ projectId: "p1", since: null }).since).toBeNull();
  });

  it("accepts a parseable since instant", () => {
    expect(decodeInput({ projectId: "p1", since: "2026-06-01T00:00:00.000Z" }).since).toBe(
      "2026-06-01T00:00:00.000Z",
    );
    expect(decodeInput({ projectId: "p1", since: "2026-06-01" }).since).toBe("2026-06-01");
  });

  it("rejects a malformed since value", () => {
    expect(() => decodeInput({ projectId: "p1", since: "not-a-date" })).toThrow();
    expect(() => decodeInput({ projectId: "p1", since: "2026-13-40" })).toThrow();
  });
});
