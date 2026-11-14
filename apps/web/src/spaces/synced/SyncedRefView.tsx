import { RegistryContext } from "@effect/atom-react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { ExternalLinkIcon, PencilIcon, RefreshCcwIcon, Trash2Icon, UnlinkIcon } from "lucide-react";
import { lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { isSpaceSyncedRef, syncedRefState } from "@t2code/client-runtime/spaces";
import {
  SpacePageId,
  type SpaceBlock,
  type SpaceReadSubtreeResult,
} from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { toastManager } from "~/components/ui/toast";
import { SpaceAtomContext } from "../SpaceAtomView";
import { runCommand } from "../spaceEditorSupport";
import { SpaceEditorAdapterContext } from "../spaceNodeViews";
import type { SyncedEditorState, SyncedStatus } from "./SyncedEditor";
import {
  SyncedHostContext,
  SyncedPortsContext,
  SyncedStaticContext,
  type SyncedHost,
} from "./SyncedContext";
import { defaultSyncedPorts } from "./syncedPorts";
import { SyncedReadOnly } from "./SyncedReadOnly";
import { unsyncCopies } from "./syncedActions";

const SHARED_PAGE = SpacePageId.make("synced");

// The nested editor pulls in the draft store, which the public shared page must not load.
const SyncedEditor = lazy(() =>
  import("./SyncedEditor").then((module) => ({ default: module.SyncedEditor })),
);

const STATUS_LABEL: Record<SyncedStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  conflict: "Conflict: the original changed elsewhere",
  error: "Couldn't save",
};

function Frame({
  title,
  actions,
  children,
}: {
  readonly title: string | null;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div data-space-synced-frame="">
      <div
        data-space-synced-ref-header=""
        className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      >
        <RefreshCcwIcon aria-hidden className="size-3" />
        <span>{title === null ? "Synced block" : `Synced from ${title || "Untitled page"}`}</span>
        {actions}
      </div>
      {children}
    </div>
  );
}

function Notice({ text, onRemove }: { readonly text: string; readonly onRemove: () => void }) {
  return (
    <Frame title={null}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span role="status">{text}</span>
        <Button variant="outline" size="xs" onClick={onRemove}>
          <Trash2Icon />
          Remove
        </Button>
      </div>
    </Frame>
  );
}

type Found = Extract<SpaceReadSubtreeResult, { readonly status: "found" }>;

function HostedRef({
  host,
  block,
  node,
  select,
}: {
  readonly host: SyncedHost;
  readonly block: SpaceBlock;
  readonly node: NodeViewProps;
  readonly select: () => void;
}) {
  const registry = useContext(RegistryContext);
  const adapter = useContext(SpaceEditorAdapterContext);
  const renderChild = useContext(SpaceAtomContext);
  const sourceBlockId = isSpaceSyncedRef(block) ? block.content.sourceBlockId : null;
  const { environmentId } = host;
  const ports = useContext(SyncedPortsContext) ?? defaultSyncedPorts;
  const query = ports.useSubtree(environmentId, sourceBlockId);
  const writable = ports.useWritable(environmentId);
  const found: Found | null = query.data?.status === "found" ? query.data : null;
  const samePage = found?.page.id === host.pageId;
  const state = syncedRefState(query.data ?? undefined, writable && !samePage);
  const remove = () => {
    if (adapter) runCommand(node.editor, true, adapter.remove(block.id));
  };
  const reportFailure = (title: string) => (error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : undefined,
    });
  const unsync = async () => {
    if (sourceBlockId === null) return;
    if (!host.hostClean()) await host.saveHost();
    await unsyncCopies(registry, environmentId, sourceBlockId, [block.id]);
    await host.refreshHost();
  };
  const openOriginal = (found: Found) =>
    host.openPage({
      environmentId,
      spaceId: found.page.spaceId,
      pageId: found.page.id,
      ...(sourceBlockId === null ? {} : { blockId: sourceBlockId }),
    });
  const editOriginal = () => {
    const element = node.editor.view.dom.querySelector(
      `[data-space-type="synced_block"][data-space-block="${CSS.escape(sourceBlockId ?? "")}"]`,
    );
    element?.scrollIntoView({ block: "center" });
    element?.querySelector<HTMLElement>("[contenteditable=true]")?.focus();
  };
  if (state === "loading")
    return query.error ? (
      <Notice text="Couldn't load the original." onRemove={remove} />
    ) : (
      <Skeleton className="h-16 w-full" aria-label="Loading synced block" role="status" />
    );
  if (state === "deleted")
    return <Notice text="The original synced block was deleted." onRemove={remove} />;
  if (state === "unavailable" || !found || sourceBlockId === null)
    return <Notice text="The original is unavailable (it may be in Trash)." onRemove={remove} />;
  if (state === "readonly")
    return (
      <Frame
        title={found.page.title}
        actions={
          samePage ? (
            <Button variant="ghost" size="xs" onClick={editOriginal}>
              <PencilIcon />
              Edit original
            </Button>
          ) : (
            <Button variant="ghost" size="xs" onClick={() => openOriginal(found)}>
              <ExternalLinkIcon />
              Open original
            </Button>
          )
        }
      >
        <SyncedReadOnly
          key={found.revision}
          pageId={found.page.id}
          blocks={found.blocks}
          renderChild={renderChild}
        />
      </Frame>
    );
  return (
    <Suspense fallback={<Skeleton className="h-8 w-full" />}>
      <SyncedEditor
        environmentId={environmentId}
        sourceBlockId={sourceBlockId}
        sourcePageId={found.page.id}
        renderChild={renderChild}
        renderHeader={(editor: SyncedEditorState) => (
          <div
            data-space-synced-ref-header=""
            className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            <RefreshCcwIcon aria-hidden className="size-3" />
            <button type="button" className="hover:underline" onClick={select}>
              Synced from {found.page.title || "Untitled page"}
            </button>
            <span role="status">{STATUS_LABEL[editor.status]}</span>
            {editor.status === "conflict" ? (
              <Button variant="outline" size="xs" onClick={editor.discard}>
                Discard my changes
              </Button>
            ) : null}
            <Button variant="ghost" size="xs" onClick={() => openOriginal(found)}>
              <ExternalLinkIcon />
              Open original
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={editor.status !== "saved"}
              onClick={() => void unsync().catch(reportFailure("Couldn't unsync this copy"))}
            >
              <UnlinkIcon />
              Unsync
            </Button>
          </div>
        )}
      />
    </Suspense>
  );
}

function StaticRef({ block }: { readonly block: SpaceBlock }) {
  const entries = useContext(SyncedStaticContext);
  const renderChild = useContext(SpaceAtomContext);
  const entry = isSpaceSyncedRef(block) ? entries?.get(block.content.sourceBlockId) : undefined;
  if (!entry || entry.blocks.length === 0)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Synced content unavailable.
      </p>
    );
  return (
    <Frame title={null}>
      <SyncedReadOnly pageId={SHARED_PAGE} blocks={entry.blocks} renderChild={renderChild} />
    </Frame>
  );
}

export function SyncedRefView(props: NodeViewProps) {
  const block = props.node.attrs.block as SpaceBlock;
  const host = useContext(SyncedHostContext);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Mounts the nested session only once the copy scrolls into view, then keeps it.
  useEffect(() => {
    if (!element || visible) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, visible]);
  const select = () => {
    const at = props.getPos();
    if (at !== undefined) props.editor.commands.setNodeSelection(at);
  };
  return (
    <NodeViewWrapper
      data-space-block={block.id}
      data-space-type="synced_ref"
      contentEditable={false}
    >
      <div ref={setElement}>
        {!visible ? (
          <Skeleton className="h-16 w-full" aria-label="Loading synced block" role="status" />
        ) : host ? (
          <HostedRef host={host} block={block} node={props} select={select} />
        ) : (
          <StaticRef block={block} />
        )}
      </div>
    </NodeViewWrapper>
  );
}
