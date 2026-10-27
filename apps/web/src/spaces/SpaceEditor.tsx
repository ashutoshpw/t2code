import { EditorContent, useEditor, useEditorState, ReactNodeViewRenderer } from "@tiptap/react";
import { Extension, Node as TiptapNode } from "@tiptap/core";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { NodeSelection, type Command } from "@tiptap/pm/state";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import { SpaceAtomContext, SpaceAtomView } from "./SpaceAtomView";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { SpaceEditorAdapter, type SpaceEditorBatch } from "./adapter";
import { canEditSpaceEditorBlock, spaceDocumentBlocks } from "./document";
import type { SpaceEditorBridge } from "./editorBridge";
import "./editor.css";

export function SpaceEditor({
  adapter,
  bridge,
  editable = true,
  onBatch,
  onMoveBlocks,
  targetBlockId,
  current,
  revealOwner,
  renderChild,
}: {
  readonly targetBlockId?: SpaceBlockId | undefined;
  readonly current?: (() => boolean) | undefined;
  readonly revealOwner?: object | null | undefined;
  readonly renderChild?: ((block: SpaceBlock) => ReactNode) | undefined;
  readonly onMoveBlocks?: ((state: import("@tiptap/pm/state").EditorState) => void) | undefined;
  readonly adapter: SpaceEditorAdapter;
  readonly bridge?: SpaceEditorBridge;
  readonly editable?: boolean;
  readonly onBatch?: (batch: SpaceEditorBatch) => void;
}) {
  const revealed = useRef<{
    editor: object;
    blockId: SpaceBlockId;
    owner: object | null | undefined;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const historyNotice = useSyncExternalStore(
    bridge?.subscribe ?? noSubscribe,
    bridge?.getSnapshot ?? noNotice,
  );
  const editor = useEditor(
    {
      extensions: [
        ...adapter
          .extensions()
          .map((extension) =>
            extension.name === "spaceAtom" && extension instanceof TiptapNode
              ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(SpaceAtomView) })
              : extension,
          ),
        Extension.create({
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
            const focus = result.transactions.findLast(
              (tr) => tr.getMeta("focus") || tr.getMeta("blur"),
            );
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
        }),
      ],
      content: adapter.document.toJSON(),
      immediatelyRender: false,
      editable,
      editorProps: { attributes: { "aria-label": "Page editor", "aria-multiline": "true" } },
    },
    [adapter, bridge],
  );
  // oxlint-disable-next-line t2code/react-effect-budget -- Synchronize the mounted editor view with the shared document and destination edit permission.
  useEffect(() => {
    if (!editor) return;
    bridge?.setWritable(editable);
    const synchronize = () => {
      if (editor.isDestroyed) return;
      if (bridge) {
        const next = bridge.synchronize(editor.state);
        if (next !== editor.state) {
          editor.view.updateState(next);
          editor.emit("transaction", { editor, transaction: next.tr, appendedTransactions: [] });
        }
      }
      const allowed = editable && (bridge?.canEdit() ?? true);
      if (editor.isEditable !== allowed) editor.setEditable(allowed, false);
    };
    synchronize();
    return bridge?.controller.subscribe(synchronize);
  }, [editor, bridge, editable]);
  const state = useEditorState({
    editor,
    selector: ({ editor }) => editor?.state ?? null,
    equalityFn: Object.is,
  });
  const revealTarget = (focus = false) => {
    if (!editor || !bridge || !targetBlockId || editor.isDestroyed) return;
    const result = bridge.revealBlock(
      editor.state,
      { ...adapter.target, blockId: targetBlockId },
      () => current?.() === true,
    );
    if (result.status === "loaded") {
      revealed.current = { editor, blockId: targetBlockId, owner: revealOwner };
      if (result.transaction && current?.()) editor.view.dispatch(result.transaction);
      if (focus && current?.()) editor.view.focus();
    }
  };
  const document = state?.doc;
  const reveal =
    bridge && state && targetBlockId
      ? bridge.revealBlock(
          state,
          { ...adapter.target, blockId: targetBlockId },
          () => current?.() === true,
        ).status
      : null;
  // oxlint-disable-next-line t2code/react-effect-budget -- Reveal a current URL/panel block target once in the already loaded PM view without replacing its draft.
  useEffect(() => {
    if (!editor || !bridge || !targetBlockId) {
      revealed.current = null;
      return;
    }
    if (!document || editor.state.doc !== document || !current?.()) return;
    if (
      revealed.current?.editor === editor &&
      revealed.current.blockId === targetBlockId &&
      revealed.current.owner === revealOwner
    )
      return;
    const result = bridge.revealBlock(
      editor.state,
      { ...adapter.target, blockId: targetBlockId },
      () => current?.() === true,
    );
    if (result.status === "loaded") {
      revealed.current = { editor, blockId: targetBlockId, owner: revealOwner };
      if (result.transaction && current?.()) editor.view.dispatch(result.transaction);
    }
  }, [adapter, bridge, current, document, editor, revealOwner, targetBlockId]);
  const run = (command: Command) => {
    if (!editor || !editable) return;
    try {
      setNotice(
        command(editor.state, editor.view.dispatch)
          ? null
          : "This action is unavailable in the current page window.",
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "This edit could not be applied.");
    }
    editor.view.focus();
  };
  if (!editor || !state) return <p role="status">Loading editor…</p>;
  let selectedId: SpaceBlockId | null =
    state.selection instanceof NodeSelection
      ? (state.selection.node.attrs.block?.id ?? null)
      : null;
  for (let depth = state.selection.$from.depth; depth > 0; depth--) {
    const id = state.selection.$from.node(depth).attrs.block?.id as SpaceBlockId | undefined;
    if (id) {
      selectedId = id;
      break;
    }
  }
  const selected = spaceDocumentBlocks(state.doc).find((block) => block.id === selectedId);
  const known =
    selected && isKnownSpaceBlock(selected) && canEditSpaceEditorBlock(selected) ? selected : null;
  const link = adapter.linkSelection(state);
  const writable = editable && (bridge?.canEdit() ?? true);
  const structure = writable && (bridge?.canStructure() ?? true);
  const can = (command: Command) => writable && command(state);
  return (
    <section aria-label="Page contents" className="space-y-3" data-space-editor="">
      <div className="flex flex-wrap gap-2">
        {bridge ? (
          <Button
            variant="outline"
            disabled={
              !onMoveBlocks ||
              !structure ||
              !!bridge.controller.session.structureAvailability() ||
              !bridge.controller.editorWindow().completeParents.includes(null)
            }
            onClick={() => onMoveBlocks?.(state)}
          >
            Move selected blocks
          </Button>
        ) : null}
        {(["bold", "italic", "strike", "code"] as const).map((mark) => (
          <Button
            key={mark}
            variant="outline"
            disabled={!writable || !can(adapter.mark(mark))}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(adapter.mark(mark))}
          >
            {mark === "strike" ? "Strikethrough" : mark === "code" ? "Inline code" : mark}
          </Button>
        ))}
        <Button
          variant="outline"
          disabled={!structure || !can(adapter.append())}
          onClick={() => run(adapter.append())}
        >
          Add paragraph
        </Button>
        <Button
          variant="outline"
          disabled={!structure || !can(adapter.append("code"))}
          onClick={() => run(adapter.append("code"))}
        >
          Add code
        </Button>
        <Button
          variant="outline"
          disabled={!structure || !can(adapter.append("divider"))}
          onClick={() => run(adapter.append("divider"))}
        >
          Add divider
        </Button>
        <Button
          variant="outline"
          disabled={!structure || !can(adapter.split())}
          onClick={() => run(adapter.split())}
        >
          Split
        </Button>
        <Button
          variant="outline"
          disabled={!structure || !can(adapter.joinBackward())}
          onClick={() => run(adapter.joinBackward())}
        >
          Join previous
        </Button>
        <Button
          variant="outline"
          disabled={!can(adapter.undoLocal())}
          onClick={() => run(adapter.undoLocal())}
        >
          Local undo
        </Button>
        <Button
          variant="outline"
          disabled={!can(adapter.redoLocal())}
          onClick={() => run(adapter.redoLocal())}
        >
          Local redo
        </Button>
        {(
          [
            "paragraph",
            "heading",
            "quote",
            "callout",
            "bulleted_item",
            "numbered_item",
            "todo_item",
          ] as const
        ).map((type) => (
          <Button
            key={type}
            variant="outline"
            disabled={!structure || !selectedId || !can(adapter.convert(selectedId, type))}
            onClick={() => selectedId && run(adapter.convert(selectedId, type))}
          >
            {
              {
                paragraph: "Paragraph",
                heading: "Heading",
                quote: "Quote",
                callout: "Callout",
                bulleted_item: "Bullet list",
                numbered_item: "Numbered list",
                todo_item: "To-do",
              }[type]
            }
          </Button>
        ))}
        {selected?.type === "todo_item" && selectedId ? (
          <Button
            variant="outline"
            disabled={!writable || !can(adapter.toggleTodo(selectedId))}
            onClick={() => run(adapter.toggleTodo(selectedId))}
          >
            Toggle to-do
          </Button>
        ) : null}
      </div>
      {known?.type === "heading" ? (
        <div className="flex flex-wrap gap-2" aria-label="Heading level">
          {([1, 2, 3] as const).map((level) => (
            <Button
              key={level}
              variant="outline"
              aria-pressed={known.content.level === level}
              disabled={!can(adapter.setHeadingLevel(level))}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => run(adapter.setHeadingLevel(level))}
            >
              Heading {level}
            </Button>
          ))}
        </div>
      ) : null}
      {known?.type === "callout" ? (
        <FormatValue
          key={JSON.stringify([known.id, known.content.icon])}
          label="Callout icon"
          initial={known.content.icon}
          writable={writable}
          command={(value) => adapter.setCalloutIcon(value)}
          can={can}
          run={run}
        />
      ) : null}
      {known?.type === "code" ? (
        <FormatValue
          key={JSON.stringify([known.id, known.content.language])}
          label="Code language label"
          initial={known.content.language}
          writable={writable}
          command={(value) => adapter.setCodeLanguage(value)}
          can={can}
          run={run}
        />
      ) : null}
      {link ? (
        <LinkValue
          key={JSON.stringify([selectedId, link.from, link.to, link.href])}
          href={link.href ?? ""}
          hasLink={link.hasLink}
          adapter={adapter}
          writable={writable}
          can={can}
          run={run}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select text to add a link, or place the caret inside an existing link to edit or remove
          it.
        </p>
      )}
      {targetBlockId ? (
        <div className="space-y-2">
          <p role="status">
            {reveal === "loaded"
              ? "Linked block is loaded. Its content and draft were retained."
              : reveal === "not-loaded"
                ? "Linked block is not in this draft/window. No target-window locator is available. Save or resolve the draft before using First/Next windows; this view does not scan the page."
                : "Linked block reveal is waiting for a current readable document."}
          </p>
          <Button variant="outline" disabled={!current?.()} onClick={() => revealTarget(true)}>
            Reveal loaded target
          </Button>
        </div>
      ) : null}
      {historyNotice ? <p role="status">{historyNotice}</p> : null}
      {bridge ? (
        <p>Local undo covers edits made in this view. Saved undo/redo has separate controls.</p>
      ) : null}
      {notice ? <p role="alert">{notice}</p> : null}
      {bridge && !bridge.controller.editorWindow().completeParents.includes(null) ? (
        <p>
          This window does not include the complete page. Text edits are available; inserting,
          splitting and joining are unavailable.
        </p>
      ) : null}
      {selectedId ? (
        <Button
          variant="outline"
          disabled={!structure || !can(adapter.remove(selectedId))}
          onClick={() => selectedId && run(adapter.remove(selectedId))}
        >
          Delete block
        </Button>
      ) : null}
      <SpaceAtomContext.Provider value={renderChild}>
        <EditorContent
          editor={editor}
          className="min-h-24 whitespace-pre-wrap break-words [&_.tiptap]:outline-none"
        />
      </SpaceAtomContext.Provider>
    </section>
  );
}
function noSubscribe() {
  return () => {};
}
function noNotice() {
  return null;
}

function FormatValue({
  label,
  initial,
  writable,
  command,
  can,
  run,
}: {
  label: string;
  initial: string;
  writable: boolean;
  command: (value: string) => Command;
  can: (command: Command) => boolean;
  run: (command: Command) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(command(value));
      }}
    >
      <label>
        {label}
        <Input
          value={value}
          disabled={!writable}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <Button
        type="submit"
        variant="outline"
        disabled={!can(command(value))}
        onMouseDown={(event) => event.preventDefault()}
      >
        Apply {label.toLowerCase()}
      </Button>
    </form>
  );
}
function LinkValue({
  href,
  hasLink,
  adapter,
  writable,
  can,
  run,
}: {
  href: string;
  hasLink: boolean;
  adapter: SpaceEditorAdapter;
  writable: boolean;
  can: (command: Command) => boolean;
  run: (command: Command) => void;
}) {
  const [value, setValue] = useState(href);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(adapter.setLink(value));
      }}
    >
      <label>
        Link URL
        <Input
          value={value}
          disabled={!writable}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        HTTP, HTTPS or mailto links. Applies to the selected text, or the whole existing link at the
        caret.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="outline"
          disabled={!can(adapter.setLink(value))}
          onMouseDown={(event) => event.preventDefault()}
        >
          {hasLink ? "Apply link" : "Add link"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!can(adapter.removeLink())}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(adapter.removeLink())}
        >
          Remove link
        </Button>
      </div>
    </form>
  );
}
