import { ProjectId } from "@t2code/contracts";
import type { AtomCommandResult } from "@t2code/client-runtime/state/runtime";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import {
  createAgentHistoryImportState,
  describeAgentHistoryImportOutcome,
  filterCandidatesInWindow,
  runAgentHistoryImport,
  sinceIsoForWindow,
  type AgentHistoryImportDeps,
} from "./importHistory.logic";

const ENVIRONMENT_ID = "env-1" as never;

function candidate(path: string, overrides: Partial<ReturnType<typeof makeCandidate>> = {}) {
  return makeCandidate(path, overrides);
}

function makeCandidate(
  path: string,
  overrides: Partial<{
    title: string;
    sources: ReadonlyArray<"claudeAgent" | "codex">;
    threadCount: number;
    lastActiveAt: string | null;
    alreadyImported: boolean;
  }> = {},
) {
  return {
    path,
    title: overrides.title ?? path.split("/").at(-1) ?? path,
    sources: overrides.sources ?? (["codex"] as const),
    threadCount: overrides.threadCount ?? 1,
    lastActiveAt:
      overrides.lastActiveAt !== undefined ? overrides.lastActiveAt : "2026-08-20T12:00:00.000Z",
    alreadyImported: overrides.alreadyImported ?? false,
  };
}

const success = <A>(value: A): AtomCommandResult<A, unknown> =>
  AsyncResult.success(value) as AtomCommandResult<A, unknown>;
const failure = (): AtomCommandResult<unknown, unknown> =>
  AsyncResult.failure(Cause.fail("boom")) as AtomCommandResult<unknown, unknown>;

function makeDeps(overrides: Partial<AgentHistoryImportDeps> = {}): AgentHistoryImportDeps {
  return {
    environmentId: ENVIRONMENT_ID,
    selection: [],
    since: null,
    state: createAgentHistoryImportState(),
    isCancelled: () => false,
    commandIdPrefix: "test",
    listProjects: () => [],
    createProject: () => Promise.resolve(success(undefined)),
    importThreads: () => Promise.resolve(success({ importedCount: 1, skippedCount: 0 })),
    ...overrides,
  };
}

describe("runAgentHistoryImport", () => {
  it("creates missing projects then imports history for each candidate", async () => {
    const created: Array<string> = [];
    const imported: Array<string> = [];
    const summary = await runAgentHistoryImport(
      makeDeps({
        selection: [candidate("/ws/a"), candidate("/ws/b")],
        createProject: (request) => {
          created.push(request.input.workspaceRoot);
          return Promise.resolve(success(undefined));
        },
        importThreads: (request) => {
          imported.push(request.input.expectedWorkspaceRoot);
          return Promise.resolve(success({ importedCount: 2, skippedCount: 0 }));
        },
      }),
    );

    expect(created).toEqual(["/ws/a", "/ws/b"]);
    expect(imported).toEqual(["/ws/a", "/ws/b"]);
    expect(summary).toMatchObject({
      importedThreadCount: 4,
      skippedThreadCount: 0,
      completedCount: 2,
      shouldRefreshScan: false,
      interrupted: false,
    });
  });

  it("reuses the server-matched project instead of creating one", async () => {
    const created: Array<string> = [];
    const projectId = ProjectId.make("existing");
    await runAgentHistoryImport(
      makeDeps({
        selection: [candidate("/ws/a")],
        listProjects: () => [
          { id: projectId, environmentId: ENVIRONMENT_ID, workspaceRoot: "/ws/a" },
        ],
        createProject: (request) => {
          created.push(request.input.workspaceRoot);
          return Promise.resolve(success(undefined));
        },
      }),
    );
    expect(created).toEqual([]);
  });

  it("skips paths completed by an earlier run", async () => {
    const state = createAgentHistoryImportState();
    state.completedProjects.set("/ws/a", ProjectId.make("a"));
    const imported: Array<string> = [];
    const summary = await runAgentHistoryImport(
      makeDeps({
        selection: [candidate("/ws/a"), candidate("/ws/b")],
        state,
        importThreads: (request) => {
          imported.push(request.input.expectedWorkspaceRoot);
          return Promise.resolve(success({ importedCount: 0, skippedCount: 0 }));
        },
      }),
    );
    expect(imported).toEqual(["/ws/b"]);
    expect(summary.completedCount).toBe(2);
  });

  it("stops without recording results when cancelled mid-batch", async () => {
    let cancelled = false;
    const created: Array<string> = [];
    const summary = await runAgentHistoryImport(
      makeDeps({
        selection: [candidate("/ws/a"), candidate("/ws/b")],
        isCancelled: () => cancelled,
        createProject: (request) => {
          if (request.input.workspaceRoot === "/ws/a") cancelled = true;
          created.push(request.input.workspaceRoot);
          return Promise.resolve(success(undefined));
        },
      }),
    );
    expect(created).toEqual(["/ws/a"]);
    expect(summary.interrupted).toBe(true);
  });

  it("records a failed creation and reports a stale scan", async () => {
    const summary = await runAgentHistoryImport(
      makeDeps({
        selection: [candidate("/ws/a")],
        createProject: () => Promise.resolve(failure()),
      }),
    );
    expect(summary.completedCount).toBe(0);
    expect(summary.shouldRefreshScan).toBe(true);
  });

  it("passes the since window to every import request", async () => {
    const requested: Array<string | null | undefined> = [];
    await runAgentHistoryImport(
      makeDeps({
        selection: [candidate("/ws/a")],
        since: "2026-01-01T00:00:00.000Z",
        importThreads: (request) => {
          requested.push(request.input.since);
          return Promise.resolve(success({ importedCount: 0, skippedCount: 0 }));
        },
      }),
    );
    expect(requested).toEqual(["2026-01-01T00:00:00.000Z"]);
  });
});

describe("describeAgentHistoryImportOutcome", () => {
  const base = {
    completedCount: 0,
    selectionCount: 1,
    importedThreadCount: 0,
    skippedThreadCount: 0,
  };

  it("is quiet when every selected project completed", () => {
    expect(describeAgentHistoryImportOutcome({ ...base, completedCount: 1 })).toBeNull();
  });

  it.each([
    [
      { ...base, importedThreadCount: 2, skippedThreadCount: 1 },
      "Imported 2 threads. 1 thread could not be imported.",
    ],
    [{ ...base, skippedThreadCount: 3 }, "3 threads could not be imported."],
    [
      { ...base, importedThreadCount: 1 },
      "Imported 1 thread. Some thread history could not be imported.",
    ],
    [base, "Could not import thread history."],
  ])("summarizes %j", (summary, expected) => {
    expect(describeAgentHistoryImportOutcome(summary)).toBe(expected);
  });
});

describe("sinceIsoForWindow", () => {
  it("maps windows to import bounds", () => {
    expect(sinceIsoForWindow("recent", "")).toBeNull();
    expect(sinceIsoForWindow("all", "")).toBe("1970-01-01T00:00:00.000Z");
    expect(sinceIsoForWindow("custom", "2026-06-01")).toBe("2026-06-01T00:00:00.000Z");
    expect(sinceIsoForWindow("custom", "")).toBeNull();
  });
});

describe("filterCandidatesInWindow", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");

  it("keeps recent activity for the default window and drops undated candidates", () => {
    const candidates = [
      candidate("/ws/recent", { lastActiveAt: "2026-08-20T12:00:00.000Z" }),
      candidate("/ws/old", { lastActiveAt: "2026-06-01T12:00:00.000Z" }),
      candidate("/ws/undated", { lastActiveAt: null }),
    ];
    expect(filterCandidatesInWindow(candidates, null, now).map((entry) => entry.path)).toEqual([
      "/ws/recent",
    ]);
  });

  it("keeps every dated-or-not candidate for an explicit window", () => {
    const candidates = [
      candidate("/ws/old", { lastActiveAt: "2026-06-01T12:00:00.000Z" }),
      candidate("/ws/undated", { lastActiveAt: null }),
    ];
    expect(filterCandidatesInWindow(candidates, "2026-06-01T00:00:00.000Z", now)).toHaveLength(2);
    expect(filterCandidatesInWindow(candidates, "2026-07-01T00:00:00.000Z", now)).toHaveLength(1);
  });
});
