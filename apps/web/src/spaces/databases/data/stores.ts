import type { EnvironmentId } from "@t2code/contracts";
import { DatabaseWriter, type PendingCellEdit } from "@t2code/client-runtime/spaces";
import type { SpaceViewId } from "@t2code/contracts/spaces";
import type { AtomRegistry } from "effect/reactivity";

import { toastManager } from "../../../components/ui/toast";
import { environmentPresentations } from "../../../state/presentation";
import { databaseErrorMessage } from "@t2code/client-runtime/spaces";
import { databasePorts } from "./ports";

// Rows per mutation when the capability has not loaded yet; the server limit applies either way.
const FALLBACK_LIMITS = { maxRowsPerMutation: 50, maxCellsPerMutation: 200 };
const REJECTING_TAGS = new Set([
  "SpaceDatabaseError",
  "SpaceNotFoundError",
  "SpaceLimitExceededError",
  "SpaceValidationError",
]);

const writerRejects = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  REJECTING_TAGS.has(String(Reflect.get(error, "_tag")));

interface DatabaseStores {
  writer(environmentId: EnvironmentId): DatabaseWriter;
  readonly activeView: Map<string, SpaceViewId>;
  /** The view a row was last opened from, so its page lists properties in that view's order. */
  readonly openedFrom: Map<string, SpaceViewId>;
  readonly optionHints: Map<string, { readonly name: string; readonly color: string }>;
}

const stores = new WeakMap<AtomRegistry.AtomRegistry, DatabaseStores>();
const allWriters = new Set<DatabaseWriter>();
let flushHooked = false;

function hookFlush() {
  if (flushHooked || typeof window === "undefined") return;
  flushHooked = true;
  const flushAll = () => {
    for (const writer of allWriters) void writer.flush();
  };
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
}

/** Per-registry state shared by every database surface of the app: one writer per environment. */
export function databaseStores(registry: AtomRegistry.AtomRegistry): DatabaseStores {
  const existing = stores.get(registry);
  if (existing) return existing;
  const writers = new Map<EnvironmentId, DatabaseWriter>();
  const created: DatabaseStores = {
    writer(environmentId) {
      const known = writers.get(environmentId);
      if (known) return known;
      hookFlush();
      const writer = new DatabaseWriter({
        updateRows: async (batch) => {
          const result = await databasePorts.run.updateRows(registry, environmentId, {
            dataSourceId: batch.dataSourceId,
            rows: batch.rows.map((row) => ({ pageId: row.pageId, cells: { ...row.cells } })),
          });
          return { dataRevision: result.dataRevision };
        },
        limits: () => {
          const limits = registry.get(environmentPresentations.presentationAtom(environmentId))
            ?.serverConfig?.environment.capabilities.spaces?.limits.databases;
          return limits ?? FALLBACK_LIMITS;
        },
        schedule: (run, delayMs) => {
          const timer = setTimeout(run, delayMs);
          return () => clearTimeout(timer);
        },
        rejected: writerRejects,
        report: (error: unknown, _edits: ReadonlyArray<PendingCellEdit>) => {
          toastManager.add({
            type: "error",
            title: "Couldn't save a change",
            description: databaseErrorMessage(error),
          });
        },
      });
      allWriters.add(writer);
      writers.set(environmentId, writer);
      return writer;
    },
    activeView: new Map(),
    openedFrom: new Map(),
    optionHints: new Map(),
  };
  stores.set(registry, created);
  return created;
}
