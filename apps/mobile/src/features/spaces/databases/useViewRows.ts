import {
  canonicalJson,
  deriveViewRows,
  queryKey,
  type DatabaseQuerySession,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceDataSourceId,
  SpaceDatabaseQueryInput,
  SpaceGroupKey,
} from "@t2code/contracts/spaces";
import { useEffect, useState, useSyncExternalStore } from "react";

import { appAtomRegistry } from "../../../state/atom-registry";
import { isAppActive, subscribeAppState } from "../../../lib/appState";
import { databaseAtoms, databaseWriter, openViewSession } from "../../../state/spacesDatabases";
import { backgroundPolicy } from "./backgroundPolicy";

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "These rows could not be loaded.";

const intersects = (dependencies: ReadonlySet<string>, ids: ReadonlySet<string>) => {
  for (const id of ids) if (dependencies.has(id)) return true;
  return false;
};

/**
 * One query session for a view. Windowed: the first window, then `loadMore` or `loadBucket` on
 * demand. Nothing runs while the app is in the background; coming back after a while refreshes.
 */
export function useViewRows(
  environmentId: EnvironmentId,
  dataSourceId: SpaceDataSourceId,
  input: SpaceDatabaseQueryInput | null,
  /** The properties whose edit can change which rows this view shows or where; unknown means all. */
  watch: ReadonlySet<string> | null = null,
  now: () => number = Date.now,
) {
  const writer = databaseWriter(environmentId);
  const [session] = useState<DatabaseQuerySession>(() =>
    openViewSession(environmentId, dataSourceId),
  );
  // The set is rebuilt on every render; its content is the identity.
  const watchKey = watch === null ? null : [...watch].sort().join("\n");
  const key = input === null ? null : queryKey(input);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Drive the external query session from the derived input; a key change keeps the old windows until the new ones arrive.
  useEffect(() => {
    // `key` is the identity of `input`, which is rebuilt on every render.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    session.setInput(input);
  }, [session, key]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Subscribe the external session to data-source changes and to the app leaving and returning to the foreground.
  useEffect(() => {
    let release: (() => void) | null = null;
    let leftAt: number | null = null;
    const stopChanges = appAtomRegistry.subscribe(
      databaseAtoms.dataSourceChanged(environmentId, dataSourceId),
      () => session.invalidate(),
    );
    const stopAppState = subscribeAppState(() => {
      if (isAppActive()) {
        release?.();
        release = null;
        if (backgroundPolicy(leftAt, now()) === "refresh") session.refresh();
        leftAt = null;
      } else if (release === null) {
        release = session.hold();
        leftAt = now();
      }
    });
    return () => {
      stopChanges();
      stopAppState();
      release?.();
      // Clears timers and drops late answers; the next mount sets its input again.
      session.setInput(null);
    };
  }, [session, environmentId, dataSourceId, now]);

  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Tell the external session about this client's own acknowledged writes; a watch change must not restart the session.
  useEffect(() => {
    const watched = watchKey === null ? null : new Set(watchKey.split("\n"));
    return writer.onAck((ack) => {
      if (ack.dataSourceId !== dataSourceId) return;
      session.noteAck({
        dataRevision: ack.dataRevision,
        affects: watched === null || intersects(watched, ack.propertyIds),
        structural: ack.structural,
        edits: ack.edits,
      });
    });
  }, [session, writer, dataSourceId, watchKey]);

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const written = useSyncExternalStore(writer.subscribe, writer.getSnapshot);
  const { rows, groups } = deriveViewRows({
    mode: input?.mode ?? "rows",
    dataSourceId,
    snapshot,
    writerPending: written.pending,
  });
  const windows = snapshot.windows;
  return {
    status: snapshot.status === "idle" ? ("loading" as const) : snapshot.status,
    error: snapshot.status === "error" ? messageOf(snapshot.error) : null,
    loadError: snapshot.loadError === undefined ? null : messageOf(snapshot.loadError),
    rows,
    groups,
    relatedPages: snapshot.relatedPages,
    total: windows?.total,
    hasMore: windows?.nextCursor != null,
    loadingMore: snapshot.loadingMore,
    stale: snapshot.stale,
    computedPending: snapshot.computedPending,
    loadMore: () => session.loadMore(),
    loadBucket: (bucket: SpaceGroupKey) => session.loadBucket(bucket),
    bucketLoading: (bucket: SpaceGroupKey) => snapshot.loadingBuckets.has(canonicalJson(bucket)),
    retry: () => session.refresh(),
    retryLoad: () => session.retryLoad(),
  };
}
