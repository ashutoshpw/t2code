import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { SpaceRootReorder, SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { spaceRootReorder } from "./sessionRuntime";

interface Props {
  target: SpacePageNavigationTarget;
  current: () => boolean;
}
function run(action: Promise<unknown>) {
  void action.catch(() => {});
}
export default function SpaceStructureControls(props: Props) {
  const registry = useContext(RegistryContext);
  const [result] = useState(() => {
    try {
      return { owner: spaceRootReorder(registry, props.target.environmentId) };
    } catch (error) {
      return { error };
    }
  });
  if (!result.owner)
    return (
      <p role="alert">
        {result.error instanceof Error ? result.error.message : "Placement journal is unavailable."}
      </p>
    );
  return <StructureControls {...props} owner={result.owner} />;
}
function StructureControls({ target, current, owner }: Props & { owner: SpaceRootReorder }) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [open, setOpen] = useState(false);
  const availability = useSpacesAvailability(target.environmentId);
  const permission = useAtomValue(spacesEnvironment.movePage.permissionAtom(target.environmentId));
  const writable = permission && availability === "writable" && current();
  // oxlint-disable-next-line t2code/react-effect-budget -- Load the shared durable structural journal independently of this metadata view.
  useEffect(() => {
    run(owner.hydrate());
  }, [owner]);
  const { journal, window, position, busy, hydrated } = snapshot;
  const pending = journal.pending;
  const pendingDestination = pending?.request.input.destination;
  const name = (pageId: typeof target.pageId) =>
    window?.items.find((page) => page.id === pageId)?.title || pageId;
  const history = journal.history?.pageId === target.pageId ? journal.history : null;
  const blocked = !hydrated || busy || !!pending;
  const load = (next = false) => {
    if (current()) run(owner.browse(target.spaceId, target.pageId, next));
  };
  const place = (beforePageId: typeof target.pageId | null) => {
    if (current()) run(owner.move(target.pageId, target.spaceId, beforePageId));
  };
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!writable || blocked} onClick={() => setOpen(true)}>
          Move page
        </Button>
        {history ? (
          <Button
            variant="outline"
            disabled={!writable || blocked}
            onClick={() => {
              if (current()) run(owner.compensate(history.direction));
            }}
          >
            {history.direction === "undo" ? "Undo page placement" : "Redo page placement"}
          </Button>
        ) : null}
        {pending && !pending.conflict ? (
          <Button
            variant="outline"
            disabled={busy || !hydrated}
            onClick={() => run(owner.recover())}
          >
            Recover page placement
          </Button>
        ) : null}
        {pending?.conflict ? (
          <Button
            variant="outline"
            disabled={busy || !writable}
            onClick={() => run(owner.reinspect())}
          >
            Reinspect conflicted placement
          </Button>
        ) : null}
        {!hydrated && snapshot.error ? (
          <Button variant="outline" onClick={() => run(owner.hydrate())}>
            Retry placement storage
          </Button>
        ) : null}
      </div>
      {pending ? (
        <p role="status">
          Page placement is retained.{" "}
          {pending.conflict
            ? "It conflicted; reinspection starts a new intent."
            : "Resolve its receipt before editing affected pages."}
        </p>
      ) : null}
      {pending && pendingDestination?.kind === "root" ? (
        <p>
          Attempted {pending.direction === "move" ? "move" : pending.direction}:{" "}
          {name(pending.request.input.pageId)}{" "}
          {pendingDestination.beforePageId === null
            ? "to the end of this space"
            : `before ${name(pendingDestination.beforePageId)}`}
          .
        </p>
      ) : null}
      {snapshot.notice ? <p role="status">{snapshot.notice}</p> : null}
      {snapshot.error ? (
        <p role="alert">
          {snapshot.error instanceof Error
            ? snapshot.error.message
            : "Page placement failed; retained data has been kept."}
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogTitle>Move page within this space</DialogTitle>
          <DialogDescription>
            Load this page’s original position, then choose a root placement. Save or resolve
            affected drafts first. Only one guarded placement undo/redo is retained.
          </DialogDescription>
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={blocked} onClick={() => load()}>
                Load position / First pages
              </Button>
              <Button
                variant="outline"
                disabled={blocked || !window?.nextCursor || window.space.id !== target.spaceId}
                onClick={() => load(true)}
              >
                Next pages
              </Button>
            </div>
            <p role="status">
              {position?.pageId === target.pageId
                ? "Original successor is known."
                : "Find this page using First / Next. A partial window does not prove its successor."}
            </p>
            {window?.space.id === target.spaceId ? (
              <>
                {window.items.length === 0 ? (
                  <p>{window.nextCursor ? "No pages in this window." : "No pages."}</p>
                ) : null}
                <ul className="space-y-2">
                  {window.items.map((page) => (
                    <li key={page.id}>
                      <Button
                        variant="outline"
                        disabled={
                          !writable ||
                          blocked ||
                          position?.pageId !== target.pageId ||
                          page.id === target.pageId
                        }
                        onClick={() => place(page.id)}
                      >
                        Place before {page.title || "Untitled page"}
                      </Button>
                    </li>
                  ))}
                </ul>
                {window.nextCursor === null ? (
                  <Button
                    variant="outline"
                    disabled={!writable || blocked || position?.pageId !== target.pageId}
                    onClick={() => place(null)}
                  >
                    Place at end
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
