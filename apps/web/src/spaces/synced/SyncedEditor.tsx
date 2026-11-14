import { RegistryContext } from "@effect/atom-react";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, type SpaceBlock, type SpacePageId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { spacesEnvironment } from "~/state/spaces";
import { createAutosave } from "../draftStore";
import { SpaceEditorBridge } from "../editorBridge";
import { SpaceEditor } from "../SpaceEditor";
import { useSpaceComments } from "../comments/useSpaceComments";
import { SpaceDocumentSkeleton } from "../SpaceSkeletons";
import type { SpaceDocumentController } from "../documentController";
import { SyncedHostContext, SyncedPortsContext, SyncedStaticContext } from "./SyncedContext";
import { defaultSyncedPorts } from "./syncedPorts";

export type SyncedStatus = "saved" | "saving" | "unsaved" | "conflict" | "error";

export interface SyncedEditorState {
  readonly status: SyncedStatus;
  readonly discard: () => void;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Could not load or save this block.";

function EditorBody({
  controller,
  sourceBlockId,
  environmentId,
  renderChild,
  renderHeader,
}: {
  readonly controller: SpaceDocumentController;
  readonly sourceBlockId: SpaceBlockId;
  readonly environmentId: EnvironmentId;
  readonly renderChild: ((block: SpaceBlock) => ReactNode) | undefined;
  readonly renderHeader: (state: SyncedEditorState) => ReactNode;
}) {
  const registry = useContext(RegistryContext);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const ports = useContext(SyncedPortsContext) ?? defaultSyncedPorts;
  const permission = ports.useWritable(environmentId);
  const comments = useSpaceComments(environmentId, controller.session.key.pageId);
  const flush = useRef<() => void>(() => {});
  const [bridge] = useState(
    () =>
      new SpaceEditorBridge(
        controller,
        () => SpaceBlockId.make(randomUUID()),
        (description) =>
          toastManager.add({ type: "error", title: "Couldn't apply that change", description }),
        { rootBlockId: sourceBlockId },
      ),
  );
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Debounced autosave subscribes to the external document session and flushes on leave.
  useEffect(() => {
    const saver = createAutosave({
      save: () =>
        controller.save().catch((error: unknown) => {
          toastManager.add({ type: "error", title: "Couldn't save", description: message(error) });
          throw error;
        }),
    });
    const sync = () => {
      const state = controller.session.getSnapshot();
      saver.update(
        state.hydrated &&
          state.dirty &&
          !state.pending &&
          state.status === "draft" &&
          state.persistenceError === null &&
          !controller.getSnapshot().loading
          ? state.generation
          : null,
      );
    };
    flush.current = saver.flush;
    const unsubscribe = controller.subscribe(sync);
    window.addEventListener("pagehide", saver.flush);
    sync();
    return () => {
      flush.current = () => {};
      unsubscribe();
      window.removeEventListener("pagehide", saver.flush);
      saver.dispose();
    };
  }, [controller]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Synchronises the open original with the server's page change stream.
  useEffect(
    () =>
      registry.subscribe(
        spacesEnvironment.pageLive(environmentId, controller.session.key.pageId),
        (signal) => void controller.liveRefresh(signal),
        { immediate: true },
      ),
    [controller, environmentId, registry],
  );
  const { session, loading, error } = snapshot;
  const status: SyncedStatus =
    session.status === "conflict"
      ? "conflict"
      : error || session.persistenceError || session.status === "uncertain"
        ? "error"
        : session.status === "saving"
          ? "saving"
          : session.dirty
            ? "unsaved"
            : "saved";
  const editable =
    permission &&
    !loading &&
    session.persistenceError === null &&
    session.status !== "conflict" &&
    session.status !== "uncertain";
  return (
    <div onBlur={() => flush.current()}>
      {renderHeader({ status, discard: () => void controller.discard().catch(() => {}) })}
      <SyncedHostContext.Provider value={null}>
        <SyncedStaticContext.Provider value={null}>
          <SpaceEditor
            embedded
            comments={comments.enabled ? comments.controller : undefined}
            adapter={bridge.adapter}
            bridge={bridge}
            editable={editable}
            renderChild={renderChild}
          />
        </SyncedStaticContext.Provider>
      </SyncedHostContext.Provider>
    </div>
  );
}

/** An editor over the original's blocks, saved to the original's page through its own session. */
export function SyncedEditor({
  environmentId,
  sourceBlockId,
  sourcePageId,
  renderChild,
  renderHeader,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceBlockId: SpaceBlockId;
  readonly sourcePageId: SpacePageId;
  readonly renderChild: ((block: SpaceBlock) => ReactNode) | undefined;
  readonly renderHeader: (state: SyncedEditorState) => ReactNode;
}) {
  const registry = useContext(RegistryContext);
  const ports = useContext(SyncedPortsContext) ?? defaultSyncedPorts;
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<{
    readonly stamp: string;
    readonly result: { readonly controller: SpaceDocumentController } | { readonly error: unknown };
  } | null>(null);
  const stamp = JSON.stringify([environmentId, sourceBlockId, sourcePageId, attempt]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Opens and releases the external session over the original's page.
  useEffect(() => {
    const controller = ports.createController(registry, environmentId, {
      blockId: sourceBlockId,
      pageId: sourcePageId,
    });
    let active = true;
    void controller.open().then(
      () => active && setOpened({ stamp, result: { controller } }),
      (error: unknown) => active && setOpened({ stamp, result: { error } }),
    );
    return () => {
      active = false;
      controller.invalidate();
    };
  }, [environmentId, ports, registry, sourceBlockId, sourcePageId, stamp]);
  if (!opened || opened.stamp !== stamp) return <SpaceDocumentSkeleton />;
  if ("error" in opened.result)
    return (
      <div className="flex items-center gap-2 text-sm">
        <span role="alert" className="text-destructive-foreground">
          {message(opened.result.error)}
        </span>
        <Button variant="outline" size="xs" onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </Button>
      </div>
    );
  return (
    <EditorBody
      key={stamp}
      controller={opened.result.controller}
      sourceBlockId={sourceBlockId}
      environmentId={environmentId}
      renderChild={renderChild}
      renderHeader={renderHeader}
    />
  );
}
