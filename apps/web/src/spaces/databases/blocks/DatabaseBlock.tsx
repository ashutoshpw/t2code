import { RegistryContext } from "@effect/atom-react";
import { memo, useContext, useEffect, useSyncExternalStore } from "react";
import type { SpaceBlockId, SpaceDatabaseId, SpaceViewId } from "@t2code/contracts/spaces";

import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useEnvironment } from "../../../state/environments";
import { databasePorts } from "../data/ports";
import { useDatabaseModel } from "../data/useDatabaseModel";
import { DatabaseSkeleton } from "../shell/DatabaseSkeleton";
import { DatabaseSurface } from "../shell/DatabaseSurface";
import type { DatabaseBlockActions } from "./actions";
import {
  useDatabaseBlockHost,
  useDatabaseLayout,
  useDatabasePageEditable,
  type DatabaseBlockHost,
} from "./DatabaseBlockHost";

interface DatabaseBlockProps {
  readonly blockId: SpaceBlockId;
  readonly databaseId: SpaceDatabaseId;
  readonly viewIds: ReadonlyArray<SpaceViewId>;
  readonly actions: DatabaseBlockActions;
}

const Note = ({ children }: { readonly children: string }) => (
  <p
    role="status"
    className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground"
  >
    {children}
  </p>
);

function Loaded({
  host,
  blockId,
  databaseId,
  viewIds,
  actions,
}: DatabaseBlockProps & { readonly host: DatabaseBlockHost }) {
  const layout = useDatabaseLayout();
  const { model, error, refresh } = useDatabaseModel(host.environmentId, databaseId);
  const failure =
    error === null ? null : (
      <Alert variant="error">
        <AlertDescription>{error}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="xs" onClick={refresh}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  if (model === null) return failure ?? <DatabaseSkeleton />;
  if (!model.database.live)
    return <DatabaseUnavailable host={host} databaseId={databaseId} actions={actions} />;
  return (
    <>
      {failure}
      <DatabaseSurface
        model={model}
        blockId={blockId}
        viewIds={viewIds}
        actions={actions}
        layout={layout}
        host={host}
      />
    </>
  );
}

/** Dead until the page saves its block, then the server adopts the database and a refetch finds it live. */
function DatabaseUnavailable({
  host,
  databaseId,
  actions,
}: {
  readonly host: DatabaseBlockHost;
  readonly databaseId: SpaceDatabaseId;
  readonly actions: DatabaseBlockActions;
}) {
  const registry = useContext(RegistryContext);
  const editable = useDatabasePageEditable();
  const unsaved = useSyncExternalStore(host.controller.subscribe, () => {
    const state = host.controller.session.getSnapshot();
    return state.dirty || !!state.pending;
  });
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Watch the external page session: once it is clean the server may have adopted the database, so load it again.
  useEffect(() => {
    if (unsaved) return;
    const counter = databasePorts.changed.database(host.environmentId, databaseId);
    registry.set(counter, registry.get(counter) + 1);
  }, [unsaved, registry, host.environmentId, databaseId]);
  if (unsaved) return <Note>Saving database...</Note>;
  return (
    <div className="space-y-2 rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      <p role="status">
        The original database was deleted. Restore its page or undo the deletion to use this view.
      </p>
      {editable ? (
        <Button variant="outline" size="xs" onClick={() => actions.remove()}>
          Remove block
        </Button>
      ) : null}
    </div>
  );
}

export default memo(function DatabaseBlock(props: DatabaseBlockProps) {
  const host = useDatabaseBlockHost();
  const capability = useEnvironment(host?.environmentId ?? null)?.serverConfig?.environment
    .capabilities.spaces;
  if (host === null) return null;
  if (
    !(
      capability?.version === 2 &&
      capability.features?.databases === true &&
      capability.limits.databases
    )
  )
    return <Note>Databases need a newer T2 Code server.</Note>;
  return <Loaded host={host} {...props} />;
});
