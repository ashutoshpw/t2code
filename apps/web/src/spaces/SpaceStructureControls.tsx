import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import {
  isSpaceListItem,
  type SpaceBlockMoveProof,
  type SpaceRootReorder,
  type SpacePageNavigationTarget,
} from "@t2code/client-runtime/spaces";
import type {
  SpaceBlockPlacement,
  SpaceBlockId,
  SpacePageLocation,
  SpacePageDestination,
} from "@t2code/contracts/spaces";
import SpaceRecoveryControls from "./SpaceRecoveryControls";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { useEnvironment } from "../state/environments";
import { spaceRootReorder } from "./sessionRuntime";

interface Props {
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
        {result.error instanceof Error ? result.error.message : "Placement journal is unavailable."}
      </p>
    );
  return <StructureControls {...props} owner={result.owner} />;
}
function StructureControls({
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
  const [container, setContainer] = useState<SpaceBlockId | null>(null);
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
  const { journal, window, position, busy, hydrated, spaces, body, parentPageId } = snapshot;
  const pending = journal.pending;
  const pendingRequest = pending?.request;
  const pendingDestination =
    pendingRequest?.operation === "movePage"
      ? pendingRequest.input.destination
      : pendingRequest?.operation === "moveBlocks"
        ? { kind: "child" as const, placement: pendingRequest.input.destination }
        : pendingRequest?.operation === "createChildPage"
          ? { kind: "child" as const, placement: pendingRequest.input.placement }
          : null;
  const pendingPageId =
    pendingRequest?.operation === "movePage"
      ? pendingRequest.input.pageId
      : pendingRequest?.operation === "moveBlocks"
        ? pendingRequest.input.sourcePageId
        : target.pageId;
  const name = (pageId: typeof target.pageId) =>
    window?.items.find((page) => page.id === pageId)?.title || pageId;
  const retained = journal.history;
  const history =
    retained &&
    (retained.pageId === target.pageId ||
      (retained.operation === "moveBlocks" &&
        retained.destination.kind === "child" &&
        retained.destination.placement.pageId === target.pageId))
      ? retained
      : null;
  const selectionReady = blocks
    ? snapshot.blockSelection === blocks
    : creating || position?.pageId === target.pageId;
  const blocked = !hydrated || busy || !!pending;
  const load = (next = false) => {
    if (current() && window) run(owner.browse(window.space.id, target.pageId, next, parentPageId));
  };
  const place = (destination: SpacePageDestination) => {
    if (!current()) return;
    if (creating && destination.kind === "child")
      run(owner.createChild(title, destination.placement));
    else if (blocks) {
      if (destination.kind === "child")
        run(owner.moveSelectedBlocks(blocks, destination.placement));
    } else run(owner.moveTo(target.pageId, destination));
  };
  const loadSource = () => {
    if (!current()) return;
    run(
      location?.kind === "child"
        ? owner.loadSource(target.pageId)
        : owner.browse(target.spaceId, target.pageId),
    );
  };
  const placementDirect = (destination: SpaceBlockPlacement) => {
    if (blocks && current())
      run(
        (async () => {
          await owner.loadBody(blocks.sourcePageId);
          if (current()) await owner.moveSelectedBlocks(blocks, destination);
        })(),
      );
  };
  const placement = (beforeBlockId: SpaceBlockId | null) => {
    if (body)
      place({
        kind: "child",
        placement: { pageId: body.pageId, parentId: container, beforeBlockId },
      });
  };
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {!blocks ? (
          <>
            <Button
              variant="outline"
              disabled={!writable || blocked}
              onClick={() => {
                setCreating(false);
                setOpen(true);
              }}
            >
              Move page
            </Button>
            <Button
              variant="outline"
              disabled={!writable || blocked || !createPermission}
              onClick={() => {
                if (!current()) return;
                setCreating(true);
                setContainer(null);
                setOpen(true);
                run(owner.loadBody(target.pageId));
              }}
            >
              Create child page
            </Button>
            <SpaceRecoveryControls
              environmentId={target.environmentId}
              pageId={target.pageId}
              current={current}
            />
          </>
        ) : null}
        {history ? (
          <Button
            variant="outline"
            disabled={
              !writable || blocked || (history.operation === "moveBlocks" && !blockAvailable)
            }
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
            Recover structural receipt
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
          Structural operation is retained.{" "}
          {pending.conflict
            ? "It conflicted; reinspection starts a new intent."
            : "Resolve its receipt before editing affected pages."}
        </p>
      ) : null}
      {pending && pendingDestination ? (
        <p>
          Attempted {pending.request.operation}:{" "}
          {pending.request.operation === "createChildPage"
            ? `new child “${pending.request.input.title}”`
            : name(pendingPageId!)}{" "}
          {pendingDestination.kind === "root"
            ? `to space ${pendingDestination.spaceId}, ${pendingDestination.beforePageId ? `before ${name(pendingDestination.beforePageId)}` : "at the end"}`
            : `inside page ${pendingDestination.placement.pageId}, ${pendingDestination.placement.beforeBlockId ? `before block ${pendingDestination.placement.beforeBlockId}` : "at the list end"}`}
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
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) onClose?.();
        }}
      >
        <DialogPopup>
          <DialogTitle>
            {creating ? "Create child page" : blocks ? "Move selected block subtrees" : "Move page"}
          </DialogTitle>
          <DialogDescription>
            {creating
              ? "Choose an explicit position in a complete page body or known list. The server allocates the child page and owner marker IDs. Creation Undo is unavailable; use inspected trash and restore."
              : blocks
                ? "Move complete selected subtrees through the guarded service. IDs and opaque/media payloads are preserved. One inverse is retained only for a proven original contiguous placement. Save or resolve affected drafts first."
                : "Save or resolve affected drafts first. Page IDs stay stable. Moving a child to root retires its owner marker; nesting creates a fresh marker when needed. Undo restores placement, not retired marker links. One guarded undo/redo is retained."}
          </DialogDescription>
          <div className="mt-4 space-y-3">
            {snapshot.error ? (
              <p role="alert">
                {snapshot.error instanceof Error
                  ? snapshot.error.message
                  : "The operation failed; retained data has been kept."}
              </p>
            ) : null}
            {snapshot.notice ? <p role="status">{snapshot.notice}</p> : null}
            {pending ? (
              <p role="status">
                The exact {pending.request.operation} intent is retained. Close this chooser to
                recover its receipt or inspect a definite conflict.
              </p>
            ) : null}
            {creating ? (
              <label>
                Child page title
                <Input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
            ) : null}
            {!blocks && !creating ? (
              <Button variant="outline" disabled={blocked || !writable} onClick={loadSource}>
                Load original position
              </Button>
            ) : blocks ? (
              <>
                <p>
                  {selectionReady
                    ? `${blocks.blockIds.length} roots with complete subtrees are selected.${blocks.inverse ? " Guarded placement undo is available if its guards remain provable." : " Undo is unavailable for multiple original placements."}`
                    : "This selection changed. Close and select again."}
                </p>
                <Button
                  variant="outline"
                  disabled={blocked || !writable || !selectionReady || !blocks.indent}
                  onClick={() => {
                    if (blocks.indent) placementDirect(blocks.indent);
                  }}
                >
                  Indent selection
                </Button>
                <Button
                  variant="outline"
                  disabled={blocked || !writable || !selectionReady || !blocks.outdent}
                  onClick={() => {
                    if (blocks.outdent) placementDirect(blocks.outdent);
                  }}
                >
                  Outdent selection
                </Button>
              </>
            ) : null}
            {!blocks && !creating ? (
              <p role="status">
                {position?.pageId === target.pageId
                  ? "Original placement and successor are known."
                  : "Find the source using First / Next roots, or load its complete parent body. Partial windows do not prove list completeness."}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={blocked}
                onClick={() => run(owner.browseSpaces())}
              >
                First spaces
              </Button>
              <Button
                variant="outline"
                disabled={blocked || !spaces?.nextCursor}
                onClick={() => run(owner.browseSpaces(true))}
              >
                Next spaces
              </Button>
            </div>
            {spaces ? (
              <ul className="space-y-2">
                {spaces.items.map((space) => (
                  <li key={space.id}>
                    <Button
                      variant="outline"
                      disabled={blocked}
                      onClick={() => {
                        if (current()) run(owner.browse(space.id, target.pageId));
                      }}
                    >
                      Roots in {space.title || "Untitled space"}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {window ? (
              <>
                <p>
                  {parentPageId ? `Child pages of ${parentPageId}` : "Root pages"} ·{" "}
                  {window.space.title}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={blocked} onClick={() => load()}>
                    First pages
                  </Button>
                  <Button
                    variant="outline"
                    disabled={blocked || !window.nextCursor}
                    onClick={() => load(true)}
                  >
                    Next pages
                  </Button>
                  <Button
                    variant="outline"
                    disabled={blocked}
                    onClick={() => run(owner.browse(window.space.id, target.pageId))}
                  >
                    Root pages
                  </Button>
                </div>
                {window.items.length === 0 ? (
                  <p>{window.nextCursor ? "No pages in this window." : "No pages."}</p>
                ) : null}
                <ul className="space-y-2">
                  {window.items.map((page) => (
                    <li key={page.id}>
                      <p>{page.title || "Untitled page"}</p>
                      <div className="flex flex-wrap gap-2">
                        {!blocks && !creating && parentPageId === null ? (
                          <Button
                            variant="outline"
                            disabled={
                              !writable || blocked || !selectionReady || page.id === target.pageId
                            }
                            onClick={() =>
                              place({
                                kind: "root",
                                spaceId: window.space.id,
                                beforePageId: page.id,
                              })
                            }
                          >
                            Place before
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          disabled={blocked}
                          onClick={() =>
                            run(owner.browse(window.space.id, target.pageId, false, page.id))
                          }
                        >
                          Child pages
                        </Button>
                        <Button
                          variant="outline"
                          disabled={blocked || (!blocks && !creating && page.id === target.pageId)}
                          onClick={() => {
                            setContainer(null);
                            if (current()) run(owner.loadBody(page.id));
                          }}
                        >
                          Choose placement inside
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
                {!blocks && !creating && parentPageId === null && window.nextCursor === null ? (
                  <Button
                    variant="outline"
                    disabled={!writable || blocked || !selectionReady}
                    onClick={() =>
                      place({ kind: "root", spaceId: window.space.id, beforePageId: null })
                    }
                  >
                    Place at root end
                  </Button>
                ) : null}
              </>
            ) : null}
            {body ? (
              <>
                <p>Destination page: {body.pageId}</p>
                {body.nextCursor !== null ? (
                  <p role="status">
                    This body is partial. List placement is unavailable in this bounded slice.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => setContainer(null)}>
                        Page body root
                      </Button>
                      {body.blocks.filter(isSpaceListItem).map((block) => (
                        <Button
                          key={block.id}
                          variant="outline"
                          onClick={() => setContainer(block.id)}
                        >
                          List {block.id}
                        </Button>
                      ))}
                    </div>
                    <p>{container ? `Inside list ${container}` : "At page body root"}</p>
                    <ul className="space-y-2">
                      {body.blocks
                        .filter((block) => block.parentId === container)
                        .map((block) => (
                          <li key={block.id}>
                            <Button
                              variant="outline"
                              disabled={!writable || blocked || !selectionReady}
                              onClick={() => placement(block.id)}
                            >
                              {creating ? "Create before" : "Place before"} {block.type} ({block.id}
                              )
                            </Button>
                          </li>
                        ))}
                    </ul>
                    <Button
                      variant="outline"
                      disabled={!writable || blocked || !selectionReady}
                      onClick={() => placement(null)}
                    >
                      {creating ? "Create at list end" : "Place at list end"}
                    </Button>
                  </>
                )}
              </>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
