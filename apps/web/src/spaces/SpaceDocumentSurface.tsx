import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { isKnownSpaceBlock, spaceBlockRuns, spacePlainText } from "@t2code/client-runtime/spaces";
import type { SpacePageTarget } from "@t2code/contracts/spaces";
import { Button } from "../components/ui/button";
import { spacesEnvironment } from "../state/spaces";
import { spaceDocuments } from "./sessionRuntime";
import type { SpaceDocumentController, SpaceDocumentControllers } from "./documentController";

async function openDocument(documents: SpaceDocumentControllers, key: SpacePageTarget) {
  try {
    const controller = documents.acquire(key);
    await controller.open().catch(() => {});
    return { controller };
  } catch (error) {
    return { error };
  }
}

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
    let current: SpaceDocumentController | null = null;
    void openDocument(documents, key).then((result) => {
      if (result.controller) current = result.controller;
      if (active) setOpened(result);
      else if (current) documents.release(key, current);
    });
    return () => {
      active = false;
      if (current) documents.release(key, current);
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
  const run = (operation: Promise<void>) => {
    void operation.catch(() => {});
  };
  return (
    <div className="mt-4 space-y-3">
      <p role="status">
        {!session.hydrated
          ? "Loading document…"
          : session.status === "saved"
            ? "Saved · Read-only document"
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
      {session.hydrated ? (
        <div aria-label="Document blocks" className="space-y-3">
          {session.blocks.length === 0 ? (
            <p>This window has no blocks.</p>
          ) : (
            session.blocks.map((block) => {
              const runs = spaceBlockRuns(block);
              return (
                <div key={block.id} className="whitespace-pre-wrap break-words">
                  {runs ? (
                    spacePlainText(runs)
                  ) : isKnownSpaceBlock(block) && block.type === "code" ? (
                    <pre>{block.content.text}</pre>
                  ) : isKnownSpaceBlock(block) && block.type === "divider" ? (
                    <hr />
                  ) : (
                    <span>{block.type} block · Preview unavailable</span>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
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
              (session.pending ? false : !permission) ||
              session.status === "conflict"
            }
            onClick={() => run(controller.save())}
          >
            {session.pending ? "Check save receipt" : "Save draft"}
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
