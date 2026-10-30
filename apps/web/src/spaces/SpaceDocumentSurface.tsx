import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SpaceBlockId, type SpaceBlock } from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import { useSpaceReferenceController } from "./useSpaceReferences";
import { SpaceSourceOpen } from "./SpaceSourceOpen";
import { Redo2Icon, Undo2Icon } from "lucide-react";
import { Button } from "../components/ui/button";
import { MenuItem } from "../components/ui/menu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { toastManager } from "../components/ui/toast";
import { createAutosave } from "./draftStore";
import { spacesEnvironment } from "../state/spaces";
import { randomUUID } from "../lib/utils";
import { SpaceMentionController } from "./mentions";
import { SpaceEditorBridge } from "./editorBridge";
import { spaceImages } from "./imageRuntime";
import { SpaceMediaBlock } from "./SpaceMediaBlock";
import { SpaceChildPageRow } from "./SpaceAtomView";
import { SpaceEditor } from "./SpaceEditor";
import { plain } from "./SpaceStructureControls";
import { placementAfterBlock } from "./pagePlacement";
import type { SpaceBlockMoveProof } from "@t2code/client-runtime/spaces";
import { useEnvironment } from "../state/environments";
import { spaceRootReorder, spaceDocuments } from "./sessionRuntime";
import type { SpaceDocumentController } from "./documentController";

const SpaceStructureControls = lazy(() => import("./SpaceStructureControls"));

export function SpaceDocumentSurface({
  target,
  current,
  onOpenSource,
}: {
  target: SpacePageNavigationTarget;
  current: () => boolean;
  onOpenSource: (target: SpacePageNavigationTarget) => void;
}) {
  const registry = useContext(RegistryContext);
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<{
    registry: typeof registry;
    stamp: string;
    result: { controller: SpaceDocumentController } | { error: unknown };
  } | null>(null);
  const { environmentId, pageId } = target;
  const stamp = JSON.stringify([environmentId, pageId, attempt]);
  // oxlint-disable-next-line t2code/react-effect-budget -- Acquire and release the external document session shared by route and panel mounts.
  useEffect(() => {
    const key = { environmentId, pageId };
    const documents = spaceDocuments(registry);
    let active = true;
    const document = documents.open(key);
    void document.ready.then(
      (controller) => {
        if (active) setOpened({ registry, stamp, result: { controller } });
      },
      (error: unknown) => {
        if (active) setOpened({ registry, stamp, result: { error } });
      },
    );
    return () => {
      active = false;
      document.release();
    };
  }, [environmentId, pageId, registry, stamp]);
  if (!opened || opened.registry !== registry || opened.stamp !== stamp)
    return <p role="status">Loading document…</p>;
  const result = opened.result;
  if ("error" in result)
    return (
      <div>
        <p role="alert" className="text-sm text-destructive-foreground">
          {message(result.error)}
        </p>
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          Retry opening document
        </Button>
      </div>
    );
  if (
    result.controller.session.key.environmentId !== environmentId ||
    result.controller.session.key.pageId !== pageId
  )
    return <p role="status">Loading document…</p>;
  return (
    <DocumentContent
      controller={result.controller}
      targetBlockId={target.blockId}
      current={current}
      onOpenSource={onOpenSource}
    />
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not load or save this document.";
}

async function createChildAfter(
  controller: SpaceDocumentController,
  owner: ReturnType<typeof spaceRootReorder>,
  blockId: SpaceBlockId | null,
): Promise<SpacePageNavigationTarget | null> {
  const { environmentId, pageId } = controller.session.key;
  await controller.save();
  await owner.loadBody(pageId);
  const body = owner.getSnapshot().body;
  if (!body) return null;
  const createdId = await owner.createChild("", placementAfterBlock(pageId, body.blocks, blockId));
  return createdId ? { environmentId, spaceId: body.spaceId, pageId: createdId } : null;
}

function DocumentContent({
  controller,
  targetBlockId,
  current,
  onOpenSource,
}: {
  controller: SpaceDocumentController;
  targetBlockId?: SpaceBlockId | undefined;
  current: () => boolean;
  onOpenSource: (target: SpacePageNavigationTarget) => void;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const sources = useSpaceReferenceController(controller.session.key.environmentId, sourceAttempt);
  const mentions = sources
    ? new SpaceMentionController(sources, controller.session.key.environmentId)
    : null;
  const registry = useContext(RegistryContext);
  const environment = useEnvironment(controller.session.key.environmentId);
  const capability = environment?.serverConfig?.environment.capabilities.spaces;
  const mediaSupported =
    capability?.version === 2 && capability.features?.assets === true && !!capability.limits.assets;
  const blockPermission = useAtomValue(
    spacesEnvironment.moveBlocks.permissionAtom(controller.session.key.environmentId),
  );
  const createPermission = useAtomValue(
    spacesEnvironment.createChild.permissionAtom(controller.session.key.environmentId),
  );
  const [blockMove, setBlockMove] = useState<SpaceBlockMoveProof | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [bridge] = useState(
    () =>
      new SpaceEditorBridge(
        controller,
        () => SpaceBlockId.make(randomUUID()),
        (description) =>
          toastManager.add({ type: "error", title: "Couldn't apply that change", description }),
      ),
  );
  const canReadSource = () => !!sources?.current() && current();
  const renderChild = (block: SpaceBlock, captionInEditor = false) => {
    if (!isKnownSpaceBlock(block)) return null;
    if (["image", "pdf", "video"].includes(block.type))
      return (
        <SpaceMediaBlock
          environmentId={controller.session.key.environmentId}
          block={block}
          showCaption={!captionInEditor}
          current={canReadSource}
        />
      );
    if (block.type !== "child_page") return null;
    return (
      <SpaceChildPageRow
        environmentId={controller.session.key.environmentId}
        pageId={block.content.pageId}
        current={() =>
          !!sources?.current() &&
          current() &&
          bridge.childPageTarget(block.id) === block.content.pageId
        }
        onOpen={onOpenSource}
      />
    );
  };
  const createPage = async (blockId: SpaceBlockId | null) => {
    try {
      const created = await createChildAfter(
        controller,
        spaceRootReorder(registry, controller.session.key.environmentId),
        blockId,
      );
      if (created && current()) onOpenSource(created);
    } catch (failure) {
      toastManager.add({
        type: "error",
        title: "Couldn't create the page",
        description: plain(failure, "Try again in a moment."),
      });
    }
  };
  const { session, loading, error } = snapshot;
  const permission = useAtomValue(
    spacesEnvironment.apply.permissionAtom(controller.session.key.environmentId),
  );
  const run = (operation: Promise<unknown>) => {
    void operation.catch(() => {});
  };
  const autosave = useRef<ReturnType<typeof createAutosave> | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // oxlint-disable-next-line t2code/react-effect-budget -- Debounced autosave subscribes to the external document session and flushes on leave.
  useEffect(() => {
    const failure = (error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Couldn't save",
        description: message(error),
        actionProps: { children: "Retry", onClick: () => autosave.current?.retry() },
      });
    };
    const saver = createAutosave({
      save: () =>
        controller.save().catch((error: unknown) => {
          failure(error);
          throw error;
        }),
    });
    autosave.current = saver;
    const sync = () => {
      const state = controller.session.getSnapshot();
      const ready =
        state.hydrated &&
        state.dirty &&
        !state.pending &&
        state.status === "draft" &&
        !state.recoveryReason &&
        state.persistenceError === null &&
        !controller.structureBlocked() &&
        !controller.getSnapshot().loading;
      saver.update(ready ? state.generation : null);
    };
    const leave = () => {
      if (document.visibilityState === "hidden") saver.flush();
    };
    const unsubscribe = controller.subscribe(sync);
    document.addEventListener("visibilitychange", leave);
    window.addEventListener("pagehide", saver.flush);
    sync();
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", leave);
      window.removeEventListener("pagehide", saver.flush);
      saver.dispose();
      autosave.current = null;
    };
  }, [controller]);
  const needsAttention =
    session.hydrated &&
    (session.status === "conflict" ||
      session.status === "uncertain" ||
      !!session.persistenceError ||
      !!error ||
      (!!session.pending && session.status === "draft"));
  const canDiscard = session.dirty && !session.pending;
  const moreWindows =
    !session.hydrated ||
    !controller.editorWindow().completeParents.includes(null) ||
    !!snapshot.nextCursor;
  const showFooter = moreWindows || needsAttention || !!snapshot.imageAdmissionError;
  return (
    <div className="space-y-3" onBlur={() => autosave.current?.flush()}>
      {!sources?.current() ? (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSourceAttempt((value) => value + 1)}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
      {!session.hydrated ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading document…
        </p>
      ) : null}
      {controller.structureBlocked() ? (
        <p role="status" className="text-sm text-muted-foreground">
          This page is being updated. Editing resumes shortly.
        </p>
      ) : null}
      {session.hydrated ? (
        <SpaceEditor
          savedHistory={(["undo", "redo"] as const).map((direction) => (
            <MenuItem
              key={direction}
              disabled={
                !permission ||
                controller.structureBlocked() ||
                loading ||
                !!error ||
                (!mediaSupported && bridge.compensationUsesMedia(direction)) ||
                controller.session.compensationAvailability(direction) !== null
              }
              title={
                !mediaSupported && bridge.compensationUsesMedia(direction)
                  ? "This saved change requires asset support"
                  : (controller.session.compensationAvailability(direction) ?? undefined)
              }
              onClick={() => run(bridge.compensate(direction))}
            >
              {direction === "undo" ? <Undo2Icon /> : <Redo2Icon />}
              {direction === "undo" ? "Undo saved change" : "Redo saved change"}
            </MenuItem>
          ))}
          mentions={mentions}
          onOpenSource={onOpenSource}
          mediaEditable={mediaSupported}
          adapter={bridge.adapter}
          bridge={bridge}
          targetBlockId={targetBlockId}
          sourceOwner={sources}
          images={spaceImages(registry)}
          current={canReadSource}
          renderChild={renderChild}
          onCreatePage={
            capability?.version === 2 && createPermission
              ? (blockId) => void createPage(blockId)
              : undefined
          }
          onMoveBlocks={
            capability?.version === 2 && capability.features?.blockMoves === true && blockPermission
              ? async (state) => {
                  try {
                    setMoveError(null);
                    const selected = bridge.blockMoveSelection(state);
                    const proof = await spaceRootReorder(
                      registry,
                      controller.session.key.environmentId,
                    ).selectBlocks(
                      controller.session.key.pageId,
                      selected.revision,
                      selected.blockIds,
                    );
                    setBlockMove(proof);
                  } catch (error) {
                    setMoveError(error);
                  }
                }
              : undefined
          }
          editable={
            permission &&
            !controller.structureBlocked() &&
            !loading &&
            session.persistenceError === null &&
            session.status !== "conflict" &&
            session.status !== "uncertain"
          }
        />
      ) : null}
      {targetBlockId ? (
        <SpaceSourceOpen
          owner={sources}
          target={{ kind: "block", blockId: targetBlockId }}
          current={() => !!sources?.current() && current()}
          onOpen={onOpenSource}
          label="current linked source"
        />
      ) : null}
      {moveError ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {message(moveError)}
        </p>
      ) : null}
      {blockMove && snapshot.metadata ? (
        <Suspense fallback={null}>
          <SpaceStructureControls
            target={{ ...controller.session.key, spaceId: snapshot.metadata.page.spaceId }}
            location={snapshot.metadata.page.location}
            current={() =>
              controller.getSnapshot().error === null && controller.session.getSnapshot().hydrated
            }
            blocks={blockMove}
            onClose={() => setBlockMove(null)}
          />
        </Suspense>
      ) : null}
      {showFooter ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
          {needsAttention || snapshot.imageAdmissionError ? (
            <>
              <span role="alert" className="text-destructive-foreground">
                Couldn't save
                {session.status === "conflict"
                  ? " · This page changed somewhere else. Your edits are kept on this device."
                  : error
                    ? ` · ${message(error)}`
                    : snapshot.imageAdmissionError
                      ? ` · ${message(snapshot.imageAdmissionError)}`
                      : session.persistenceError
                        ? " · Couldn't keep a copy on this device."
                        : ""}
              </span>
              {session.status !== "conflict" ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={
                    session.status === "saving" ||
                    controller.structureBlocked() ||
                    !session.hydrated ||
                    !!session.recoveryReason
                  }
                  onClick={() =>
                    session.persistenceError
                      ? run(controller.session.persistDraft())
                      : autosave.current?.retry()
                  }
                >
                  Retry
                </Button>
              ) : null}
              {canDiscard ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={controller.structureBlocked() || loading || session.status === "saving"}
                  onClick={() => setConfirmDiscard(true)}
                >
                  Discard changes
                </Button>
              ) : null}
            </>
          ) : null}
          {moreWindows ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={
                loading ||
                (session.hydrated && (session.dirty || !!session.pending || !snapshot.nextCursor))
              }
              onClick={() =>
                run(
                  !session.hydrated
                    ? controller.open()
                    : snapshot.nextCursor
                      ? controller.next()
                      : controller.refresh(),
                )
              }
            >
              {session.hydrated ? "Load more" : "Retry"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits on this device will be lost and the page will show its last saved version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep editing</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => run(controller.discard())}
            >
              Discard changes
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
