import { DatabaseQuerySession, type DatabaseWriter } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDataSourceId } from "@t2code/contracts/spaces";
import type { AtomRegistry } from "effect/reactivity";

import { databasePorts } from "./ports";

const intersects = (dependencies: ReadonlySet<string>, ids: ReadonlySet<string>) => {
  for (const id of ids) if (dependencies.has(id)) return true;
  return false;
};

/** `source` is read at call time: a view whose data source changes keeps its session. */
export function createViewSession(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  source: { get(): { dataSourceId: SpaceDataSourceId; writer: DatabaseWriter } },
): DatabaseQuerySession {
  return new DatabaseQuerySession({
    query: (input) => databasePorts.query(registry, input),
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
    busy: () => source.get().writer.busy(source.get().dataSourceId),
    live: () => databasePorts.live(registry, environmentId),
  });
}

/** Subscribes the session to counter bumps and acknowledged own writes; returns the unsubscribe. */
export function connectViewSession(args: {
  session: DatabaseQuerySession;
  registry: AtomRegistry.AtomRegistry;
  environmentId: EnvironmentId;
  dataSourceId: SpaceDataSourceId;
  writer: DatabaseWriter;
  watched: () => ReadonlySet<string>;
}): () => void {
  const { session, dataSourceId } = args;
  const stop = [
    args.registry.subscribe(
      databasePorts.changed.dataSource(args.environmentId, dataSourceId),
      () => session.invalidate(),
    ),
    args.writer.onAck((ack) => {
      if (ack.dataSourceId !== dataSourceId) return;
      session.noteAck({
        dataRevision: ack.dataRevision,
        affects: intersects(args.watched(), ack.propertyIds),
        structural: ack.structural,
        edits: ack.edits,
      });
    }),
  ];
  return () => {
    for (const unsubscribe of stop) unsubscribe();
  };
}
