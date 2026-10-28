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
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import {
  BoldIcon,
  ChevronDownIcon,
  CodeIcon,
  Heading1Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MinusIcon,
  PilcrowIcon,
  QuoteIcon,
  Redo2Icon,
  SquareCodeIcon,
  StrikethroughIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { NodeSelection, type Command } from "@tiptap/pm/state";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";
import {
  SpaceAtomContext,
  SpaceAtomView,
  SpaceMediaView,
  SpaceMediaWritableContext,
} from "./SpaceAtomView";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Separator } from "~/components/ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { SpaceEditorAdapter, type SpaceEditorBatch } from "./adapter";
import { canEditSpaceEditorBlock, spaceDocumentBlocks } from "./document";
import { SpaceImageControls } from "./SpaceImageControls";
import type { SpaceImageUploads } from "@t2code/client-runtime/spaces";
import type { SpaceEditorBridge } from "./editorBridge";
import {
  SpaceMentionContext,
  SpaceMentionControls,
  SpaceMentionView,
} from "./SpaceMentionControls";
import type { SpaceMentionController } from "./mentions";
import "./editor.css";

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
}: {
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
  const [notice, setNotice] = useState<string | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
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
              : extension.name === "spaceMedia" && extension instanceof TiptapNode
                ? extension.extend({ addNodeView: () => ReactNodeViewRenderer(SpaceMediaView) })
                : ["space_page_mention", "space_block_mention"].includes(extension.name) &&
                    extension instanceof TiptapMark
                  ? extension.extend({ addMarkView: () => ReactMarkViewRenderer(SpaceMentionView) })
                  : extension,
          ),
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
  // oxlint-disable-next-line t2code/react-effect-budget -- Synchronize the mounted editor view with the shared document and destination edit permission.
  useEffect(() => {
    if (!editor) return;
    bridge?.setWritable(editable, mediaEditable);
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
  }, [editor, bridge, editable, mediaEditable]);
  useEditorState({ editor, selector: ({ transactionNumber }) => transactionNumber });
  const state = editor?.state ?? null;
  const revealTarget = (focus = false) => {
    if (!editor || !bridge || !targetBlockId || editor.isDestroyed) return;
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
  const document = state?.doc;
  const reveal =
    bridge && state && targetBlockId
      ? bridge.revealBlock(
          state,
          { ...adapter.target, blockId: targetBlockId },
          () => sourceOwner?.current() === true && current?.() === true,
        ).status
      : null;
  // oxlint-disable-next-line t2code/react-effect-budget -- Reveal a current URL/panel block target once in the already loaded PM view without replacing its draft.
  useEffect(() => {
    if (!editor || !bridge || editor.isDestroyed) return;
    if (document && editor.state.doc !== document) return;
    const result = bridge.revealNavigation(
      editor,
      editor.state,
      targetBlockId ? { ...adapter.target, blockId: targetBlockId } : null,
      sourceOwner,
      () => current?.() === true,
    );
    if (result?.transaction && sourceOwner?.current() && current?.())
      editor.view.dispatch(result.transaction);
  }, [adapter, bridge, current, document, editor, sourceOwner, targetBlockId]);
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
  const complete = !bridge || bridge.controller.editorWindow().completeParents.includes(null);
  const turnInto = {
    paragraph: ["Paragraph", PilcrowIcon],
    heading: ["Heading", Heading1Icon],
    quote: ["Quote", QuoteIcon],
    callout: ["Callout", MessageSquareIcon],
    bulleted_item: ["Bullet list", ListIcon],
    numbered_item: ["Numbered list", ListOrderedIcon],
    todo_item: ["To-do", ListTodoIcon],
  } as const;
  const empty = state.doc.childCount === 0;
  const startWriting = () => {
    if (empty && structure && complete) adapter.append()(editor.state, editor.view.dispatch);
  };
  const media = !!selectedId && !!known && ["image", "pdf", "video"].includes(known.type);
  return (
    <section aria-label="Page contents" className="space-y-2" data-space-editor="">
      <div className="flex flex-wrap items-center gap-0.5 rounded-lg border bg-background p-1">
        {(
          [
            ["bold", "Bold", BoldIcon],
            ["italic", "Italic", ItalicIcon],
            ["strike", "Strikethrough", StrikethroughIcon],
            ["code", "Inline code", CodeIcon],
          ] as const
        ).map(([mark, label, Icon]) => (
          <ToolbarIconButton
            key={mark}
            label={label}
            disabled={!writable || !can(adapter.mark(mark))}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(adapter.mark(mark))}
          >
            <Icon />
          </ToolbarIconButton>
        ))}
        <ToolbarIconButton
          label="Link"
          hint="Select text to add a link, or place the caret inside an existing link to edit or remove it."
          aria-disabled={!link}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            linkInput.current?.focus();
            linkInput.current?.select();
          }}
        >
          <LinkIcon />
        </ToolbarIconButton>
        <ToolbarSeparator />
        <ToolbarIconButton
          label="Local undo"
          hint={
            bridge
              ? "Local undo covers edits made in this view. Saved undo/redo has separate controls."
              : undefined
          }
          disabled={!can(adapter.undoLocal())}
          onClick={() => run(adapter.undoLocal())}
        >
          <Undo2Icon />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="Local redo"
          hint={
            bridge
              ? "Local undo covers edits made in this view. Saved undo/redo has separate controls."
              : undefined
          }
          disabled={!can(adapter.redoLocal())}
          onClick={() => run(adapter.redoLocal())}
        >
          <Redo2Icon />
        </ToolbarIconButton>
        <ToolbarSeparator />
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="sm" />}>
            Turn into
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            {(Object.keys(turnInto) as (keyof typeof turnInto)[]).map((type) => {
              const [label, Icon] = turnInto[type];
              return (
                <MenuItem
                  key={type}
                  disabled={!structure || !selectedId || !can(adapter.convert(selectedId, type))}
                  onClick={() => selectedId && run(adapter.convert(selectedId, type))}
                >
                  <Icon />
                  {label}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="sm" />}>
            Insert
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem
              disabled={!structure || !can(adapter.append())}
              onClick={() => run(adapter.append())}
            >
              <PilcrowIcon />
              Add paragraph
            </MenuItem>
            <MenuItem
              disabled={!structure || !can(adapter.append("code"))}
              onClick={() => run(adapter.append("code"))}
            >
              <SquareCodeIcon />
              Add code
            </MenuItem>
            <MenuItem
              disabled={!structure || !can(adapter.append("divider"))}
              onClick={() => run(adapter.append("divider"))}
            >
              <MinusIcon />
              Add divider
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="sm" />}>
            Block
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem
              disabled={!structure || !can(adapter.split())}
              onClick={() => run(adapter.split())}
            >
              Split
            </MenuItem>
            <MenuItem
              disabled={!structure || !can(adapter.joinBackward())}
              onClick={() => run(adapter.joinBackward())}
            >
              Join previous
            </MenuItem>
            {bridge ? (
              <MenuItem
                disabled={
                  !onMoveBlocks ||
                  !structure ||
                  !!bridge.controller.session.structureAvailability() ||
                  !complete
                }
                onClick={() => onMoveBlocks?.(state)}
              >
                Move selected blocks…
              </MenuItem>
            ) : null}
            {selected?.type === "todo_item" && selectedId ? (
              <MenuItem
                disabled={!writable || !can(adapter.toggleTodo(selectedId))}
                onClick={() => run(adapter.toggleTodo(selectedId))}
              >
                Toggle to-do
              </MenuItem>
            ) : null}
            {selectedId ? (
              media ? (
                <MenuItem
                  variant="destructive"
                  disabled={!mediaEditable || !structure || !can(adapter.removeMedia(selectedId))}
                  onClick={() => run(adapter.removeMedia(selectedId))}
                >
                  <Trash2Icon />
                  Remove media block
                </MenuItem>
              ) : (
                <MenuItem
                  variant="destructive"
                  disabled={!structure || !can(adapter.remove(selectedId))}
                  onClick={() => run(adapter.remove(selectedId))}
                >
                  <Trash2Icon />
                  Delete block
                </MenuItem>
              )
            ) : null}
          </MenuPopup>
        </Menu>
        <ToolbarSeparator />
        {images && bridge ? (
          <SpaceImageControls
            owner={images}
            insertion={bridge.imageInsertion(
              () => editor.state,
              editor.view.dispatch,
              () => !editor.isDestroyed && sourceOwner?.current() === true && current?.() === true,
            )}
            current={() => sourceOwner?.current() === true && current?.() === true}
            replacementTarget={media && known ? known.id : null}
          />
        ) : null}
        {bridge && mentions ? (
          <SpaceMentionControls
            owner={mentions}
            available={writable && !!adapter.mentionRange(state)}
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
      </div>
      {known?.type === "heading" || known?.type === "callout" || known?.type === "code" || link ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {known?.type === "heading" ? (
            <div className="flex items-center gap-0.5" role="group" aria-label="Heading level">
              {([1, 2, 3] as const).map((level) => (
                <Button
                  key={level}
                  variant={known.content.level === level ? "outline" : "ghost"}
                  size="sm"
                  aria-label={`Heading ${level}`}
                  aria-pressed={known.content.level === level}
                  disabled={!can(adapter.setHeadingLevel(level))}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run(adapter.setHeadingLevel(level))}
                >
                  H{level}
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
              inputRef={linkInput}
              adapter={adapter}
              writable={writable}
              can={can}
              run={run}
            />
          ) : null}
        </div>
      ) : null}
      {targetBlockId ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <p role="status">
            {reveal === "loaded"
              ? "Linked block is loaded. Its content and draft were retained."
              : reveal === "not-loaded"
                ? "Linked block is not in this draft/window. No target-window locator is available. Save or resolve the draft before using First/Next windows; this view does not scan the page."
                : "Linked block reveal is waiting for a current readable document."}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={!current?.()}
            onClick={() => revealTarget(true)}
          >
            Reveal loaded target
          </Button>
        </div>
      ) : null}
      {historyNotice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {historyNotice}
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="text-sm">
          {notice}
        </p>
      ) : null}
      {!complete ? (
        <p className="text-sm text-muted-foreground">
          This window does not include the complete page. Text edits are available; inserting,
          splitting and joining are unavailable.
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
          <SpaceMediaWritableContext.Provider value={mediaEditable && writable}>
            <div className="relative" onFocus={startWriting}>
              {empty && writable ? (
                <p className="pointer-events-none absolute text-muted-foreground">Start writing…</p>
              ) : null}
              <EditorContent
                editor={editor}
                className="min-h-40 whitespace-pre-wrap break-words [&_.tiptap]:min-h-40 [&_.tiptap]:outline-none"
              />
            </div>
          </SpaceMediaWritableContext.Provider>
        </SpaceMentionContext.Provider>
      </SpaceAtomContext.Provider>
    </section>
  );
}
function ToolbarIconButton({
  label,
  hint,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label" | "render"> & {
  label: string;
  hint?: string | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{hint ?? label}</TooltipPopup>
    </Tooltip>
  );
}

function ToolbarSeparator() {
  return <Separator orientation="vertical" className="mx-1 h-5" />;
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
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(command(value));
      }}
    >
      <label className="flex items-center gap-2">
        {label}
        <Input
          size="sm"
          value={value}
          disabled={!writable}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <Button
        type="submit"
        variant="outline"
        size="sm"
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
  inputRef,
  adapter,
  writable,
  can,
  run,
}: {
  href: string;
  hasLink: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  adapter: SpaceEditorAdapter;
  writable: boolean;
  can: (command: Command) => boolean;
  run: (command: Command) => void;
}) {
  const [value, setValue] = useState(href);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(adapter.setLink(value));
      }}
    >
      <label className="flex items-center gap-2">
        Link URL
        <Input
          ref={inputRef}
          size="sm"
          value={value}
          disabled={!writable}
          aria-description="HTTP, HTTPS or mailto links. Applies to the selected text, or the whole existing link at the caret."
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={!can(adapter.setLink(value))}
        onMouseDown={(event) => event.preventDefault()}
      >
        {hasLink ? "Apply link" : "Add link"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!can(adapter.removeLink())}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => run(adapter.removeLink())}
      >
        Remove link
      </Button>
    </form>
  );
}
