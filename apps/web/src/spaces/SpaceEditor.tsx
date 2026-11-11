import {
  EditorContent,
  useEditor,
  useEditorState,
  ReactNodeViewRenderer,
  ReactMarkViewRenderer,
} from "@tiptap/react";
import { Extension, Node as TiptapNode, Mark as TiptapMark } from "@tiptap/core";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { CopyIcon, EllipsisIcon, Trash2Icon } from "lucide-react";
import { NodeSelection, Plugin, type Command, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isKnownSpaceBlock, isSpaceDatabaseBlock } from "@t2code/client-runtime/spaces";
import { spaceAtomNodeView } from "./databases/blocks/nodeView";
import { DatabaseHandleItems, MoveBlockItems } from "./databases/blocks/DatabaseHandleItems";
import { DatabaseDeleteHost } from "./databases/blocks/DeleteDatabaseDialog";
import { SpaceAtomContext, SpaceMediaView, SpaceMediaWritableContext } from "./SpaceAtomView";
import { type SpaceBlock, type SpaceBlockId } from "@t2code/contracts/spaces";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { SpaceEditorAdapter, type SpaceEditorBatch } from "./adapter";
import { canEditSpaceEditorBlock, spaceDocumentBlocks } from "./document";
import { SPACE_BLOCK_HANDLE_WIDTH, SpaceBlockHandle } from "./SpaceBlockHandle";
import { SpaceImageControls } from "./SpaceImageControls";
import type { SpaceImageUploads } from "@t2code/client-runtime/spaces";
import type { SpaceEditorBridge } from "./editorBridge";
import {
  SpaceMentionContext,
  SpaceMentionControls,
  SpaceMentionView,
} from "./SpaceMentionControls";
import type { SpaceMentionController } from "./mentions";
import { SpaceDocumentSkeleton } from "./SpaceSkeletons";
import { SpacePageToolbar } from "./SpacePageToolbarSlot";
import { BLOCK_DRAG_TYPE, blockElement, planBlockDrop, type BlockDrop } from "./blockDrag";
import {
  turnInto,
  SpaceEditorWrapperContext,
  selectedBlock,
  editorCapabilities,
  runCommand,
  type SpaceEditorParts,
} from "./spaceEditorSupport";
import {
  BubbleLayer,
  FormatValue,
  SlashLayer,
  type SlashDatabaseCreate,
} from "./SpaceEditorLayers";
import "./editor.css";

const placeholder = "Write, or press '/' for commands…";

const spacePlaceholder = Extension.create({
  name: "spacePlaceholder",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { $from, empty } = state.selection;
            if (!empty || !editor.isEditable || $from.depth === 0) return null;
            const node = $from.parent;
            if (node.type.name !== "paragraph" || node.content.size > 0) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node($from.before(), $from.after(), {
                class: "is-empty",
                "data-placeholder": placeholder,
              }),
            ]);
          },
        },
      }),
    ];
  },
});

function createSpaceSessionDispatch(
  adapter: SpaceEditorAdapter,
  bridge: SpaceEditorBridge | undefined,
  onBatch: ((batch: SpaceEditorBatch) => void) | undefined,
) {
  return Extension.create({
    name: "spaceSessionDispatch",
    dispatchTransaction({ transaction }) {
      const editor = this.editor;
      if (editor.isDestroyed) return;
      const before = editor.state;
      const result = bridge
        ? bridge.apply(before, transaction)
        : before.applyTransaction(transaction);
      if (result.state === before) {
        if (transaction.docChanged) editor.view.updateState(before);
        return;
      }
      editor.emit("beforeTransaction", { editor, transaction, nextState: result.state });
      editor.view.updateState(result.state);
      editor.emit("transaction", {
        editor,
        transaction,
        appendedTransactions: result.transactions.slice(1),
      });
      if (!before.selection.eq(result.state.selection))
        editor.emit("selectionUpdate", { editor, transaction });
      const focus = result.transactions.findLast((tr) => tr.getMeta("focus") || tr.getMeta("blur"));
      if (focus?.getMeta("focus")) {
        editor.isFocused = true;
        editor.emit("focus", {
          editor,
          event: focus.getMeta("focus").event,
          transaction: focus,
        });
      }
      if (focus?.getMeta("blur")) {
        editor.isFocused = false;
        editor.emit("blur", {
          editor,
          event: focus.getMeta("blur").event,
          transaction: focus,
        });
      }
      if (!before.doc.eq(result.state.doc)) {
        onBatch?.(adapter.batch(result.state));
        editor.emit("update", {
          editor,
          transaction,
          appendedTransactions: result.transactions.slice(1),
        });
      }
    },
  });
}

const MEDIA_TYPES: readonly string[] = ["image", "pdf", "video"];

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

export function SpaceEditor({
  savedHistory,
  adapter,
  bridge,
  editable = true,
  mediaEditable = false,
  onBatch,
  onMoveBlocks,
  targetBlockId,
  current,
  sourceOwner,
  images,
  renderChild,
  mentions,
  onOpenSource,
  onCreatePage,
  onCreateDatabase,
}: {
  readonly onCreatePage?: ((blockId: SpaceBlockId | null) => void) | undefined;
  readonly onCreateDatabase?: SlashDatabaseCreate | undefined;
  readonly savedHistory?: ReactNode;
  readonly mentions?: SpaceMentionController | null;
  readonly onOpenSource?: (
    target: import("@t2code/client-runtime/spaces").SpacePageNavigationTarget,
  ) => void;
  readonly images?: SpaceImageUploads;
  readonly targetBlockId?: SpaceBlockId | undefined;
  readonly current?: (() => boolean) | undefined;
  readonly sourceOwner?: { current(): boolean } | null | undefined;
  readonly renderChild?: ((block: SpaceBlock, captionInEditor?: boolean) => ReactNode) | undefined;
  readonly onMoveBlocks?: ((state: import("@tiptap/pm/state").EditorState) => void) | undefined;
  readonly adapter: SpaceEditorAdapter;
  readonly bridge?: SpaceEditorBridge;
  readonly editable?: boolean;
  readonly mediaEditable?: boolean;
  readonly onBatch?: (batch: SpaceEditorBatch) => void;
}) {
  const editor = useEditor(
    {
      extensions: [
        ...adapter
          .extensions()
          .map((extension) =>
            extension.name === "spaceAtom" && extension instanceof TiptapNode
              ? extension.extend({ addNodeView: () => spaceAtomNodeView() })
              : extension.name === "spaceMedia" && extension instanceof TiptapNode
                ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(SpaceMediaView) })
                : ["space_page_mention", "space_block_mention"].includes(extension.name) &&
                    extension instanceof TiptapMark
                  ? extension.extend({ addMarkView: () => ReactMarkViewRenderer(SpaceMentionView) })
                  : extension,
          ),
        spacePlaceholder,
        createSpaceSessionDispatch(adapter, bridge, onBatch),
      ],
      content: adapter.document.toJSON(),
      immediatelyRender: false,
      editable,
      editorProps: {
        attributes: { role: "textbox", "aria-label": "Page editor", "aria-multiline": "true" },
      },
    },
    [adapter, bridge],
  );
  // Layout phase so permission lands before the first paint that reads canEdit().
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Push destination edit permission into the external bridge before the editor view reads it.
  useLayoutEffect(() => {
    bridge?.setWritable(editable, mediaEditable);
  }, [bridge, editable, mediaEditable]);
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Synchronize the mounted editor view with the shared document and destination edit permission.
  useEffect(() => {
    if (!editor) return;
    const synchronize = () => {
      if (editor.isDestroyed) return;
      if (bridge) {
        const next = bridge.synchronize(editor.state);
        if (next !== editor.state) editor.view.updateState(next);
      }
      const allowed = editable && (bridge?.canEdit() ?? true);
      if (editor.isEditable !== allowed) editor.setEditable(allowed, false);
      // Permission lives outside the editor state, so announce it for the state selectors.
      editor.emit("transaction", {
        editor,
        transaction: editor.state.tr,
        appendedTransactions: [],
      });
    };
    synchronize();
    return bridge?.controller.subscribe(synchronize);
  }, [editor, bridge, editable]);
  const shell = useEditorState({
    editor,
    selector: ({ editor }) => {
      if (!editor || editor.isDestroyed) return null;
      const state = editor.state;
      const caps = editorCapabilities(bridge, editable, !!onMoveBlocks);
      const selected = selectedBlock(state);
      const known =
        selected && isKnownSpaceBlock(selected) && canEditSpaceEditorBlock(selected)
          ? selected
          : null;
      const can = (command: Command) => caps.writable && command(state);
      const selectedId = selected?.id ?? null;
      const media = !!selectedId && !!known && MEDIA_TYPES.includes(known.type);
      return {
        ...caps,
        empty: state.doc.childCount === 0,
        selectedId,
        knownId: known?.id ?? null,
        knownType: known?.type ?? null,
        media,
        headingLevel: known?.type === "heading" ? known.content.level : null,
        headingCan:
          known?.type === "heading"
            ? ([1, 2, 3] as const).map((level) => can(adapter.setHeadingLevel(level)))
            : null,
        calloutIcon: known?.type === "callout" ? known.content.icon : null,
        codeLanguage: known?.type === "code" ? known.content.language : null,
        canSplit: caps.structure && can(adapter.split()),
        canJoin: caps.structure && can(adapter.joinBackward()),
        canRemove:
          !!selectedId &&
          caps.structure &&
          (media
            ? mediaEditable && can(adapter.removeMedia(selectedId))
            : can(adapter.remove(selectedId))),
        mentionAvailable: caps.writable && !!adapter.mentionRange(state),
        reveal:
          bridge && targetBlockId
            ? bridge.revealBlock(
                state,
                { ...adapter.target, blockId: targetBlockId },
                () => sourceOwner?.current() === true && current?.() === true,
              ).status
            : null,
      };
    },
  });
  const reveal = shell?.reveal ?? null;
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Reveal a current URL/panel block target once in the already loaded PM view without replacing its draft.
  useEffect(() => {
    if (!editor || !bridge || editor.isDestroyed) return;
    const result = bridge.revealNavigation(
      editor,
      editor.state,
      targetBlockId ? { ...adapter.target, blockId: targetBlockId } : null,
      sourceOwner,
      () => current?.() === true,
    );
    if (result?.transaction && sourceOwner?.current() && current?.())
      editor.view.dispatch(result.transaction);
    // `reveal` is a trigger: the target can finish loading without any other dependency changing.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [adapter, bridge, current, editor, reveal, sourceOwner, targetBlockId]);
  if (!editor || !shell) return <SpaceDocumentSkeleton />;
  const parts: SpaceEditorParts = { editor, adapter, bridge, editable };
  const run = (command: Command) => runCommand(editor, editable, command);
  const can = (command: Command) => shell.writable && command(editor.state);
  const revealTarget = (focus = false) => {
    if (!bridge || !targetBlockId || editor.isDestroyed) return;
    const result = bridge.revealBlock(
      editor.state,
      { ...adapter.target, blockId: targetBlockId },
      () => sourceOwner?.current() === true && current?.() === true,
    );
    if (result.status === "loaded") {
      if (result.transaction && sourceOwner?.current() && current?.())
        editor.view.dispatch(result.transaction);
      if (focus && sourceOwner?.current() && current?.()) editor.view.focus();
    }
  };
  const moreItems = shell.canSplit || shell.canJoin || shell.canMove || shell.canRemove;
  const { selectedId, media } = shell;
  return (
    <section aria-label="Page contents" className="space-y-2" data-space-editor="">
      <SpacePageToolbar>
        {images && bridge ? (
          <SpaceImageControls
            owner={images}
            insertion={bridge.imageInsertion(
              () => editor.state,
              editor.view.dispatch,
              () => !editor.isDestroyed && sourceOwner?.current() === true && current?.() === true,
            )}
            current={() => sourceOwner?.current() === true && current?.() === true}
            replacementTarget={media ? shell.knownId : null}
          />
        ) : null}
        {bridge && mentions ? (
          <SpaceMentionControls
            owner={mentions}
            available={shell.mentionAvailable}
            capture={() =>
              bridge.mentionInsertion(
                () => editor.state,
                editor.view.dispatch,
                () =>
                  !editor.isDestroyed && sourceOwner?.current() === true && current?.() === true,
              )
            }
            onInserted={() => {
              if (!editor.isDestroyed) editor.view.focus();
            }}
          />
        ) : null}
        {moreItems || savedHistory ? (
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {shell.canSplit ? (
                <MenuItem onClick={() => run(adapter.split())}>Split</MenuItem>
              ) : null}
              {shell.canJoin ? (
                <MenuItem onClick={() => run(adapter.joinBackward())}>Join previous</MenuItem>
              ) : null}
              {shell.canMove ? (
                <MenuItem onClick={() => onMoveBlocks?.(editor.state)}>
                  Move selected blocks…
                </MenuItem>
              ) : null}
              {shell.canRemove && selectedId ? (
                <MenuItem
                  variant="destructive"
                  onClick={() =>
                    run(media ? adapter.removeMedia(selectedId) : adapter.remove(selectedId))
                  }
                >
                  <Trash2Icon />
                  {media ? "Remove media block" : "Delete block"}
                </MenuItem>
              ) : null}
              {savedHistory ? (
                <>
                  {moreItems ? <MenuSeparator /> : null}
                  {savedHistory}
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </SpacePageToolbar>
      {shell.knownType === "heading" ||
      shell.knownType === "callout" ||
      shell.knownType === "code" ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {shell.knownType === "heading" ? (
            <div className="flex items-center gap-0.5" role="group" aria-label="Heading level">
              {([1, 2, 3] as const).map((level) => (
                <Button
                  key={level}
                  variant={shell.headingLevel === level ? "outline" : "ghost"}
                  size="sm"
                  aria-label={`Heading ${level}`}
                  aria-pressed={shell.headingLevel === level}
                  disabled={!shell.headingCan?.[level - 1]}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run(adapter.setHeadingLevel(level))}
                >
                  H{level}
                </Button>
              ))}
            </div>
          ) : null}
          {shell.knownType === "callout" ? (
            <FormatValue
              key={JSON.stringify([shell.knownId, shell.calloutIcon])}
              label="Callout icon"
              initial={shell.calloutIcon ?? ""}
              writable={shell.writable}
              command={(value) => adapter.setCalloutIcon(value)}
              can={can}
              run={run}
            />
          ) : null}
          {shell.knownType === "code" ? (
            <FormatValue
              key={JSON.stringify([shell.knownId, shell.codeLanguage])}
              label="Code language label"
              initial={shell.codeLanguage ?? ""}
              writable={shell.writable}
              command={(value) => adapter.setCodeLanguage(value)}
              can={can}
              run={run}
            />
          ) : null}
        </div>
      ) : null}
      {targetBlockId && reveal === "loaded" ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={!current?.()}
          onClick={() => revealTarget(true)}
        >
          Show linked block
        </Button>
      ) : null}
      {targetBlockId && reveal === "not-loaded" ? (
        <p role="status" className="text-sm text-muted-foreground">
          The linked block isn't on this part of the page.
        </p>
      ) : null}
      {!shell.complete ? (
        <p className="text-sm text-muted-foreground">
          Only part of this page is loaded. Use Load more below to see the rest.
        </p>
      ) : null}
      <SpaceAtomContext.Provider value={renderChild}>
        <SpaceMentionContext.Provider
          value={
            mentions && onOpenSource
              ? {
                  owner: mentions,
                  current: () => sourceOwner?.current() === true && current?.() === true,
                  onOpen: onOpenSource,
                }
              : null
          }
        >
          <SpaceMediaWritableContext.Provider value={mediaEditable && shell.writable}>
            <EditorSurface
              {...parts}
              structure={shell.structure}
              mediaEditable={mediaEditable}
              onMoveBlocks={onMoveBlocks}
            >
              {shell.empty && shell.writable ? (
                <p className="pointer-events-none absolute text-muted-foreground/60">
                  {placeholder}
                </p>
              ) : null}
              <BubbleLayer {...parts}>
                <SlashLayer
                  {...parts}
                  onCreatePage={onCreatePage}
                  onCreateDatabase={onCreateDatabase}
                >
                  <EditorContent
                    editor={editor}
                    className="min-h-40 whitespace-pre-wrap break-words [&_.tiptap]:min-h-40 [&_.tiptap]:outline-none"
                  />
                </SlashLayer>
              </BubbleLayer>
            </EditorSurface>
          </SpaceMediaWritableContext.Provider>
        </SpaceMentionContext.Provider>
      </SpaceAtomContext.Provider>
    </section>
  );
}

function EditorSurface({
  editor,
  adapter,
  bridge,
  editable,
  structure,
  mediaEditable,
  onMoveBlocks,
  children,
}: SpaceEditorParts & {
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
      const handle = hoverId && caps.structure ? findBlock(doc, hoverId) : null;
      return {
        canMove: caps.canMove,
        handleId: handle?.id ?? null,
        handleMedia: !!handle && MEDIA_TYPES.includes(handle.type),
        handleDatabase: !!handle && isSpaceDatabaseBlock(handle),
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
    const left = Math.max(0, rect.left - box.left - SPACE_BLOCK_HANDLE_WIDTH);
    measured.current = { block, doc: editor.state.doc };
    setHover((current) =>
      current && current.id === id && current.top === top && current.left === left
        ? current
        : { id, top, left },
    );
  };
  const trackHover = (event: ReactMouseEvent) => {
    if (handleMenuOpen || dragId || !(event.target instanceof Element)) return;
    const block = event.target.closest("[data-space-block]");
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
    if (!dragId) return;
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
        className={structure ? "relative -ms-12 ps-12" : "relative"}
        onMouseMove={trackHover}
        onMouseLeave={clearHover}
        onDragOverCapture={dragOverBlock}
        onDropCapture={dropBlock}
        onDragLeave={leaveDrag}
        onFocus={() => {
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
            onDragStart={startDrag}
            onDragEnd={clearDrag}
          >
            {info.handleDatabase ? (
              <DatabaseHandleItems
                adapter={adapter}
                blockId={handleId}
                can={can}
                run={run}
                onDelete={(id) => setDeleteId({ id, open: false })}
              />
            ) : (
              <>
                <MenuSub>
                  <MenuSubTrigger>Turn into</MenuSubTrigger>
                  <MenuSubPopup>
                    {(Object.keys(turnInto) as (keyof typeof turnInto)[]).map((type) => {
                      const [label, Icon] = turnInto[type];
                      return (
                        <MenuItem
                          key={type}
                          disabled={!can(adapter.convert(handleId, type))}
                          onClick={() => run(adapter.convert(handleId, type))}
                        >
                          <Icon />
                          {label}
                        </MenuItem>
                      );
                    })}
                  </MenuSubPopup>
                </MenuSub>
                <MenuItem
                  disabled={!can(adapter.duplicate(handleId))}
                  onClick={() => run(adapter.duplicate(handleId))}
                >
                  <CopyIcon />
                  Duplicate
                </MenuItem>
                <MoveBlockItems adapter={adapter} blockId={handleId} can={can} run={run} />
                {info.canMove ? (
                  <MenuItem
                    onClick={() => {
                      selectBlock(handleId);
                      onMoveBlocks?.(editor.state);
                    }}
                  >
                    Move to…
                  </MenuItem>
                ) : null}
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  disabled={
                    !(info.handleMedia
                      ? mediaEditable && can(adapter.removeMedia(handleId))
                      : can(adapter.remove(handleId)))
                  }
                  onClick={() =>
                    run(info.handleMedia ? adapter.removeMedia(handleId) : adapter.remove(handleId))
                  }
                >
                  <Trash2Icon />
                  {info.handleMedia ? "Remove media block" : "Delete block"}
                </MenuItem>
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
