import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionImportInput, AgentSessionScanResult } from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);
const decodeInput = Schema.decodeUnknownSync(AgentSessionImportInput);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates from servers that predate the git scan", () => {
    const result = decodeScanResult({
      candidates: [candidate],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toBeUndefined();
  });

  it("preserves reported git identity", () => {
    const git = { remoteKey: "github.com/pingdotgg/t3code", repository: "pingdotgg/t3code" };
    const result = decodeScanResult({
      candidates: [{ ...candidate, git }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]?.git).toEqual(git);
  });
});

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
