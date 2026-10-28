import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  useContext,
  useEffect,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import { useRouter } from "@tanstack/react-router";
import type { SpaceId, SpacePageId, SpaceTrashEntry } from "@t2code/contracts/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import { Trash2Icon } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { toastManager } from "../components/ui/toast";
import { RelativeTime } from "../components/RelativeTime";
import { requestConfirmDialog } from "../confirmDialog";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { useEnvironment } from "../state/environments";
import { spaceRootReorder } from "./sessionRuntime";
import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";

const run = (work: Promise<unknown>) => {
  void work.catch(() => {});
};
export interface SpaceRecoveryHandle {
  trash(): void;
  openTrash(): void;
}
interface Props {
  ref?: Ref<SpaceRecoveryHandle>;
  environmentId: EnvironmentId;
  pageId?: SpacePageId;
  spaceId?: SpaceId;
  parentPageId?: SpacePageId | null;
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
        {result.error instanceof Error ? result.error.message : "Trash is unavailable right now."}
      </p>
    );
  return <Recovery {...props} owner={result.owner} />;
}
const failed = (title: string) =>
  toastManager.add({ type: "error", title, description: "Try again in a moment." });

function Recovery({
  ref,
  environmentId,
  owner,
  pageId,
  spaceId,
  parentPageId,
  current,
}: Props & { owner: SpaceRootReorder }) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
  const pending = journal.pending;
  const blocked = !hydrated || busy || !!pending;
  const writable = supported && availability === "writable";

  const commit = async (
    pageId: SpacePageId,
    operation: "trash" | "restore" | "permanentlyDelete",
  ) => {
    const before = owner.getSnapshot().journal;
    try {
      await owner.previewRecovery(pageId, operation);
      const preview = owner.getSnapshot().recoveryPreview;
      if (preview?.pageId !== pageId || preview.operation !== operation) return false;
      if (operation === "trash" && current && !current()) return false;
      await owner.confirmRecovery(preview, operation === "permanentlyDelete");
      return true;
    } catch {
      const after = owner.getSnapshot().journal;
      return after !== before && after.pending === null;
    }
  };
  const viewing = (id: SpacePageId) => {
    const params = router.state.matches.at(-1)?.params ?? {};
    return "pageId" in params && params.pageId === id;
  };
  const show = (target: { spaceId: SpaceId; pageId: SpacePageId | null }) =>
    void router.navigate(
      target.pageId
        ? {
            to: "/spaces/$environmentId/$spaceId/$pageId",
            params: { environmentId, spaceId: target.spaceId, pageId: target.pageId },
            search: {},
          }
        : {
            to: "/spaces/$environmentId/$spaceId",
            params: { environmentId, spaceId: target.spaceId },
          },
    );
  const trashPage = async (id: SpacePageId, inSpace: SpaceId, parent: SpacePageId | null) => {
    if (current && !current()) return;
    if (!(await commit(id, "trash"))) return failed("Couldn't move to trash");
    if (viewing(id)) show({ spaceId: inSpace, pageId: parent });
    const toastId = toastManager.add({
      type: "success",
      title: "Moved to trash",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          void commit(id, "restore").then((done) => {
            if (done) show({ spaceId: inSpace, pageId: id });
            else failed("Couldn't restore the page");
          });
        },
      },
    });
  };
  const restore = async (entry: SpaceTrashEntry) => {
    if (!(await commit(entry.pageId, "restore"))) return failed("Couldn't restore the page");
    const toastId = toastManager.add({
      type: "success",
      title: "Page restored",
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(toastId);
          setOpen(false);
          show({ spaceId: entry.spaceId, pageId: entry.pageId });
        },
      },
    });
    run(owner.browseTrash());
  };
  const remove = async (entry: SpaceTrashEntry) => {
    const message = `Delete “${entry.title || "Untitled page"}” permanently?\nThis can't be undone.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    if (!(await commit(entry.pageId, "permanentlyDelete")))
      return failed("Couldn't delete the page");
    toastManager.add({ type: "success", title: "Page deleted permanently" });
    run(owner.browseTrash());
  };

  const openTrash = () => {
    setOpen(true);
    if (supported) run(owner.browseTrash());
  };
  useImperativeHandle(ref, () => ({
    openTrash,
    trash: () => {
      if (!trashPermission || !writable) return void failed("Couldn't move to trash");
      if (pageId && spaceId) void trashPage(pageId, spaceId, parentPageId ?? null);
    },
  }));
  return (
    <>
      {pageId ? null : (
        <Button variant="ghost" size="sm" onClick={openTrash}>
          <Trash2Icon />
          Trash
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Trash</DialogTitle>
            <DialogDescription>
              Pages you move to trash stay here until you delete them permanently.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              {!supported ? <p role="status">Trash isn't available on this server.</p> : null}
              {pending ? (
                <div className="space-y-2">
                  <p role="status">The last change didn't finish.</p>
                  <Button
                    variant="outline"
                    disabled={
                      busy || !hydrated || (pending.conflict && availability !== "writable")
                    }
                    onClick={() => run(pending.conflict ? owner.reinspect() : owner.recover())}
                  >
                    {pending.conflict ? "Dismiss" : "Finish now"}
                  </Button>
                </div>
              ) : null}
              {trash && trash.items.length === 0 ? <p>Trash is empty.</p> : null}
              <ul className="space-y-2">
                {trash?.items.map((entry) => (
                  <li key={entry.pageId} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate">{entry.title || "Untitled page"}</p>
                      <p className="text-sm text-muted-foreground">
                        Deleted <RelativeTime timestamp={entry.trash.trashedAt} />
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={blocked || !writable || !restorePermission}
                        onClick={() => void restore(entry)}
                      >
                        Restore
                      </Button>
                      <Button
                        variant="destructive-outline"
                        size="sm"
                        disabled={blocked || !writable || !purgePermission}
                        onClick={() => void remove(entry)}
                      >
                        Delete permanently
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {trash?.nextCursor ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={blocked}
                  onClick={() => run(owner.browseTrash(true))}
                >
                  Show more
                </Button>
              ) : null}
              {!hydrated && snapshot.error ? (
                <Button variant="outline" disabled={busy} onClick={() => run(owner.hydrate())}>
                  Try again
                </Button>
              ) : null}
              {snapshot.error ? <p role="alert">Something went wrong. Try again.</p> : null}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
