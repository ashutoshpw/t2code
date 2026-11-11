import { DatabaseQuerySession, type DatabaseWriter } from "@t2code/client-runtime/spaces";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";
import { createDatabaseMutations } from "@t2code/client-runtime/state/spaces-database-mutations";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCursor, SpaceDataSourceId, SpaceId } from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";

import { isAppActive, subscribeAppState } from "../lib/appState";
import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { spacesEnvironment, spacesWritable } from "./spaces";
import { createCellWriter, createWriteFailures } from "./spacesDatabaseWriter";

export const databaseAtoms = spacesEnvironment.databases;

/** The shared write runner: every database write carries a receipt epoch and retries a stale one once. */
export const databaseMutations = createDatabaseMutations(databaseAtoms, {
  newMutationId: uuidv4,
  now: () => Date.now(),
});

/** Writes the server refused, for the row page to show. Cell edits are not drafts: nothing is stored on the device. */
export const writeFailures = createWriteFailures();

const writers = new Map<EnvironmentId, DatabaseWriter>();
let flushHooked = false;

/** One cell writer per environment. Leaving the foreground sends what is queued. */
export function databaseWriter(environmentId: EnvironmentId): DatabaseWriter {
  const known = writers.get(environmentId);
  if (known !== undefined) return known;
  if (!flushHooked) {
    flushHooked = true;
    subscribeAppState(() => {
      if (isAppActive()) return;
      for (const writer of writers.values()) void writer.flush();
    });
  }
  const writer = createCellWriter({
    environmentId,
    mutations: databaseMutations,
    registry: appAtomRegistry,
    canWrite: () => spacesWritable(environmentId),
    limits: () =>
      appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.serverConfig
        ?.environment.capabilities.spaces?.limits.databases,
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    failures: writeFailures,
  });
  writers.set(environmentId, writer);
  return writer;
}

export const viewerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A query session for one view. The timers are plain `setTimeout` (the session holds them while the
 * app is in the background); `busy` tells it when this client's own write is in flight.
 */
export function openViewSession(
  environmentId: EnvironmentId,
  dataSourceId: SpaceDataSourceId,
): DatabaseQuerySession {
  return new DatabaseQuerySession({
    query: async (input) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        databaseAtoms.query({ environmentId, input }),
        { refresh: true, reportFailure: false },
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    busy: () => databaseWriter(environmentId).busy(dataSourceId),
  });
}

/** One page of the databases of a space, for finding where a relation's target lives. */
export async function listDatabasePage(
  environmentId: EnvironmentId,
  spaceId: SpaceId,
  cursor: SpaceCursor | undefined,
) {
  const result = await executeAtomQuery(
    appAtomRegistry,
    databaseAtoms.list({
      environmentId,
      input: { environmentId, spaceId, ...(cursor === undefined ? {} : { cursor }) },
    }),
    { refresh: true, reportFailure: false },
  );
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
