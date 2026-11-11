import { RegistryContext } from "@effect/atom-react";
import { useContext, useSyncExternalStore } from "react";

import { Button } from "~/components/ui/button";
import { databaseStores } from "../data/stores";
import { useDatabase } from "./context";

/** "Couldn't save N changes" with Retry and Discard; nothing while edits are flowing normally. */
export function WriterStatus() {
  const registry = useContext(RegistryContext);
  const { model } = useDatabase();
  const writer = databaseStores(registry).writer(model.environmentId);
  const failed = useSyncExternalStore(writer.subscribe, () => writer.getSnapshot().failed);
  if (failed === 0) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-md border border-warning/32 bg-warning-surface px-2 py-1 text-xs text-warning-foreground"
    >
      <span>{`Couldn't save ${failed} ${failed === 1 ? "change" : "changes"}`}</span>
      <Button size="xs" variant="outline" onClick={() => writer.retry()}>
        Retry
      </Button>
      <Button size="xs" variant="ghost" onClick={() => writer.discardFailed()}>
        Discard
      </Button>
    </div>
  );
}
