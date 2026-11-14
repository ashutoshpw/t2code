import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { EllipsisIcon, Trash2Icon } from "lucide-react";
import { Plugin, type Command } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import { SpaceAtomContext, SpaceMediaWritableContext } from "./SpaceAtomView";
import { type SpaceBlock, type SpaceBlockId } from "@t2code/contracts/spaces";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { SpaceEditorAdapter, type SpaceEditorBatch } from "./adapter";
import { canEditSpaceEditorBlock } from "./document";
import { SpaceImageControls } from "./SpaceImageControls";
import type { SpaceImageUploads } from "@t2code/client-runtime/spaces";
import type { SpaceEditorBridge } from "./editorBridge";
import { SpaceMentionContext, SpaceMentionControls } from "./SpaceMentionControls";
import type { SpaceMentionController } from "./mentions";
import { SpaceDocumentSkeleton } from "./SpaceSkeletons";
import { SpacePageToolbar } from "./SpacePageToolbarSlot";
import { MEDIA_TYPES, EditorSurface, EmbeddedSurface } from "./SpaceEditorSurface";
import { syncedPasteExtension } from "./synced/syncedPaste";
import { SpaceEditorAdapterContext, withSpaceNodeViews } from "./spaceNodeViews";
import { spaceCodeHighlight } from "./spaceCodeHighlight";
import {
  selectedBlock,
  editorCapabilities,
  runCommand,
  type SpaceEditorParts,
} from "./spaceEditorSupport";
import {
  BubbleLayer,
  SlashLayer,
  type SlashDatabaseCreate,
  type SpaceBlockFeatures,
} from "./SpaceEditorLayers";
import { spaceCommentsPlugin } from "./comments/commentsPlugin";
import type { SpaceCommentsController } from "./comments/commentsController";
import { SpaceCommentsLayer } from "./comments/SpaceCommentsLayer";
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
  blockFeatures,
  comments,
  embedded = false,
}: {
  /** A synced copy's editor inside another editor: no toolbar, handle or page-level controls. */
  readonly embedded?: boolean;
  readonly onCreatePage?: ((blockId: SpaceBlockId | null) => void) | undefined;
  readonly onCreateDatabase?: SlashDatabaseCreate | undefined;
  readonly blockFeatures?: SpaceBlockFeatures | undefined;
  /** Per-viewer comment highlights and popovers; absent where comments are unavailable (shared pages). */
  readonly comments?: SpaceCommentsController | undefined;
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
        ...(!embedded && blockFeatures?.synced ? [syncedPasteExtension(adapter)] : []),
        ...withSpaceNodeViews(adapter.extensions()),
        spacePlaceholder,
        spaceCodeHighlight(),
        ...(comments
          ? [
              Extension.create({
                name: "spaceComments",
                addProseMirrorPlugins: () => [spaceCommentsPlugin(comments)],
              }),
            ]
          : []),
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
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Attaches the external comment controller to the mounted editor view.
  useEffect(() => {
    if (!editor || !comments) return;
    return comments.attach(editor.view);
  }, [editor, comments]);
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
        media,
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
  const showToolbar = !embedded;
  const content = (
    <>
      {shell.empty && shell.writable ? (
        <p className="pointer-events-none absolute text-muted-foreground/60">{placeholder}</p>
      ) : null}
      {comments ? <SpaceCommentsLayer controller={comments} /> : null}
      <BubbleLayer {...parts} comments={comments}>
        <SlashLayer
          {...parts}
          onCreatePage={onCreatePage}
          onCreateDatabase={onCreateDatabase}
          blockFeatures={blockFeatures}
        >
          <EditorContent
            editor={editor}
            className={`whitespace-pre-wrap break-words [&_.tiptap]:outline-none ${embedded ? "[&_.tiptap]:min-h-6" : "min-h-40 [&_.tiptap]:min-h-40"}`}
          />
        </SlashLayer>
      </BubbleLayer>
    </>
  );
  const moreItems = shell.canSplit || shell.canJoin || shell.canMove || shell.canRemove;
  const { selectedId, media } = shell;
  return (
    <section
      aria-label={embedded ? "Synced block contents" : "Page contents"}
      className="space-y-2"
      data-space-editor=""
      {...(embedded ? { "data-space-nested-editor": "" } : {})}
    >
      {showToolbar ? (
        <SpacePageToolbar>
          {images && bridge ? (
            <SpaceImageControls
              owner={images}
              insertion={bridge.imageInsertion(
                () => editor.state,
                editor.view.dispatch,
                () =>
                  !editor.isDestroyed && sourceOwner?.current() === true && current?.() === true,
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
      {!shell.complete && !embedded ? (
        <p className="text-sm text-muted-foreground">
          Only part of this page is loaded. Use Load more below to see the rest.
        </p>
      ) : null}
      <SpaceEditorAdapterContext.Provider value={adapter}>
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
              {embedded ? (
                <EmbeddedSurface>{content}</EmbeddedSurface>
              ) : (
                <EditorSurface
                  {...parts}
                  structure={shell.structure}
                  mediaEditable={mediaEditable}
                  onMoveBlocks={onMoveBlocks}
                  comments={comments}
                >
                  {content}
                </EditorSurface>
              )}
            </SpaceMediaWritableContext.Provider>
          </SpaceMentionContext.Provider>
        </SpaceAtomContext.Provider>
      </SpaceEditorAdapterContext.Provider>
    </section>
  );
}
