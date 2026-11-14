import { useEditorState } from "@tiptap/react";
import {
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { NodeSelection, type Command, type EditorState } from "@tiptap/pm/state";
import { isSpaceDatabaseBlock } from "@t2code/client-runtime/spaces";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";
import { DatabaseHandleItems } from "./databases/blocks/LazyDatabaseHandleItems";
import { DatabaseDeleteHost } from "./databases/blocks/DeleteDatabaseDialog";
import { spaceDocumentBlocks } from "./document";
import {
  SPACE_BLOCK_HANDLE_COMMENT_WIDTH,
  SPACE_BLOCK_HANDLE_WIDTH,
  SpaceBlockHandle,
} from "./SpaceBlockHandle";
import type { SpaceCommentsController } from "./comments/commentsController";
import { SpaceBlockHandleItems } from "./SpaceBlockHandleItems";
import { BLOCK_DRAG_TYPE, blockElement, planBlockDrop, type BlockDrop } from "./blockDrag";
import {
  SpaceEditorWrapperContext,
  editorCapabilities,
  fromNestedEditor,
  runCommand,
  type SpaceEditorParts,
} from "./spaceEditorSupport";

export const MEDIA_TYPES: readonly string[] = ["image", "pdf", "video"];

function findBlock(doc: EditorState["doc"], id: SpaceBlockId): SpaceBlock | null {
  let found: SpaceBlock | null = null;
  doc.descendants((node) => {
    if (found) return false;
    const block = node.attrs.block as SpaceBlock | undefined;
    if (block?.id === id) found = block;
    return !found;
  });
  return found;
}

/** The wrapper a nested editor's menus position against; it has no block handle or drag. */
export function EmbeddedSurface({ children }: { readonly children: ReactNode }) {
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  return (
    <SpaceEditorWrapperContext.Provider value={wrapper}>
      <div ref={setWrapper} className="relative">
        {children}
      </div>
    </SpaceEditorWrapperContext.Provider>
  );
}

/** The block under the pointer; inside a synced copy that is the copy itself, which the host moves. */
function hoverTarget(target: Element) {
  const nested = target.closest("[data-space-nested-editor]");
  return (nested ?? target).closest("[data-space-block]");
}

export function EditorSurface({
  editor,
  adapter,
  bridge,
  editable,
  structure,
  mediaEditable,
  onMoveBlocks,
  comments,
  children,
}: SpaceEditorParts & {
  readonly comments?: SpaceCommentsController | undefined;
  readonly structure: boolean;
  readonly mediaEditable: boolean;
  readonly onMoveBlocks: ((state: EditorState) => void) | undefined;
  readonly children: ReactNode;
}) {
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  // Measured when the pointer settles on a block, so the handle never uses a layout from an earlier render.
  const [hover, setHover] = useState<{
    readonly id: SpaceBlockId;
    readonly top: number;
    readonly left: number;
  } | null>(null);
  const hoverId = hover?.id ?? null;
  const [handleMenuOpen, setHandleMenuOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<{ id: SpaceBlockId; open: boolean } | null>(null);
  const [dragId, setDragId] = useState<SpaceBlockId | null>(null);
  const [drop, setDrop] = useState<BlockDrop | null>(null);
  const pendingHover = useRef<{ frame: number | null; block: Element | null }>({
    frame: null,
    block: null,
  });
  const measured = useRef<{ block: Element; doc: EditorState["doc"] } | null>(null);
  const dragBlocks = useRef<readonly SpaceBlock[] | null>(null);
  const info = useEditorState({
    editor,
    selector: ({ editor }) => {
      const caps = editorCapabilities(bridge, editable, !!onMoveBlocks);
      const doc = editor.state.doc;
      const handle =
        hoverId && (caps.structure || comments?.enabled()) ? findBlock(doc, hoverId) : null;
      return {
        canMove: caps.canMove,
        structure: caps.structure,
        commentable: comments?.enabled() === true,
        handleId: handle?.id ?? null,
        handleMedia: !!handle && MEDIA_TYPES.includes(handle.type),
        handleTabs: handle?.type === "tabs",
        handleType: handle?.type ?? null,
        handleDatabase: !!handle && isSpaceDatabaseBlock(handle),
        handleDatabaseId: handle && isSpaceDatabaseBlock(handle) ? handle.content.databaseId : null,
        dragExists: !dragId || !!findBlock(doc, dragId),
      };
    },
  });
  const run = (command: Command) => runCommand(editor, editable, command);
  const can = (command: Command) =>
    editorCapabilities(bridge, editable, false).writable && command(editor.state);
  const measureHover = (block: Element) => {
    if (!wrapper || !block.isConnected) return;
    const id = block.getAttribute("data-space-block") as SpaceBlockId | null;
    if (!id) return;
    const rect = block.getBoundingClientRect();
    const box = wrapper.getBoundingClientRect();
    const top = rect.top - box.top + 2;
    const width = comments?.enabled() ? SPACE_BLOCK_HANDLE_COMMENT_WIDTH : SPACE_BLOCK_HANDLE_WIDTH;
    const left = Math.max(0, rect.left - box.left - width);
    measured.current = { block, doc: editor.state.doc };
    setHover((current) =>
      current && current.id === id && current.top === top && current.left === left
        ? current
        : { id, top, left },
    );
  };
  const trackHover = (event: ReactMouseEvent) => {
    if (handleMenuOpen || dragId || !(event.target instanceof Element)) return;
    const block = hoverTarget(event.target);
    if (!block || !wrapper) return;
    if (measured.current?.block === block && measured.current.doc === editor.state.doc) return;
    const pending = pendingHover.current;
    pending.block = block;
    if (pending.frame === null) {
      pending.frame = requestAnimationFrame(() => {
        pending.frame = null;
        if (pending.block) measureHover(pending.block);
      });
    }
  };
  const clearHover = () => {
    if (handleMenuOpen || dragId) return;
    const pending = pendingHover.current;
    if (pending.frame !== null) cancelAnimationFrame(pending.frame);
    pending.frame = null;
    pending.block = null;
    measured.current = null;
    setHover(null);
  };
  const clearDrag = () => {
    dragBlocks.current = null;
    setDragId(null);
    setDrop(null);
  };
  const startDrag = (event: ReactDragEvent) => {
    if (!hoverId) return event.preventDefault();
    event.dataTransfer.setData(BLOCK_DRAG_TYPE, hoverId);
    event.dataTransfer.effectAllowed = "move";
    const element = blockElement(wrapper, hoverId);
    if (element) event.dataTransfer.setDragImage(element, 0, 0);
    dragBlocks.current = spaceDocumentBlocks(editor.state.doc);
    setDragId(hoverId);
  };
  const dragOverBlock = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragId || !wrapper) return;
    if (fromNestedEditor(event)) return setDrop(null);
    event.stopPropagation();
    const element =
      event.target instanceof Element ? event.target.closest("[data-space-block]") : null;
    const targetId = element?.getAttribute("data-space-block") as SpaceBlockId | null | undefined;
    if (!element || !targetId) {
      if (drop?.allowed) event.preventDefault();
      return;
    }
    const rect = element.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const key = `${targetId}:${after}`;
    if (drop?.key !== key) {
      const blocks = dragBlocks.current ?? spaceDocumentBlocks(editor.state.doc);
      dragBlocks.current = blocks;
      return setDrop(
        planBlockDrop({
          blocks,
          dragId,
          targetId,
          after,
          rect,
          box: wrapper.getBoundingClientRect(),
          canMove: (parentId, beforeId) => adapter.move(dragId, parentId, beforeId)(editor.state),
        }),
      );
    }
    if (drop.allowed) event.preventDefault();
  };
  const dropBlock = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragId || fromNestedEditor(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = drop;
    clearDrag();
    if (target?.allowed) run(adapter.move(dragId, target.parentId, target.beforeId));
  };
  const leaveDrag = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)))
      setDrop(null);
  };
  if (dragId && !info.dragExists) {
    setDragId(null);
    setDrop(null);
  }
  const handleId = info.handleId;
  const handleAt = handleId && hover ? { top: hover.top, left: hover.left } : null;
  const onComment =
    handleId && info.commentable && comments
      ? () => {
          const element = blockElement(wrapper, handleId);
          if (element instanceof HTMLElement)
            comments.compose({ blockId: handleId, anchor: { kind: "block" }, element });
        }
      : null;
  const selectBlock = (id: SpaceBlockId) => {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (at >= 0 || node.attrs.block?.id !== id) return at < 0;
      at = pos;
      return false;
    });
    if (at >= 0)
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)),
      );
  };
  return (
    <SpaceEditorWrapperContext.Provider value={wrapper}>
      <div
        ref={setWrapper}
        className={structure || info.commentable ? "relative -ms-12 ps-12" : "relative"}
        onMouseMove={trackHover}
        onMouseLeave={clearHover}
        onDragOverCapture={dragOverBlock}
        onDropCapture={dropBlock}
        onDragLeave={leaveDrag}
        onFocus={(event) => {
          if (fromNestedEditor(event)) return;
          const caps = editorCapabilities(bridge, editable, false);
          if (editor.state.doc.childCount === 0 && caps.structure && caps.complete)
            adapter.append()(editor.state, editor.view.dispatch);
        }}
      >
        {children}
        {handleAt && handleId ? (
          <SpaceBlockHandle
            top={handleAt.top}
            left={handleAt.left}
            menuOpen={handleMenuOpen}
            onMenuOpenChange={setHandleMenuOpen}
            onMenuClosed={() => setDeleteId((request) => request && { ...request, open: true })}
            onAdd={
              can(adapter.insertAfter(handleId))
                ? () => run(adapter.insertAfter(handleId, "/"))
                : null
            }
            structure={info.structure}
            onComment={onComment}
            onDragStart={startDrag}
            onDragEnd={clearDrag}
          >
            {info.handleDatabase && info.handleDatabaseId !== null ? (
              <DatabaseHandleItems
                adapter={adapter}
                blockId={handleId}
                databaseId={info.handleDatabaseId}
                can={can}
                run={run}
                onDelete={(id) => setDeleteId({ id, open: false })}
              />
            ) : (
              <>
                <SpaceBlockHandleItems
                  onComment={onComment}
                  editor={editor}
                  adapter={adapter}
                  editable={editable}
                  blockId={handleId}
                  can={can}
                  run={run}
                  media={info.handleMedia}
                  blockType={info.handleType}
                  convertible={!info.handleTabs && info.handleType !== "synced_block"}
                  mediaEditable={mediaEditable}
                  canMove={info.canMove}
                  onMoveTo={() => {
                    selectBlock(handleId);
                    onMoveBlocks?.(editor.state);
                  }}
                />
              </>
            )}
          </SpaceBlockHandle>
        ) : null}
        <DatabaseDeleteHost
          request={deleteId}
          adapter={adapter}
          run={run}
          onClose={() => setDeleteId(null)}
        />
        {drop?.allowed ? (
          <div
            className="pointer-events-none absolute z-10 h-0.5 rounded-full bg-primary"
            style={{ top: drop.top - 1, left: drop.left, width: drop.width }}
          />
        ) : null}
      </div>
    </SpaceEditorWrapperContext.Provider>
  );
}
