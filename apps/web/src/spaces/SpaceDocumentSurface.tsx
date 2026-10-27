import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { lazy, Suspense, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { SpaceBlockId, type SpaceBlock } from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import { useSpaceReferenceController } from "./useSpaceReferences";
import { SpaceSourceOpen } from "./SpaceSourceOpen";
import { Button } from "../components/ui/button";
import { spacesEnvironment } from "../state/spaces";
import { randomUUID } from "../lib/utils";
import { SpaceEditorBridge } from "./editorBridge";
import { SpaceEditor } from "./SpaceEditor";
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
        <p role="alert">{message(result.error)}</p>
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
  const registry = useContext(RegistryContext);
  const environment = useEnvironment(controller.session.key.environmentId);
  const capability = environment?.serverConfig?.environment.capabilities.spaces;
  const blockPermission = useAtomValue(
    spacesEnvironment.moveBlocks.permissionAtom(controller.session.key.environmentId),
  );
  const [blockMove, setBlockMove] = useState<SpaceBlockMoveProof | null>(null);
  const [moveError, setMoveError] = useState<unknown>(null);
  const [bridge] = useState(
    () => new SpaceEditorBridge(controller, () => SpaceBlockId.make(randomUUID())),
  );
  const canReadSource = () => !!sources?.current() && current();
  const renderChild = (block: SpaceBlock) => {
    if (!isKnownSpaceBlock(block) || block.type !== "child_page") return null;
    return (
      <SpaceSourceOpen
        owner={sources}
        target={{ kind: "page", pageId: block.content.pageId }}
        current={() =>
          !!sources?.current() &&
          current() &&
          bridge.childPageTarget(block.id) === block.content.pageId
        }
        onOpen={onOpenSource}
        label="child page"
      />
    );
  };
  const { session, loading, error } = snapshot;
  const permission = useAtomValue(
    spacesEnvironment.apply.permissionAtom(controller.session.key.environmentId),
  );
  const clean =
    session.hydrated &&
    !controller.structureBlocked() &&
    !session.dirty &&
    !session.pending &&
    session.persistenceError === null &&
    session.status !== "saving";
  const run = (operation: Promise<unknown>) => {
    void operation.catch(() => {});
  };
  return (
    <div className="mt-4 space-y-3">
      {!sources?.current() ? (
        <Button variant="outline" onClick={() => setSourceAttempt((value) => value + 1)}>
          Retry source connection
        </Button>
      ) : null}
      <p role="status">
        {!session.hydrated
          ? "Loading document…"
          : session.status === "saved"
            ? "Saved"
            : session.status === "uncertain"
              ? "Save outcome unresolved"
              : session.status === "conflict"
                ? "The server has a newer revision. Your local draft is retained."
                : session.status === "saving"
                  ? "Saving draft…"
                  : "Local draft"}
      </p>
      {controller.structureBlocked() ? (
        <p role="status">
          Page placement is pending. Editing is paused until its receipt is resolved.
        </p>
      ) : null}
      {session.recoveryReason ? (
        <p role="alert">
          This older pending draft has no receipt epoch. It is retained and cannot be retried
          automatically.
        </p>
      ) : null}
      {error ? <p role="alert">{message(error)}</p> : null}
      {session.persistenceError ? (
        <p role="alert">Draft storage failed: {message(session.persistenceError)}</p>
      ) : null}
      <p>
        Saved undo/redo covers only the last content or formatting save. Use page placement controls
        for root ordering; saved block structure undo is not supported.
      </p>
      {session.history.reason ? <p role="status">{session.history.reason}</p> : null}
      {session.history.action ? (
        <p role="status">
          Saved {session.history.action} draft. A conflict keeps this attempted change; retry save
          or discard it explicitly.
        </p>
      ) : null}
      {session.hydrated ? (
        <SpaceEditor
          adapter={bridge.adapter}
          bridge={bridge}
          targetBlockId={targetBlockId}
          revealOwner={sources}
          current={canReadSource}
          renderChild={renderChild}
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
            !error &&
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
      {capability?.version === 2 && capability.features?.blockMoves !== true ? (
        <p>Block moves are unavailable until this environment advertises support.</p>
      ) : null}
      {moveError ? <p role="alert">{message(moveError)}</p> : null}
      {blockMove && snapshot.metadata ? (
        <Suspense fallback={<p role="status">Loading move placement…</p>}>
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
      <div className="flex flex-wrap gap-2">
        {(["undo", "redo"] as const).map((direction) => (
          <Button
            key={direction}
            variant="outline"
            disabled={
              !permission ||
              controller.structureBlocked() ||
              loading ||
              !!error ||
              controller.session.compensationAvailability(direction) !== null
            }
            title={
              controller.session.compensationAvailability(direction) ??
              "Submit a new revision-checked saved change"
            }
            onClick={() => run(bridge.compensate(direction))}
          >
            {direction === "undo" ? "Undo saved change" : "Redo saved change"}
          </Button>
        ))}
        <Button
          variant="outline"
          disabled={loading || (!clean && session.hydrated)}
          onClick={() => run(session.hydrated ? controller.refresh() : controller.open())}
        >
          Reload first window
        </Button>
        <Button
          variant="outline"
          disabled={!clean || loading || !snapshot.nextCursor}
          onClick={() => run(controller.next())}
        >
          Next window
        </Button>
        {session.dirty || session.pending ? (
          <Button
            variant="outline"
            disabled={
              !session.hydrated ||
              controller.structureBlocked() ||
              loading ||
              session.status === "saving" ||
              !!session.recoveryReason ||
              (!session.pending || session.status === "draft" ? !permission : false) ||
              session.status === "conflict"
            }
            onClick={() => run(controller.save())}
          >
            {session.pending
              ? session.status === "draft"
                ? "Retry unsent save"
                : "Check save receipt"
              : "Save draft"}
          </Button>
        ) : null}
        {session.dirty && !session.pending ? (
          <Button
            variant="outline"
            disabled={controller.structureBlocked() || loading || session.status === "saving"}
            onClick={() => run(controller.discard())}
          >
            Discard local draft
          </Button>
        ) : null}
        {session.persistenceError && session.hydrated ? (
          <Button variant="outline" onClick={() => run(controller.session.persistDraft())}>
            Retry draft storage
          </Button>
        ) : null}
      </div>
    </div>
  );
}
