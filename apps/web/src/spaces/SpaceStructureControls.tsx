import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  useContext,
  useEffect,
  useImperativeHandle,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";
import {
  type SpaceBlockMoveProof,
  type SpaceRootReorder,
  type SpacePageNavigationTarget,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceBlockPlacement,
  SpacePageId,
  SpacePageLocation,
  SpaceId,
} from "@t2code/contracts/spaces";
import { Input } from "../components/ui/input";
import { ChevronRightIcon } from "lucide-react";
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
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { useEnvironment } from "../state/environments";
import { spaceRootReorder } from "./sessionRuntime";

export interface SpaceStructureHandle {
  openMove(): void;
  openChild(): void;
}
interface Props {
  ref?: Ref<SpaceStructureHandle>;
  blocks?: SpaceBlockMoveProof;
  onClose?: () => void;
  target: SpacePageNavigationTarget;
  current: () => boolean;
  location: SpacePageLocation | undefined;
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
        {result.error instanceof Error
          ? result.error.message
          : "Moving pages is unavailable right now."}
      </p>
    );
  return <StructureControls {...props} owner={result.owner} />;
}
export const plain = (error: unknown, fallback: string) =>
  error instanceof Error && /draft|resolve|saving|finish loading|unsaved/i.test(error.message)
    ? "Save your changes first, then try again."
    : fallback;

function StructureControls({
  ref,
  target,
  current,
  location,
  owner,
  blocks,
  onClose,
}: Props & { owner: SpaceRootReorder }) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [open, setOpen] = useState(!!blocks);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const availability = useSpacesAvailability(target.environmentId);
  const permission = useAtomValue(spacesEnvironment.movePage.permissionAtom(target.environmentId));
  const createPermission = useAtomValue(
    spacesEnvironment.createChild.permissionAtom(target.environmentId),
  );
  const blockPermission = useAtomValue(
    spacesEnvironment.moveBlocks.permissionAtom(target.environmentId),
  );
  const capability = useEnvironment(target.environmentId)?.serverConfig?.environment.capabilities
    .spaces;
  const blockAvailable =
    capability?.version === 2 && capability.features?.blockMoves === true && blockPermission;
  const writable =
    (!blocks || blockAvailable) &&
    (!creating || createPermission) &&
    permission &&
    availability === "writable" &&
    current();
  // oxlint-disable-next-line t2code/react-effect-budget -- Load the shared durable structural journal independently of this metadata view.
  useEffect(() => {
    run(owner.hydrate());
  }, [owner]);
  const { journal, window, position, busy, hydrated, spaces, parentPageId } = snapshot;
  const pending = journal.pending;
  const selectionReady = blocks
    ? snapshot.blockSelection === blocks
    : creating || position?.pageId === target.pageId;
  const blocked = !hydrated || busy || !!pending;
  const query = search.trim().toLowerCase();
  const matches = (name: string) => !query || name.toLowerCase().includes(query);

  const settled = async (action: () => Promise<unknown>) => {
    const before = owner.getSnapshot().journal;
    try {
      await action();
      return true;
    } catch {
      const after = owner.getSnapshot().journal;
      return after !== before && after.pending === null;
    }
  };
  const browseRoots = async (spaceId: SpaceId, parent: SpacePageId | null = null) => {
    await owner.browse(spaceId, target.pageId, false, parent);
    if (parent !== null || blocks) return;
    for (let i = 0; i < 20 && owner.getSnapshot().window?.nextCursor; i++)
      await owner.browse(spaceId, target.pageId, true);
  };
  const loadPicker = async () => {
    await owner.browseSpaces();
    if (!blocks && location?.kind === "child") await owner.loadSource(target.pageId);
    await browseRoots(target.spaceId);
  };
  const openChild = () => {
    if (!current()) return;
    setCreating(true);
    setOpen(true);
  };
  const openMove = () => {
    if (!current()) return;
    setCreating(false);
    setSearch("");
    setOpen(true);
    run(
      loadPicker().catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Couldn't load pages",
          description: plain(error, "Try again in a moment."),
        });
      }),
    );
  };
  useImperativeHandle(ref, () => ({ openMove, openChild }));
  const showMoved = () => {
    setOpen(false);
    onClose?.();
    const retained = owner.getSnapshot().journal.history;
    const undoable =
      retained &&
      "destination" in retained &&
      retained.direction === "undo" &&
      (blocks || retained.pageId === target.pageId);
    const id = toastManager.add({
      type: "success",
      title: blocks ? "Blocks moved" : "Page moved",
      ...(undoable
        ? {
            actionProps: {
              children: "Undo",
              onClick: () => {
                toastManager.close(id);
                void settled(() => owner.compensate("undo")).then((done) => {
                  if (!done) toastManager.add({ type: "error", title: "Couldn't undo the move" });
                });
              },
            },
          }
        : {}),
    });
  };
  const moveFailed = (error?: unknown) =>
    toastManager.add({
      type: "error",
      title: blocks ? "Couldn't move the blocks" : "Couldn't move the page",
      description: plain(error, "Try again in a moment."),
    });
  const moveInside = async (pageId: SpacePageId) => {
    if (!current()) return;
    let failure: unknown;
    const done = await settled(async () => {
      await owner.loadBody(pageId);
      const placement: SpaceBlockPlacement = { pageId, parentId: null, beforeBlockId: null };
      try {
        if (blocks) await owner.moveSelectedBlocks(blocks, placement);
        else await owner.moveTo(target.pageId, { kind: "child", placement });
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    if (done) showMoved();
    else moveFailed(failure);
  };
  const moveToTop = async (spaceId: SpaceId) => {
    if (!current()) return;
    let failure: unknown;
    const done = await settled(async () => {
      try {
        await owner.moveTo(target.pageId, { kind: "root", spaceId, beforePageId: null });
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    if (done) showMoved();
    else moveFailed(failure);
  };
  const enterSpace = (spaceId: SpaceId) => {
    setSearch("");
    run(browseRoots(spaceId));
  };
  const enterPage = (pageId: SpacePageId) => {
    if (!window) return;
    setSearch("");
    run(browseRoots(window.space.id, pageId));
  };
  const createChild = async () => {
    if (!current()) return;
    let failure: unknown;
    const done = await settled(async () => {
      try {
        await owner.loadBody(target.pageId);
        await owner.createChild(title, {
          pageId: target.pageId,
          parentId: null,
          beforeBlockId: null,
        });
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    if (done) {
      setOpen(false);
      setTitle("");
    } else
      toastManager.add({
        type: "error",
        title: "Couldn't create the page",
        description: plain(failure, "Try again in a moment."),
      });
  };
  const placementDirect = (destination: SpaceBlockPlacement) => {
    if (blocks && current())
      run(
        settled(async () => {
          await owner.loadBody(blocks.sourcePageId);
          if (current()) await owner.moveSelectedBlocks(blocks, destination);
        }).then((done) => (done ? showMoved() : moveFailed())),
      );
  };
  const atTop = window !== null && parentPageId === null;
  const visiblePages = window?.items.filter((page) => matches(page.title || "Untitled page")) ?? [];
  const otherSpaces =
    spaces?.items.filter((space) => space.id !== window?.space.id && matches(space.title)) ?? [];
  return (
    <>
      {pending || (!hydrated && snapshot.error) ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {pending ? (
            <>
              <span role="status">
                {pending.conflict
                  ? "Your last page change couldn't be completed."
                  : "Your last page change didn't finish."}
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={busy || !hydrated || (pending.conflict && !writable)}
                onClick={() => run(pending.conflict ? owner.reinspect() : owner.recover())}
              >
                {pending.conflict ? "Dismiss" : "Finish it"}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="xs" onClick={() => run(owner.hydrate())}>
              Try again
            </Button>
          )}
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) onClose?.();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {creating ? "Add sub-page" : blocks ? "Move blocks to…" : "Move to…"}
            </DialogTitle>
            <DialogDescription>
              {creating
                ? "The new page is added inside this page."
                : blocks
                  ? "Choose a page to move the selected blocks to. They are added at the end of it."
                  : "Choose a page or space to move this page into."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              {creating ? (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(createChild());
                  }}
                >
                  <label className="block space-y-1">
                    <span className="text-sm">Title</span>
                    <Input
                      value={title}
                      placeholder="Untitled page"
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <Button type="submit" disabled={!writable || blocked}>
                    Add page
                  </Button>
                </form>
              ) : (
                <>
                  {blocks ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={blocked || !writable || !selectionReady || !blocks.indent}
                        onClick={() => {
                          if (blocks.indent) placementDirect(blocks.indent);
                        }}
                      >
                        Indent
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={blocked || !writable || !selectionReady || !blocks.outdent}
                        onClick={() => {
                          if (blocks.outdent) placementDirect(blocks.outdent);
                        }}
                      >
                        Outdent
                      </Button>
                    </div>
                  ) : null}
                  {!selectionReady && blocks ? (
                    <p role="status">The selection changed. Close this and select again.</p>
                  ) : null}
                  <Input
                    type="search"
                    aria-label="Search pages"
                    placeholder="Search pages…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {!window ? <p role="status">Loading…</p> : null}
                  {window ? (
                    <ul className="max-h-72 space-y-1 overflow-y-auto">
                      {parentPageId ? (
                        <li>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start"
                            disabled={blocked}
                            onClick={() => enterSpace(window.space.id)}
                          >
                            Back to {window.space.title || "Untitled space"}
                          </Button>
                        </li>
                      ) : null}
                      {atTop && !blocks && matches(window.space.title || "Untitled space") ? (
                        <li>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start"
                            disabled={
                              !writable || blocked || !selectionReady || window.nextCursor !== null
                            }
                            onClick={() => run(moveToTop(window.space.id))}
                          >
                            {window.space.title || "Untitled space"} (top level)
                          </Button>
                        </li>
                      ) : null}
                      {visiblePages.map((page) => (
                        <li key={page.id} className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-w-0 flex-1 justify-start"
                            disabled={
                              !writable ||
                              blocked ||
                              !selectionReady ||
                              (!blocks && page.id === target.pageId)
                            }
                            onClick={() => run(moveInside(page.id))}
                          >
                            <span className="truncate">{page.title || "Untitled page"}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Show pages inside ${page.title || "Untitled page"}`}
                            disabled={blocked || (!blocks && page.id === target.pageId)}
                            onClick={() => enterPage(page.id)}
                          >
                            <ChevronRightIcon />
                          </Button>
                        </li>
                      ))}
                      {!parentPageId
                        ? otherSpaces.map((space) => (
                            <li key={space.id}>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start"
                                disabled={blocked}
                                onClick={() => enterSpace(space.id)}
                              >
                                {space.title || "Untitled space"}
                              </Button>
                            </li>
                          ))
                        : null}
                      {visiblePages.length === 0 && otherSpaces.length === 0 ? (
                        <li className="px-2 text-sm text-muted-foreground">No pages found.</li>
                      ) : null}
                    </ul>
                  ) : null}
                  {window?.nextCursor ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={blocked}
                      onClick={() =>
                        run(owner.browse(window.space.id, target.pageId, true, parentPageId))
                      }
                    >
                      Show more
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
