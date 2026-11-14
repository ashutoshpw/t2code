import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { SpacePageId, SpaceRecoveryOperation } from "@t2code/contracts/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { useEnvironment } from "../state/environments";
import { spaceRootReorder } from "./sessionRuntime";
import type { SpaceRootReorder, SpaceRecoveryPreview } from "@t2code/client-runtime/spaces";

const run = (work: Promise<unknown>) => {
  void work.catch(() => {});
};
interface Props {
  environmentId: EnvironmentId;
  pageId?: SpacePageId;
  current?: () => boolean;
}
export default function SpaceRecoveryControls(props: Props) {
  const capability = useEnvironment(props.environmentId)?.serverConfig?.environment.capabilities
    .spaces;
  if (capability?.version !== 2 || (props.pageId && capability.features?.recovery !== true))
    return null;
  return <RecoveryOwner key={props.environmentId} {...props} />;
}
function RecoveryOwner(props: Props) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const [result] = useState(() => {
    try {
      return { owner: spaceRootReorder(registry, environmentId) };
    } catch (error) {
      return { error };
    }
  });
  if (!result.owner)
    return (
      <p role="alert">
        {result.error instanceof Error ? result.error.message : "Recovery journal is unavailable."}
      </p>
    );
  return <Recovery {...props} owner={result.owner} />;
}
function Recovery({ environmentId, owner, pageId, current }: Props & { owner: SpaceRootReorder }) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [selected, setSelected] = useState<SpaceRecoveryPreview | null>(null);
  const availability = useSpacesAvailability(environmentId);
  const capability = useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces;
  const supported = capability?.version === 2 && capability.features?.recovery === true;
  const trashPermission = useAtomValue(spacesEnvironment.trashPage.permissionAtom(environmentId));
  const purgePermission = useAtomValue(
    spacesEnvironment.permanentlyDeletePage.permissionAtom(environmentId),
  );
  const restorePermission = useAtomValue(
    spacesEnvironment.restorePage.permissionAtom(environmentId),
  );
  // oxlint-disable-next-line t2code/react-effect-budget -- Recover the shared durable journal even when trashed page metadata cannot load.
  useEffect(() => {
    run(owner.hydrate());
  }, [owner]);
  const { busy, hydrated, journal, trash } = snapshot;
  const preview = selected === snapshot.recoveryPreview ? selected : null;
  const inspect = async (id: SpacePageId, operation: SpaceRecoveryOperation) => {
    if (operation === "trash" && current && !current()) return;
    setSelected(null);
    setConfirmation("");
    await owner.previewRecovery(id, operation);
    if (operation !== "trash" || !current || current())
      setSelected(owner.getSnapshot().recoveryPreview);
  };
  const pending = journal.pending;
  const writable =
    supported &&
    availability === "writable" &&
    ((preview?.operation ?? (pageId ? "trash" : "restore")) === "trash"
      ? trashPermission
      : preview?.operation === "permanentlyDelete"
        ? purgePermission
        : restorePermission);
  const blocked = !hydrated || busy || !!pending;
  const retained = journal.history;
  const history = retained && "pageIds" in retained ? retained : null;
  return (
    <div className="mt-3">
      <Button
        variant="outline"
        disabled={!!pageId && (blocked || !writable || (!!current && !current()))}
        onClick={() => {
          if (pageId && current && !current()) return;
          setOpen(true);
          if (pageId) run(inspect(pageId, "trash"));
        }}
      >
        {pageId
          ? "Move page to trash…"
          : supported
            ? "Trash and recovery"
            : "Structural receipt recovery"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setSelected(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>Trash and recovery</DialogTitle>
          <DialogDescription>
            Inspect the current selected batch before confirming. Save or resolve affected drafts
            first. Close unavailable page views before recovery. One guarded visibility inverse may
            be retained for the last bounded action. It does not undo content or placement.
            Permanent deletion is irreversible and has no Undo.
          </DialogDescription>
          <div className="mt-4 space-y-3">
            {history ? (
              <div className="space-y-2">
                <p>
                  Last bounded {history.scope} action · {history.pageIds.length} page(s) ·{" "}
                  {history.pageId}. Visibility only; existing content and placement histories are
                  separate. Trashing creates a new batch.
                </p>
                <Button
                  variant="outline"
                  disabled={
                    blocked ||
                    !supported ||
                    availability !== "writable" ||
                    (history.operation === "trashPage" ? !trashPermission : !restorePermission)
                  }
                  onClick={() => run(owner.compensate(history.direction))}
                >
                  {history.direction === "undo" ? "Undo" : "Redo"} last {history.scope} visibility (
                  {history.operation === "trashPage" ? "move to trash" : "restore"})
                </Button>
              </div>
            ) : null}
            {!supported ? (
              <p role="status">
                This environment does not advertise Trash support. Retained receipt recovery remains
                available.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={blocked || !supported}
                onClick={() => run(owner.browseTrash())}
              >
                First trash pages
              </Button>
              <Button
                variant="outline"
                disabled={blocked || !supported || !trash?.nextCursor}
                onClick={() => run(owner.browseTrash(true))}
              >
                Next trash pages
              </Button>
              {!hydrated && snapshot.error ? (
                <Button variant="outline" disabled={busy} onClick={() => run(owner.hydrate())}>
                  Retry recovery storage
                </Button>
              ) : null}
            </div>
            {trash ? (
              <>
                {trash.items.length === 0 ? (
                  <p>
                    {trash.nextCursor
                      ? "No trash roots in this window. Next continues the bounded list."
                      : "No trash roots in this window; this list has ended."}
                  </p>
                ) : null}
                <ul className="space-y-2">
                  {trash.items.map((page) => (
                    <li key={page.pageId}>
                      <p>
                        {page.title || "Untitled page"} · {page.pageId} · Revision {page.revision}
                      </p>
                      <Button
                        variant="outline"
                        disabled={blocked || !supported}
                        onClick={() => run(inspect(page.pageId, "restore"))}
                      >
                        Inspect restore
                      </Button>
                      <Button
                        variant="outline"
                        disabled={blocked || !supported}
                        onClick={() => run(inspect(page.pageId, "permanentlyDelete"))}
                      >
                        Inspect permanent deletion…
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {preview ? (
              <div className="space-y-2">
                <p>
                  {preview.operation === "trash"
                    ? "Move to trash"
                    : preview.operation === "restore"
                      ? "Restore"
                      : "Permanently delete"}
                  : {preview.pageId}
                </p>
                <p>{preview.placement}</p>
                <p>Current selected pages ({preview.inspection.recovery!.pageIds.length}):</p>
                <ul>
                  {preview.inspection.recovery!.pageIds.map((id) => (
                    <li key={id}>
                      {preview.inspection.pages.find((p) => p.id === id)?.title || "Untitled page"}{" "}
                      · {id}
                      {preview.operation === "restore" && id !== preview.pageId ? (
                        <Button
                          variant="outline"
                          disabled={blocked || !supported}
                          onClick={() => run(inspect(id, "restore"))}
                        >
                          Inspect restore starting here
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {preview.operation === "permanentlyDelete" ? (
                  <label>
                    This permanently deletes the named {preview.inspection.recovery!.pageIds.length}{" "}
                    page(s), including their inspected descendants. This cannot be undone. Type
                    DELETE to confirm
                    <Input
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </label>
                ) : null}
                <Button
                  variant="outline"
                  disabled={
                    blocked ||
                    (preview.operation === "permanentlyDelete" && confirmation !== "DELETE") ||
                    !writable ||
                    (preview.operation === "trash" && !!current && !current())
                  }
                  onClick={() => {
                    if (preview.operation !== "trash" || !current || current())
                      run(
                        owner.confirmRecovery(
                          preview,
                          preview.operation === "permanentlyDelete" && confirmation === "DELETE",
                        ),
                      );
                  }}
                >
                  {preview.operation === "trash"
                    ? "Confirm move to trash"
                    : preview.operation === "restore"
                      ? "Confirm restore"
                      : `Permanently delete ${preview.inspection.recovery!.pageIds.length} page(s) (irreversible)`}
                </Button>
              </div>
            ) : null}
            {pending ? (
              <div className="space-y-2">
                <p role="status">
                  Retained {pending.request.operation}.{" "}
                  {pending.rejection
                    ? "Rejected before commit by the server; reinspection starts a new intent."
                    : pending.conflict
                      ? "Conflicted; reinspection starts a new intent."
                      : "Resolve the exact receipt before editing affected pages."}
                </p>
                <Button
                  variant="outline"
                  disabled={busy || !hydrated || (pending.conflict && availability !== "writable")}
                  onClick={() => run(pending.conflict ? owner.reinspect() : owner.recover())}
                >
                  {pending.rejection
                    ? pending.request.operation === "permanentlyDeletePage"
                      ? "Reinspect rejected deletion"
                      : "Inspect rejected operation"
                    : pending.conflict
                      ? "Reinspect conflicted operation"
                      : "Recover exact receipt"}
                </Button>
              </div>
            ) : null}
            {snapshot.notice ? <p role="status">{snapshot.notice}</p> : null}
            {snapshot.error ? (
              <p role="alert">
                {snapshot.error instanceof Error
                  ? snapshot.error.message
                  : "Recovery failed; retained data has been kept."}
              </p>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
