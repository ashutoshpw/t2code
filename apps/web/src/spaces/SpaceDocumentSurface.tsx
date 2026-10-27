import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { SpaceBlockId } from "@t2code/contracts/spaces";
import type { SpacePageTarget } from "@t2code/contracts/spaces";
import { Button } from "../components/ui/button";
import { spacesEnvironment } from "../state/spaces";
import { randomUUID } from "../lib/utils";
import { SpaceEditorBridge } from "./editorBridge";
import { SpaceEditor } from "./SpaceEditor";
import { spaceDocuments } from "./sessionRuntime";
import type { SpaceDocumentController } from "./documentController";

export function SpaceDocumentSurface({ target }: { target: SpacePageTarget }) {
  const registry = useContext(RegistryContext);
  const [opened, setOpened] = useState<
    { controller: SpaceDocumentController } | { error: unknown } | null
  >(null);
  const { environmentId, pageId } = target;
  // oxlint-disable-next-line t2code/react-effect-budget -- Acquire and release the external document session shared by route and panel mounts.
  useEffect(() => {
    const key = { environmentId, pageId };
    const documents = spaceDocuments(registry);
    let active = true;
    let release: (() => void) | undefined;
    const ready = (async () => {
      const document = documents.open(key);
      release = document.release;
      return await document.ready;
    })();
    void ready.then(
      (controller) => {
        if (active) setOpened({ controller });
      },
      (error: unknown) => {
        if (active) setOpened({ error });
      },
    );
    return () => {
      active = false;
      release?.();
    };
  }, [environmentId, pageId, registry]);
  if (!opened) return <p role="status">Loading document…</p>;
  if ("error" in opened) return <p role="alert">{message(opened.error)}</p>;
  if (
    opened.controller.session.key.environmentId !== environmentId ||
    opened.controller.session.key.pageId !== pageId
  )
    return <p role="status">Loading document…</p>;
  return <DocumentContent controller={opened.controller} />;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Could not load or save this document.";
}

function DocumentContent({ controller }: { controller: SpaceDocumentController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [bridge] = useState(
    () => new SpaceEditorBridge(controller, () => SpaceBlockId.make(randomUUID())),
  );
  const { session, loading, error } = snapshot;
  const permission = useAtomValue(
    spacesEnvironment.apply.permissionAtom(controller.session.key.environmentId),
  );
  const clean =
    session.hydrated &&
    !session.dirty &&
    !session.pending &&
    session.persistenceError === null &&
    session.status !== "saving";
  const run = (operation: Promise<unknown>) => {
    void operation.catch(() => {});
  };
  return (
    <div className="mt-4 space-y-3">
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
        Saved undo/redo covers only the last content or formatting save. Saved structural changes
        are not supported.
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
          editable={
            permission &&
            !loading &&
            !error &&
            session.persistenceError === null &&
            session.status !== "conflict" &&
            session.status !== "uncertain"
          }
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {(["undo", "redo"] as const).map((direction) => (
          <Button
            key={direction}
            variant="outline"
            disabled={
              !permission ||
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
            disabled={loading || session.status === "saving"}
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
