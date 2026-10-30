import {
  EditorContent,
  useEditor,
  useEditorState,
  ReactNodeViewRenderer,
  ReactMarkViewRenderer,
} from "@tiptap/react";
import { toastManager } from "../components/ui/toast";
import { Extension, Node as TiptapNode, Mark as TiptapMark } from "@tiptap/core";
import {
  useEffect,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  BoldIcon,
  ChevronDownIcon,
  CodeIcon,
  EllipsisIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  FileTextIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  ListCollapseIcon,
  ListTodoIcon,
  MessageSquareIcon,
  MinusIcon,
  PilcrowIcon,
  QuoteIcon,
  SquareCodeIcon,
  StrikethroughIcon,
  Trash2Icon,
} from "lucide-react";
import { NodeSelection, Plugin, type Command, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
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

function slashMatch(state: EditorState) {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name === "code") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(before);
  return match ? { from: $from.pos - match[1]!.length - 1, query: match[1]! } : null;
}

type SlashItem = {
  readonly label: string;
  readonly icon: typeof PilcrowIcon;
  readonly keywords: string;
  readonly apply: (id: SpaceBlockId | null) => void;
};

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
}: {
  readonly onCreatePage?: ((blockId: SpaceBlockId | null) => void) | undefined;
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
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  const [linkOpen, setLinkOpen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [slashSel, setSlashSel] = useState({ query: "", index: 0 });
  const [focused, setFocused] = useState(false);
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
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
  // The first render reads canEdit(), so permission must be applied before it, not in the effect.
  bridge?.setWritable(editable, mediaEditable);
  // oxlint-disable-next-line t2code/react-effect-budget -- Synchronize the mounted editor view with the shared document and destination edit permission.
  useEffect(() => {
    if (!editor) return;
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
      if (!command(editor.state, editor.view.dispatch))
        toastManager.add({ type: "error", title: "That action isn't available here" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't apply that change",
        description: error instanceof Error ? error.message : undefined,
      });
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
    toggle: ["Toggle list", ListCollapseIcon],
  } as const;
  const empty = state.doc.childCount === 0;
  const startWriting = () => {
    if (empty && structure && complete) adapter.append()(editor.state, editor.view.dispatch);
  };
  const media = !!selectedId && !!known && ["image", "pdf", "video"].includes(known.type);
  const canSplit = structure && can(adapter.split());
  const canJoin = structure && can(adapter.joinBackward());
  const canMove =
    !!bridge &&
    !!onMoveBlocks &&
    structure &&
    !bridge.controller.session.structureAvailability() &&
    complete;
  const canRemove =
    !!selectedId &&
    structure &&
    (media
      ? mediaEditable && can(adapter.removeMedia(selectedId))
      : can(adapter.remove(selectedId)));
  const moreItems = canSplit || canJoin || canMove || canRemove;
  const box = wrapper?.getBoundingClientRect();
  const place = (pos: number, width: number) => {
    if (!box) return null;
    try {
      const at = editor.view.coordsAtPos(pos);
      return {
        left: Math.max(0, Math.min(at.left - box.left, box.width - width)),
        top: at.top - box.top,
        bottom: at.bottom - box.top,
      };
    } catch {
      return null;
    }
  };
  const { from, to } = state.selection;
  const linkKey = `${from}-${to}`;
  const bubbleAt =
    writable &&
    (focused || turnIntoOpen) &&
    !(state.selection instanceof NodeSelection) &&
    (from !== to || link?.hasLink)
      ? place(from, 320)
      : null;
  const bubble = bubbleAt
    ? bubbleAt.top > 48
      ? { left: bubbleAt.left, top: bubbleAt.top - 6, transform: "translateY(-100%)" }
      : { left: bubbleAt.left, top: bubbleAt.bottom + 6 }
    : undefined;
  const convertTo =
    (type: Parameters<SpaceEditorAdapter["convert"]>[1]) => (id: SpaceBlockId | null) => {
      if (id && selected?.type !== type) run(adapter.convert(id, type));
    };
  const headingTo = (level: 1 | 2 | 3) => (id: SpaceBlockId | null) => {
    if (!id) return;
    run(adapter.convert(id, "heading"));
    try {
      adapter.setHeadingLevel(level)(editor.state, editor.view.dispatch);
    } catch {}
  };
  const allSlashItems: readonly SlashItem[] = [
    {
      label: "Text",
      icon: PilcrowIcon,
      keywords: "paragraph plain",
      apply: convertTo("paragraph"),
    },
    { label: "Heading 1", icon: Heading1Icon, keywords: "h1 title", apply: headingTo(1) },
    { label: "Heading 2", icon: Heading2Icon, keywords: "h2 subtitle", apply: headingTo(2) },
    { label: "Heading 3", icon: Heading3Icon, keywords: "h3", apply: headingTo(3) },
    {
      label: "Bulleted list",
      icon: ListIcon,
      keywords: "bullet ul",
      apply: convertTo("bulleted_item"),
    },
    {
      label: "Numbered list",
      icon: ListOrderedIcon,
      keywords: "ordered ol",
      apply: convertTo("numbered_item"),
    },
    {
      label: "To-do",
      icon: ListTodoIcon,
      keywords: "task checkbox todo",
      apply: convertTo("todo_item"),
    },
    {
      label: "Toggle list",
      icon: ListCollapseIcon,
      keywords: "toggle collapse expand disclosure",
      apply: convertTo("toggle"),
    },
    { label: "Quote", icon: QuoteIcon, keywords: "blockquote", apply: convertTo("quote") },
    { label: "Callout", icon: MessageSquareIcon, keywords: "note", apply: convertTo("callout") },
    {
      label: "Code",
      icon: SquareCodeIcon,
      keywords: "snippet",
      apply: () => run(adapter.placeBlock("code")),
    },
    {
      label: "Divider",
      icon: MinusIcon,
      keywords: "separator hr line",
      apply: () => run(adapter.placeBlock("divider")),
    },
    ...(onCreatePage
      ? [
          {
            label: "Page",
            icon: FileTextIcon,
            keywords: "subpage new child",
            apply: onCreatePage,
          },
        ]
      : []),
  ];
  const slash = writable && structure ? slashMatch(state) : null;
  const slashItems = slash
    ? allSlashItems.filter((item) =>
        `${item.label} ${item.keywords}`.toLowerCase().includes(slash.query.toLowerCase()),
      )
    : [];
  const slashOpen = !!slash && dismissed !== slash.from && slashItems.length > 0;
  const slashIndex =
    slash && slashSel.query === slash.query ? Math.min(slashSel.index, slashItems.length - 1) : 0;
  const slashAt = slashOpen ? place(from, 240) : null;
  const slashMenu = slashAt ? { left: slashAt.left, top: slashAt.bottom + 4 } : undefined;
  const pickSlash = (item: SlashItem) => {
    if (!slash) return;
    editor.view.dispatch(editor.state.tr.delete(slash.from, editor.state.selection.from));
    item.apply(selectedId);
  };
  const onSlashKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "/") setDismissed(null);
    if (!slashOpen || event.nativeEvent.isComposing) return;
    const count = slashItems.length;
    const step = (delta: number) =>
      setSlashSel({ query: slash.query, index: (slashIndex + delta + count) % count });
    if (event.key === "ArrowDown") step(1);
    else if (event.key === "ArrowUp") step(-1);
    else if (event.key === "Enter") pickSlash(slashItems[slashIndex]!);
    else if (event.key === "Escape") setDismissed(slash.from);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <section aria-label="Page contents" className="space-y-2" data-space-editor="">
      <div className="flex flex-wrap items-center justify-end gap-1">
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
        {moreItems || savedHistory ? (
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {canSplit ? <MenuItem onClick={() => run(adapter.split())}>Split</MenuItem> : null}
              {canJoin ? (
                <MenuItem onClick={() => run(adapter.joinBackward())}>Join previous</MenuItem>
              ) : null}
              {canMove ? (
                <MenuItem onClick={() => onMoveBlocks?.(state)}>Move selected blocks…</MenuItem>
              ) : null}
              {canRemove && selectedId ? (
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
      </div>
      {known?.type === "heading" || known?.type === "callout" || known?.type === "code" ? (
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
      {!complete ? (
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
          <SpaceMediaWritableContext.Provider value={mediaEditable && writable}>
            <div
              ref={setWrapper}
              className="relative"
              onFocus={() => {
                setFocused(true);
                startWriting();
              }}
              onBlur={(event) => {
                if (event.currentTarget.contains(event.relatedTarget)) return;
                setFocused(false);
                if (slash) setDismissed(slash.from);
              }}
              onKeyDownCapture={onSlashKey}
            >
              {empty && writable ? (
                <p className="pointer-events-none absolute text-muted-foreground/60">
                  {placeholder}
                </p>
              ) : null}
              <EditorContent
                editor={editor}
                className="min-h-40 whitespace-pre-wrap break-words [&_.tiptap]:min-h-40 [&_.tiptap]:outline-none"
              />
              {bubble ? (
                <div
                  className="absolute z-20 flex w-max max-w-[calc(100%-1rem)] flex-col gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
                  style={bubble}
                  onMouseDown={(event) => {
                    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
                  }}
                >
                  <div className="flex items-center gap-0.5">
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
                        disabled={!can(adapter.mark(mark))}
                        onClick={() => run(adapter.mark(mark))}
                      >
                        <Icon />
                      </ToolbarIconButton>
                    ))}
                    <ToolbarIconButton
                      label="Link"
                      hint="Select text to add a link, or place the caret inside an existing link to edit or remove it."
                      aria-disabled={!link}
                      onClick={() => link && setLinkOpen(linkKey)}
                    >
                      <LinkIcon />
                    </ToolbarIconButton>
                    <Separator orientation="vertical" className="mx-1 h-5" />
                    <Menu open={turnIntoOpen} onOpenChange={setTurnIntoOpen}>
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
                              disabled={
                                !structure || !selectedId || !can(adapter.convert(selectedId, type))
                              }
                              onClick={() => selectedId && run(adapter.convert(selectedId, type))}
                            >
                              <Icon />
                              {label}
                            </MenuItem>
                          );
                        })}
                      </MenuPopup>
                    </Menu>
                  </div>
                  {link && (linkOpen === linkKey || link.hasLink) ? (
                    <LinkValue
                      key={JSON.stringify([selectedId, link.from, link.to, link.href])}
                      href={link.href ?? ""}
                      hasLink={link.hasLink}
                      focus={linkOpen === linkKey}
                      adapter={adapter}
                      writable={writable}
                      can={can}
                      run={run}
                    />
                  ) : null}
                </div>
              ) : null}
              {slashMenu ? (
                <div
                  role="listbox"
                  aria-label="Commands"
                  className="absolute z-20 max-h-72 w-60 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
                  style={slashMenu}
                  onMouseDown={(event) => event.preventDefault()}
                >
                  {slashItems.map((item, index) => (
                    <button
                      key={item.label}
                      type="button"
                      role="option"
                      aria-selected={index === slashIndex}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm aria-selected:bg-accent"
                      onClick={() => pickSlash(item)}
                    >
                      <item.icon className="size-4 text-muted-foreground" />
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
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
      <TooltipPopup side="top">{hint ?? label}</TooltipPopup>
    </Tooltip>
  );
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
  focus,
  adapter,
  writable,
  can,
  run,
}: {
  href: string;
  hasLink: boolean;
  focus: boolean;
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
          autoFocus={focus}
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
