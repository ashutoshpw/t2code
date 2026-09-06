import {
  CommandId,
  type AgentSessionImportResult,
  type AgentSessionProjectCandidate,
  type EnvironmentId,
  type ProjectId,
} from "@t2code/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@t2code/client-runtime/state/runtime";

import { newProjectId } from "../../lib/utils";
import { resolveOnboardingProjectId } from "../../onboarding/projectImport.logic";

/** Retry bookkeeping so an interrupted batch never redones completed work. */
export interface AgentHistoryImportState {
  /** Paths whose project exists and whose import fully landed (or had nothing to do). */
  readonly completedProjects: Map<string, ProjectId>;
  /** Paths that landed at least one imported thread, in priority order for landing. */
  readonly projectsWithImportedHistory: Map<string, ProjectId>;
  /** Creation attempts per path so a retry reuses the same project id. */
  readonly projectAttempts: Map<
    string,
    { readonly projectId: ProjectId; readonly commandId: CommandId }
  >;
}

export function createAgentHistoryImportState(): AgentHistoryImportState {
  return {
    completedProjects: new Map(),
    projectsWithImportedHistory: new Map(),
    projectAttempts: new Map(),
  };
}

export interface AgentHistoryImportDeps {
  readonly environmentId: EnvironmentId;
  readonly selection: ReadonlyArray<AgentSessionProjectCandidate>;
  /** Inclusive lower bound for imported history; null keeps the server's 30-day default. */
  readonly since: string | null;
  readonly state: AgentHistoryImportState;
  /** Checked between every command; superseded runs must stop without recording results. */
  readonly isCancelled: () => boolean;
  readonly commandIdPrefix: string;
  readonly listProjects: () => ReadonlyArray<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
  }>;
  readonly createProject: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly projectId: ProjectId;
      readonly commandId: CommandId;
      readonly title: string;
      readonly workspaceRoot: string;
      readonly createWorkspaceRootIfMissing: boolean;
      readonly defaultModelSelection: null;
    };
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly importThreads: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly projectId: ProjectId;
      readonly expectedWorkspaceRoot: string;
      readonly since?: string | null;
    };
  }) => Promise<AtomCommandResult<AgentSessionImportResult, unknown>>;
}

export interface AgentHistoryImportSummary {
  readonly importedThreadCount: number;
  readonly skippedThreadCount: number;
  readonly completedCount: number;
  /** A failed (non-interrupted) step means the scan result is stale. */
  readonly shouldRefreshScan: boolean;
  readonly interrupted: boolean;
}

/**
 * Import history for each selected candidate: create the project when no
 * project sits at the candidate root, then request a bounded history import.
 * Project creation attempts and completed imports are recorded in the shared
 * state so a retry after an interrupted batch skips finished paths instead of
 * tripping the duplicate-root invariant.
 */
export async function runAgentHistoryImport(
  deps: AgentHistoryImportDeps,
): Promise<AgentHistoryImportSummary> {
  const { environmentId, selection, since, state } = deps;
  let importedThreadCount = 0;
  let skippedThreadCount = 0;
  let completedCount =
    state.completedProjects.size > 0
      ? selection.filter((candidate) => state.completedProjects.has(candidate.path)).length
      : 0;
  let shouldRefreshScan = false;

  for (const candidate of selection) {
    if (deps.isCancelled()) {
      return {
        importedThreadCount,
        skippedThreadCount,
        completedCount,
        shouldRefreshScan,
        interrupted: true,
      };
    }
    if (state.completedProjects.has(candidate.path)) continue;
    let projectId = resolveOnboardingProjectId(deps.listProjects(), environmentId, candidate);
    if (projectId === null) {
      let attempt = state.projectAttempts.get(candidate.path);
      if (attempt === undefined) {
        const nextProjectId = newProjectId();
        attempt = {
          projectId: nextProjectId,
          commandId: CommandId.make(`${deps.commandIdPrefix}:project:create:${nextProjectId}`),
        };
        state.projectAttempts.set(candidate.path, attempt);
      }
      projectId = attempt.projectId;
      const result = await deps.createProject({
        environmentId,
        input: {
          projectId,
          commandId: attempt.commandId,
          title: candidate.title,
          workspaceRoot: candidate.path,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (deps.isCancelled()) {
        return {
          importedThreadCount,
          skippedThreadCount,
          completedCount,
          shouldRefreshScan,
          interrupted: true,
        };
      }
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          state.projectAttempts.delete(candidate.path);
          shouldRefreshScan = true;
        }
        continue;
      }
    }

    const threadImportResult = await deps.importThreads({
      environmentId,
      input: { projectId, expectedWorkspaceRoot: candidate.path, since },
    });
    if (deps.isCancelled()) {
      return {
        importedThreadCount,
        skippedThreadCount,
        completedCount,
        shouldRefreshScan,
        interrupted: true,
      };
    }
    if (threadImportResult._tag === "Success") {
      importedThreadCount += threadImportResult.value.importedCount;
      skippedThreadCount += threadImportResult.value.skippedCount;
      if (threadImportResult.value.importedCount > 0) {
        state.projectsWithImportedHistory.set(candidate.path, projectId);
      }
      if (threadImportResult.value.skippedCount === 0) {
        completedCount += 1;
        state.completedProjects.set(candidate.path, projectId);
      }
    } else if (!isAtomCommandInterrupted(threadImportResult)) {
      state.projectAttempts.delete(candidate.path);
      shouldRefreshScan = true;
    }
  }

  return {
    importedThreadCount,
    skippedThreadCount,
    completedCount,
    shouldRefreshScan,
    interrupted: false,
  };
}

/**
 * User-visible summary for a finished batch that did not fully complete.
 * Interrupted batches say nothing — they are neither successes nor failures.
 */
export function describeAgentHistoryImportOutcome(summary: {
  readonly completedCount: number;
  readonly selectionCount: number;
  readonly importedThreadCount: number;
  readonly skippedThreadCount: number;
}): string | null {
  if (summary.completedCount >= summary.selectionCount) return null;
  const thread = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;
  if (summary.importedThreadCount > 0 && summary.skippedThreadCount > 0) {
    return `Imported ${thread(summary.importedThreadCount)}. ${thread(summary.skippedThreadCount)} could not be imported.`;
  }
  if (summary.skippedThreadCount > 0) {
    return `${summary.skippedThreadCount} ${summary.skippedThreadCount === 1 ? "thread could" : "threads could"} not be imported.`;
  }
  if (summary.importedThreadCount > 0) {
    return `Imported ${thread(summary.importedThreadCount)}. Some thread history could not be imported.`;
  }
  return "Could not import thread history.";
}

const RECENT_PROJECT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Widens the import window to every transcript the scanner kept. */
const ALL_TIME_SINCE_ISO = "1970-01-01T00:00:00.000Z";

export type ImportWindow = "recent" | "all" | "custom";

export function sinceIsoForWindow(window: ImportWindow, customDate: string): string | null {
  if (window === "recent") return null;
  if (window === "all") return ALL_TIME_SINCE_ISO;
  return customDate.length === 0 ? null : `${customDate}T00:00:00.000Z`;
}

/**
 * Estimate which scan candidates fall inside the window from their project
 * activity. The server filters per transcript by file mtime, so this is a
 * close client-side preview, not the import authority.
 */
export function filterCandidatesInWindow(
  candidates: ReadonlyArray<AgentSessionProjectCandidate>,
  sinceIso: string | null,
  now = Date.now(),
): Array<AgentSessionProjectCandidate> {
  return candidates.filter((candidate) => {
    if (sinceIso === null) {
      if (candidate.lastActiveAt === null) return false;
      const lastActiveAt = Date.parse(candidate.lastActiveAt);
      return lastActiveAt >= now - RECENT_PROJECT_WINDOW_MS && lastActiveAt <= now;
    }
    if (candidate.lastActiveAt === null) return true;
    return Date.parse(candidate.lastActiveAt) >= Date.parse(sinceIso);
  });
}
