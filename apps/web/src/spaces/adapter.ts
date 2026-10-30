import { Extension, type Extensions } from "@tiptap/core";
import { closeHistory, history, isHistoryTransaction, redo, undo } from "@tiptap/pm/history";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  NodeSelection,
  type EditorState,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { canSplit, AddMarkStep, RemoveMarkStep } from "@tiptap/pm/transform";
import { toggleMark } from "@tiptap/pm/commands";
import { Schema } from "effect";
import {
  copySpaceBlocks,
  mediaAssetId,
  isKnownSpaceBlock,
  isSpaceListItem,
  isSafeSpaceLink,
  joinSpaceTextBlocks,
  splitSpaceTextBlock,
  type SpaceMutation,
} from "@t2code/client-runtime/spaces";
import {
  SpaceBlock,
  SpaceKnownMark,
  type SpaceAssetId,
  type SpaceBlockId,
  type SpacePageTarget,
  type SpaceRichText,
  type SpaceTextColor,
} from "@t2code/contracts/spaces";

import {
  canEditSpaceEditorBlock,
  sameSpaceValue,
  spaceBlockNode,
  spaceDocumentBlocks,
  spaceWindowDocument,
  spaceEditorRuns,
  spaceMentionSpans,
  spaceMentionRangeSafe,
  type SpaceEditorWindow,
} from "./document";
import { richBlockTypes, spaceSchemaExtensions } from "./schema";
import { isSpaceToggleCollapsed, spaceToggleCollapsePlugin } from "./toggleCollapse";

export interface SpaceEditorOptions {
  readonly target: SpacePageTarget;
  readonly window: SpaceEditorWindow;
  readonly maxBlocks: number;
  readonly maxDepth: number;
  readonly maxTextLength: number;
  readonly maxClipboardBytes: number;
  readonly allocateId: () => SpaceBlockId;
  readonly allocateOrder: (gap: {
    readonly parentId: SpaceBlockId | null;
    readonly before: string | null;
    readonly after: string | null;
  }) => string;
  readonly canEdit?: () => boolean;
  readonly canChangeStructure?: () => boolean;
  readonly canUndo?: () => boolean;
  readonly canEditMedia?: () => boolean;
}
export interface SpaceEditorBatch {
  readonly baseRevision: number;
  readonly memberIds: readonly SpaceBlockId[];
  readonly mutations: readonly SpaceMutation[];
}
interface MediaChange {
  readonly before: SpaceBlock | null;
  readonly after: SpaceBlock | null;
}
interface Operation {
  readonly media?: MediaChange;
  readonly history?: boolean;
  readonly merged?: { readonly from: SpaceBlockId; readonly into: SpaceBlockId };
}
interface AdapterState {
  readonly batch: SpaceEditorBatch;
  readonly joins: readonly NonNullable<Operation["merged"]>[];
}
const decodeMentionMark = Schema.decodeOption(SpaceKnownMark, { onExcessProperty: "error" });
const localHistoryDepth = 100;
const clipboardType = "application/x-t2-spaces-blocks+json";
const decodeClipboard = Schema.decodeUnknownSync(
  Schema.Struct({
    source: Schema.Struct({ environmentId: Schema.String, pageId: Schema.String }),
    blocks: Schema.Array(SpaceBlock),
  }),
);

function entries(doc: ProseMirrorNode) {
  const result: { node: ProseMirrorNode; pos: number; block: SpaceBlock }[] = [];
  doc.descendants((node, pos, parent) => {
    const block = node.attrs.block as SpaceBlock | undefined;
    if (block)
      result.push({
        node,
        pos,
        block: {
          ...block,
          parentId: (parent?.attrs.block as SpaceBlock | undefined)?.id ?? block.parentId,
        },
      });
  });
  return result;
}

function mediaIdentity(block: SpaceBlock | null) {
  return block && isKnownSpaceBlock(block)
    ? { ...block, content: { ...block.content, caption: [] } }
    : block;
}

function captionBoundary(doc: ProseMirrorNode, position: number) {
  const point = doc.resolve(position);
  if (point.parent.type.name !== "spaceMedia") return true;
  const text = point.parent.textContent,
    offset = point.parentOffset;
  return !(
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[offset]!)
  );
}

export class SpaceEditorAdapter {
  readonly #options: SpaceEditorOptions;
  readonly #key = new PluginKey<AdapterState>("spaces-window");
  readonly #operation = new PluginKey<Operation>("spaces-operation");
  #members: ReadonlySet<SpaceBlockId>;
  #committed: ReadonlySet<SpaceBlockId>;
  #complete: ReadonlySet<SpaceBlockId | null>;
  #window: SpaceEditorWindow;
  #mediaHistory: readonly MediaChange[] = [];
  readonly document: ProseMirrorNode;

  constructor(options: SpaceEditorOptions) {
    for (const limit of [
      options.maxBlocks,
      options.maxDepth,
      options.maxTextLength,
      options.maxClipboardBytes,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("Editor limits must be positive integers");
    }
    this.#options = options;
    this.#window = options.window;
    this.#members = new Set(options.window.blocks.map((block) => block.id));
    this.#committed = new Set(
      options.window.committedIds ?? options.window.blocks.map((block) => block.id),
    );
    this.#complete = new Set(options.window.completeParents);
    this.document = spaceWindowDocument(options.window, options.maxBlocks, options.maxDepth);
    this.#validate(this.document);
  }

  #validate(doc: ProseMirrorNode) {
    doc.check();
    const blocks = spaceDocumentBlocks(doc);
    spaceWindowDocument(
      { ...this.#window, blocks },
      this.#options.maxBlocks,
      this.#options.maxDepth,
    );
    for (const entry of entries(doc)) {
      if (
        entry.node.type.name !== "spaceAtom" &&
        spaceBlockNode(blocks.find((block) => block.id === entry.block.id)!).type.name !==
          entry.node.type.name
      )
        throw new Error("Unsupported editor content");
    }
    if (blocks.some((block) => JSON.stringify(block.content).length > this.#options.maxTextLength))
      throw new Error("Editor content limit exceeded");
    return blocks;
  }

  #batch(before: ProseMirrorNode, after: ProseMirrorNode, operation?: Operation): SpaceEditorBatch {
    const previous = new Map(spaceDocumentBlocks(before).map((block) => [block.id, block]));
    const next = new Map(this.#validate(after).map((block) => [block.id, block]));
    const mutations: SpaceMutation[] = [];
    for (const [id, block] of next) {
      const old = previous.get(id);
      if (!old) mutations.push({ kind: "insert", block });
      else if (!sameSpaceValue(old, block)) mutations.push({ kind: "replace", block });
    }
    for (const [id] of previous) {
      if (!next.has(id))
        mutations.push({
          kind: "delete",
          blockId: id,
          ...(operation?.merged?.from === id ? { mergedInto: operation.merged.into } : {}),
        });
    }
    return {
      baseRevision: this.#window.revision,
      memberIds: [...this.#members],
      mutations,
    };
  }

  #plugin() {
    return new Plugin<AdapterState>({
      key: this.#key,
      state: {
        init: (_config, state) => ({ batch: this.#batch(state.doc, state.doc), joins: [] }),
        apply: (tr, value) => {
          if (!tr.docChanged) return value;
          const operation = tr.getMeta(this.#operation) as Operation | undefined;
          const merged = operation?.merged;
          if (operation?.media)
            this.#mediaHistory = [
              ...this.#mediaHistory,
              {
                before: mediaIdentity(operation.media.before),
                after: mediaIdentity(operation.media.after),
              },
            ].slice(-localHistoryDepth * 2);
          return {
            batch: this.#batch(tr.before, tr.doc, operation),
            // History replays steps without join metadata; retain bounded targets for redo.
            joins: merged
              ? [...value.joins.filter((join) => join.from !== merged.from), merged].slice(
                  -localHistoryDepth * 2,
                )
              : value.joins,
          };
        },
      },
      filterTransaction: (tr) => {
        if (!tr.docChanged) return true;
        if (this.#options.canEdit?.() === false) return false;
        try {
          const operation = tr.getMeta(this.#operation) as Operation | undefined;
          const localHistory = operation?.history === true && isHistoryTransaction(tr);
          for (const [i, step] of tr.steps.entries()) {
            const doc = tr.docs[i]!;
            let safe = true;
            step.getMap().forEach((from, to) => {
              if (
                !captionBoundary(doc, from) ||
                !captionBoundary(doc, to) ||
                (!localHistory && !spaceMentionRangeSafe(doc, from, to))
              )
                safe = false;
            });
            if (step instanceof AddMarkStep || step instanceof RemoveMarkStep)
              safe &&=
                captionBoundary(doc, step.from) &&
                captionBoundary(doc, step.to) &&
                (localHistory || spaceMentionRangeSafe(doc, step.from, step.to));
            if (!safe) return false;
          }
          const batch = this.#batch(tr.before, tr.doc, operation);
          const before = entries(tr.before);
          const after = entries(tr.doc);
          if (
            !operation &&
            (before.length !== after.length ||
              before.some((entry, i) => {
                const next = after[i];
                return (
                  !next ||
                  !sameSpaceValue(entry.block, next.block) ||
                  entry.node.type !== next.node.type
                );
              }))
          )
            return false;
          if (!operation) {
            const canonicalBefore = new Map(
              spaceDocumentBlocks(tr.before).map((block) => [block.id, block]),
            );
            if (
              batch.mutations.some(
                (mutation) =>
                  mutation.kind !== "replace" ||
                  !sameSpaceValue(
                    { ...canonicalBefore.get(mutation.block.id), content: mutation.block.content },
                    mutation.block,
                  ),
              )
            )
              return false;
          }
          const oldBlocks = new Map(spaceDocumentBlocks(tr.before).map((b) => [b.id, b]));
          const newBlocks = new Map(spaceDocumentBlocks(tr.doc).map((b) => [b.id, b]));
          for (const id of new Set([...oldBlocks.keys(), ...newBlocks.keys()])) {
            const old = oldBlocks.get(id) ?? null,
              next = newBlocks.get(id) ?? null;
            if ((old && mediaAssetId(old)) || (next && mediaAssetId(next))) {
              if (
                !sameSpaceValue(old, next) &&
                ((old && before.find((e) => e.block.id === id)?.node.type.name === "spaceAtom") ||
                  !this.#mediaAllowed(old, next, operation))
              )
                return false;
            }
          }
          for (const entry of before.filter(
            (item) => item.node.type.name === "spaceAtom" && !mediaAssetId(item.block),
          )) {
            const next = after.find((item) => item.block.id === entry.block.id);
            if (!next && entry.block.type === "divider" && canEditSpaceEditorBlock(entry.block))
              continue;
            if (
              !next &&
              !this.#committed.has(entry.block.id) &&
              isKnownSpaceBlock(entry.block) &&
              entry.block.type !== "child_page"
            )
              continue;
            if (
              !next ||
              !sameSpaceValue(entry.block.content, next.block.content) ||
              entry.block.type !== next.block.type ||
              entry.block.version !== next.block.version
            )
              return false;
          }
          return batch.mutations.every(
            (mutation) =>
              mutation.kind !== "replace" ||
              isKnownSpaceBlock(mutation.block) ||
              sameSpaceValue(
                before.find((entry) => entry.block.id === mutation.block.id)?.block,
                mutation.block,
              ),
          );
        } catch {
          return false;
        }
      },
      props: {
        handlePaste: (view, event) => {
          const raw = event.clipboardData?.getData(clipboardType);
          if (raw) {
            try {
              if (new TextEncoder().encode(raw).length > this.#options.maxClipboardBytes)
                return true;
              const value = decodeClipboard(JSON.parse(raw));
              this.pasteBlocks(value.blocks, value.source as SpacePageTarget)(
                view.state,
                view.dispatch,
              );
            } catch {
              /* Reject unsupported clipboard payloads without falling back to lossy HTML. */
            }
            return true;
          }
          const text = event.clipboardData?.getData("text/plain");
          if (text !== undefined) {
            if (
              text.length <= this.#options.maxTextLength &&
              view.state.selection.$from.sameParent(view.state.selection.$to) &&
              view.state.selection.$from.parent.isTextblock
            )
              view.dispatch(view.state.tr.insertText(text));
            return true;
          }
          return true;
        },
        handleTextInput: (view, from, to, text) =>
          from === to && this.#applyShortcut(view, from, text),
        handleDOMEvents: {
          click: (view, event) => {
            const target = event.target;
            if (!(target instanceof HTMLInputElement) || !target.hasAttribute("data-space-todo"))
              return false;
            event.preventDefault();
            const id = target.closest("[data-space-block]")?.getAttribute("data-space-block");
            if (id) this.toggleTodo(id as SpaceBlockId)(view.state, view.dispatch);
            return true;
          },
          copy: (view, event) => {
            const selected = entries(view.state.doc).filter(
              ({ pos, node }) =>
                pos >= view.state.selection.from && pos + node.nodeSize <= view.state.selection.to,
            );
            if (!selected.length) return false;
            event.preventDefault();
            try {
              const blocks = this.copyBlocks(
                view.state,
                selected.map((entry) => entry.block.id),
              );
              event.clipboardData?.setData(
                clipboardType,
                JSON.stringify({ source: this.#options.target, blocks }),
              );
              event.clipboardData?.setData(
                "text/plain",
                view.state.doc.textBetween(
                  view.state.selection.from,
                  view.state.selection.to,
                  "\n",
                ),
              );
            } catch {
              /* Opaque and child-page copies require a later service operation. */
            }
            return true;
          },
          cut: (_view, event) => {
            event.preventDefault();
            return true;
          },
          drop: (_view, event) => {
            event.preventDefault();
            return true;
          },
        },
      },
    });
  }

  get target(): SpacePageTarget {
    return this.#options.target;
  }

  plugins() {
    return [history({ depth: localHistoryDepth }), this.#plugin(), spaceToggleCollapsePlugin()];
  }

  extensions(): Extensions {
    const thisAdapter = this;
    const plugins = this.plugins();
    const split = this.split();
    const join = this.joinBackward();
    const undo = this.undoLocal();
    const redo = this.redoLocal();
    const bold = this.mark("bold"),
      italic = this.mark("italic"),
      underline = this.mark("underline"),
      strike = this.mark("strike"),
      code = this.mark("code");
    return [
      ...spaceSchemaExtensions,
      Extension.create({
        name: "spaceTransactions",
        addProseMirrorPlugins: () => plugins,
        addKeyboardShortcuts() {
          const run = (command: Command) => command(this.editor.state, this.editor.view.dispatch);
          return {
            Enter: () => {
              if (run(thisAdapter.exitEmptyBlock("enter"))) return true;
              if (this.editor.state.selection.$from.parent.type.name === "code")
                this.editor.view.dispatch(this.editor.state.tr.insertText("\n"));
              else run(split);
              return true;
            },
            ArrowLeft: () => run(thisAdapter.mentionBoundary(-1)),
            ArrowRight: () => run(thisAdapter.mentionBoundary(1)),
            Delete: () => run(thisAdapter.mentionBoundary(1, true)),
            Backspace: () => {
              if (run(thisAdapter.mentionBoundary(-1, true))) return true;
              if (run(thisAdapter.exitEmptyBlock("backspace"))) return true;
              if (
                this.editor.state.selection.empty &&
                this.editor.state.selection.$from.parentOffset === 0
              ) {
                run(join);
                return true;
              }
              return false;
            },
            "Mod-b": () => {
              run(bold);
              return true;
            },
            "Mod-i": () => {
              run(italic);
              return true;
            },
            "Mod-u": () => {
              run(underline);
              return true;
            },
            "Mod-Shift-x": () => {
              run(strike);
              return true;
            },
            "Mod-`": () => {
              run(code);
              return true;
            },
            "Mod-Shift-ArrowUp": () => {
              run(thisAdapter.shift(-1));
              return true;
            },
            "Mod-Shift-ArrowDown": () => {
              run(thisAdapter.shift(1));
              return true;
            },
            "Mod-z": () => {
              run(undo);
              return true;
            },
            "Mod-Shift-z": () => {
              run(redo);
              return true;
            },
          };
        },
      }),
    ];
  }

  batch(state: EditorState): SpaceEditorBatch {
    return this.#key.getState(state)!.batch;
  }

  replaceWindow(window: SpaceEditorWindow) {
    if (window.revision !== this.#window.revision) this.clearMediaHistory();
    this.#window = window;
    this.#members = new Set(window.blocks.map((block) => block.id));
    this.#committed = new Set(window.committedIds ?? window.blocks.map((block) => block.id));
    this.#complete = new Set(window.completeParents);
  }

  changes(before: ProseMirrorNode, transactions: readonly Transaction[]): readonly SpaceMutation[] {
    const last = transactions.at(-1);
    if (!last || before.eq(last.doc)) return [];
    const joins = new Map<SpaceBlockId, SpaceBlockId>();
    for (const transaction of transactions) {
      const operation = transaction.getMeta(this.#operation) as Operation | undefined;
      if (operation?.merged) joins.set(operation.merged.from, operation.merged.into);
    }
    return this.#batch(before, last.doc).mutations.map((mutation) => {
      const into = mutation.kind === "delete" ? joins.get(mutation.blockId) : undefined;
      return mutation.kind === "delete" && into ? { ...mutation, mergedInto: into } : mutation;
    });
  }

  planImage(
    state: EditorState,
    assetId: SpaceAssetId,
    kind: "image" | "pdf" | "video" = "image",
  ): SpaceBlock {
    if (
      this.#options.canChangeStructure?.() === false ||
      !this.#isComplete(null, state.doc) ||
      entries(state.doc).length >= this.#options.maxBlocks
    )
      throw new Error("Image insertion requires a current complete root window with capacity");
    const previous = spaceDocumentBlocks(state.doc).findLast((block) => block.parentId === null);
    return {
      id: this.#options.allocateId(),
      parentId: null,
      order: this.#rank(null, previous, undefined),
      type: kind,
      version: 1,
      content: { assetId },
    };
  }
  insertImage(block: SpaceBlock): Command {
    return (state, dispatch) => {
      if (
        this.#options.canChangeStructure?.() === false ||
        !isKnownSpaceBlock(block) ||
        !["image", "pdf", "video"].includes(block.type) ||
        block.parentId !== null ||
        !this.#isComplete(null, state.doc) ||
        entries(state.doc).length >= this.#options.maxBlocks ||
        entries(state.doc).some((e) => e.block.id === block.id)
      )
        return false;
      const previous = spaceDocumentBlocks(state.doc).findLast((b) => b.parentId === null);
      try {
        if (block.order !== this.#rank(null, previous, undefined)) return false;
      } catch {
        return false;
      }
      if (!dispatch) return this.#options.canEdit?.() !== false;
      const at = state.doc.content.size;
      const tr = closeHistory(state.tr).insert(at, spaceBlockNode(block, [], false, state.schema));
      tr.setSelection(NodeSelection.create(tr.doc, at));
      return this.#dispatch(tr, dispatch, { media: { before: null, after: block } });
    };
  }

  append(type: "paragraph" | "code" | "divider" = "paragraph"): Command {
    return (state, dispatch) => {
      if (
        this.#options.canChangeStructure?.() === false ||
        entries(state.doc).length >= this.#options.maxBlocks ||
        !this.#isComplete(null, state.doc)
      )
        return false;
      const previous = spaceDocumentBlocks(state.doc).findLast((block) => block.parentId === null);
      let order: string;
      try {
        order = this.#rank(null, previous, undefined);
      } catch {
        return false;
      }
      if (!dispatch) return true;
      const block: SpaceBlock = {
        id: this.#options.allocateId(),
        parentId: null,
        order,
        type,
        version: 1,
        content:
          type === "paragraph" ? { runs: [] } : type === "code" ? { text: "", language: "" } : {},
      };
      const at = state.doc.content.size;
      const tr = state.tr.insert(at, spaceBlockNode(block, [], false, state.schema));
      tr.setSelection(
        type === "divider"
          ? NodeSelection.create(tr.doc, at)
          : TextSelection.create(tr.doc, at + 1),
      );
      return this.#dispatch(tr, dispatch);
    };
  }

  #ownerOf(state: EditorState) {
    const { $from, empty } = state.selection;
    if (!empty || !$from.parent.isTextblock) return null;
    const node =
      $from.parent.type.name === "spaceBody" ? $from.node($from.depth - 1) : $from.parent;
    const id = (node.attrs.block as SpaceBlock | undefined)?.id;
    const entry = id ? entries(state.doc).find((item) => item.block.id === id) : undefined;
    return entry && entry.node === node ? entry : null;
  }

  #toParagraph(id: SpaceBlockId): Command {
    const convert = this.convert(id, "paragraph");
    return (state, dispatch) =>
      convert(
        state,
        dispatch &&
          ((tr) => {
            const pos = entries(tr.doc).find((item) => item.block.id === id)?.pos;
            if (pos !== undefined) tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
            dispatch(tr);
          }),
      );
  }

  exitEmptyBlock(key: "enter" | "backspace"): Command {
    return (state, dispatch) => {
      const owner = this.#ownerOf(state);
      if (!owner || state.selection.$from.parent.content.size > 0) return false;
      const types =
        key === "enter"
          ? ["quote", "bulleted_item", "numbered_item", "todo_item", "toggle"]
          : [
              "heading",
              "quote",
              "callout",
              "bulleted_item",
              "numbered_item",
              "todo_item",
              "toggle",
            ];
      return types.includes(owner.block.type)
        ? this.#toParagraph(owner.block.id)(state, dispatch)
        : false;
    };
  }

  placeBlock(type: "code" | "divider"): Command {
    return (state, dispatch) => {
      if (
        this.#options.canChangeStructure?.() === false ||
        entries(state.doc).length >= this.#options.maxBlocks - 1 ||
        !this.#isComplete(null, state.doc)
      )
        return false;
      const $pos = state.doc.resolve(state.selection.from);
      const pos = $pos.depth >= 1 ? $pos.before(1) : $pos.pos;
      const top = entries(state.doc).find(
        (item) => item.pos === pos && item.block.parentId === null,
      );
      if (!top) return this.append(type)(state, dispatch);
      const roots = spaceDocumentBlocks(state.doc).filter((item) => item.parentId === null);
      const index = roots.findIndex((item) => item.id === top.block.id);
      const following = roots[index + 1];
      const replace =
        top.block.type === "paragraph" && top.node.textContent === "" && top.node.childCount === 0;
      let order: string;
      try {
        order = replace ? top.block.order : this.#rank(null, top.block, following);
      } catch {
        return false;
      }
      const block: SpaceBlock = {
        id: replace ? top.block.id : this.#options.allocateId(),
        parentId: null,
        order,
        type,
        version: 1,
        content: type === "code" ? { text: "", language: "" } : {},
      };
      let tail: SpaceBlock | null = null;
      if (type === "divider" && !following) {
        try {
          tail = {
            id: this.#options.allocateId(),
            parentId: null,
            order: this.#rank(null, block, undefined),
            type: "paragraph",
            version: 1,
            content: { runs: [] },
          };
        } catch {
          return false;
        }
      }
      if (!dispatch) return true;
      const nodes = [spaceBlockNode(block, [], false, state.schema)];
      if (tail) nodes.push(spaceBlockNode(tail, [], false, state.schema));
      const from = replace ? top.pos : top.pos + top.node.nodeSize;
      const tr = state.tr.replaceWith(from, replace ? top.pos + top.node.nodeSize : from, nodes);
      tr.setSelection(
        type === "code"
          ? TextSelection.create(tr.doc, from + 1)
          : TextSelection.near(tr.doc.resolve(from + nodes[0]!.nodeSize), 1),
      );
      return this.#dispatch(tr, dispatch);
    };
  }

  #applyShortcut(view: EditorView, from: number, text: string) {
    const state = view.state;
    const owner = this.#ownerOf(state);
    if (!owner || owner.block.type !== "paragraph" || owner.node.type.name !== "paragraph")
      return false;
    const before = state.doc
      .resolve(from)
      .parent.textBetween(0, state.doc.resolve(from).parentOffset);
    const trigger = text === "`" ? (before === "``" ? "```" : null) : text === " " ? before : null;
    if (trigger === null) return false;
    const table: Partial<
      Record<
        string,
        "bulleted_item" | "numbered_item" | "todo_item" | "toggle" | "quote" | "heading" | "code"
      >
    > = {
      "-": "bulleted_item",
      "*": "bulleted_item",
      "1.": "numbered_item",
      "[]": "todo_item",
      ">": "quote",
      ">>": "toggle",
      "#": "heading",
      "##": "heading",
      "###": "heading",
      "```": "code",
    };
    const target = table[trigger];
    if (!target || state.doc.resolve(from).parentOffset !== before.length) return false;
    const stripped = state.apply(state.tr.delete(from - before.length, from));
    if (stripped === state) return false;
    const id = owner.block.id;
    const command = target === "code" ? this.placeBlock("code") : this.convert(id, target);
    if (!command(stripped)) return false;
    view.dispatch(state.tr.delete(from - before.length, from));
    command(view.state, view.dispatch);
    if (target === "heading" && trigger.length > 1)
      this.setHeadingLevel(trigger.length as 2 | 3)(view.state, view.dispatch);
    const pos = entries(view.state.doc).find((item) => item.block.id === id)?.pos;
    if (pos !== undefined && target !== "code")
      view.dispatch(
        view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))),
      );
    return true;
  }

  mark(type: "bold" | "italic" | "underline" | "strike" | "code"): Command {
    return (state, dispatch) =>
      this.#markAllowed(state) &&
      toggleMark(state.schema.marks[`space_${type}`]!, { value: { type, version: 1 } })(
        state,
        dispatch,
      );
  }

  textStyle(type: "color" | "highlight", value: SpaceTextColor | null): Command {
    return (state, dispatch) => {
      const markType = state.schema.marks[`space_${type}`]!;
      const { from, to, empty } = state.selection;
      if (empty || !this.#markAllowed(state)) return false;
      if (dispatch)
        dispatch(
          (value
            ? state.tr.addMark(from, to, markType.create({ value: { type, version: 1, value } }))
            : state.tr.removeMark(from, to, markType)
          ).scrollIntoView(),
        );
      return true;
    };
  }

  #markAllowed(state: EditorState) {
    return (
      this.#options.canEdit?.() !== false &&
      captionBoundary(state.doc, state.selection.from) &&
      captionBoundary(state.doc, state.selection.to) &&
      this.#mediaSelectionAllowed(state) &&
      spaceMentionRangeSafe(state.doc, state.selection.from, state.selection.to)
    );
  }

  #mediaSelectionAllowed(state: EditorState) {
    let allowed = true;
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
      if (node.type.name === "spaceMedia" && this.#options.canEditMedia?.() !== true)
        allowed = false;
    });
    return allowed;
  }
  mentionRange(state: EditorState) {
    const entry = this.#selectedEntry(state),
      selection = state.selection;
    if (
      !entry ||
      !(selection instanceof TextSelection) ||
      !spaceEditorRuns(entry.block) ||
      !selection.$from.sameParent(selection.$to) ||
      !spaceMentionRangeSafe(state.doc, selection.from, selection.to)
    )
      return null;
    const text = selection.$from.parent.textContent;
    for (const offset of [selection.$from.parentOffset, selection.$to.parentOffset])
      if (
        offset > 0 &&
        offset < text.length &&
        /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
        /[\uDC00-\uDFFF]/.test(text[offset]!)
      )
        return null;
    return { blockId: entry.block.id, from: selection.from, to: selection.to };
  }
  insertMention(mark: import("./mentions").SpaceMentionMark, label: string): Command {
    return (state, dispatch) => {
      const range = this.mentionRange(state);
      const decoded = decodeMentionMark(mark);
      if (
        !range ||
        decoded._tag !== "Some" ||
        !["page_mention", "block_mention"].includes(mark.type) ||
        mark.target.environmentId !== this.target.environmentId ||
        !label ||
        label.length > 512 ||
        new TextEncoder().encode(label).byteLength > 2048
      )
        return false;
      const marks = (state.storedMarks ?? state.selection.$from.marks()).filter(
        (m) => !["space_page_mention", "space_block_mention"].includes(m.type.name),
      );
      const node = state.schema.text(label, [
        ...marks,
        state.schema.marks[`space_${mark.type}`]!.create({ value: mark }),
      ]);
      const tr = closeHistory(state.tr).replaceWith(range.from, range.to, node);
      tr.setSelection(TextSelection.create(tr.doc, range.from + label.length));
      return this.#dispatch(tr, dispatch);
    };
  }
  mentionBoundary(direction: -1 | 1, remove = false): Command {
    return (state, dispatch) => {
      if (!state.selection.empty) return false;
      const at = state.selection.from;
      const span = spaceMentionSpans(state.doc).find((s) =>
        direction < 0 ? s.from < at && at <= s.to : s.from <= at && at < s.to,
      );
      if (!span || (remove && this.#options.canEdit?.() === false)) return false;
      if (!dispatch) return true;
      if (remove)
        return this.#dispatch(closeHistory(state.tr).delete(span.from, span.to), dispatch);
      dispatch(
        state.tr
          .setSelection(TextSelection.create(state.doc, direction < 0 ? span.from : span.to))
          .setMeta("addToHistory", false),
      );
      return true;
    };
  }
  #selectedEntry(state: EditorState) {
    if (this.#options.canEdit?.() === false) return null;
    let id: SpaceBlockId | undefined;
    if (state.selection instanceof NodeSelection) id = state.selection.node.attrs.block?.id;
    else {
      if (!state.selection.$from.sameParent(state.selection.$to)) return null;
      for (let depth = state.selection.$from.depth; depth > 0; depth--) {
        id = state.selection.$from.node(depth).attrs.block?.id;
        if (id) break;
      }
    }
    const entry = entries(state.doc).find((item) => item.block.id === id);
    const block = spaceDocumentBlocks(state.doc).find((item) => item.id === id);
    return entry &&
      block &&
      entry.node.type.name !== "spaceAtom" &&
      (!mediaAssetId(block) || this.#options.canEditMedia?.() === true) &&
      canEditSpaceEditorBlock(block)
      ? { ...entry, block }
      : null;
  }
  #attribute(
    type: "heading" | "callout" | "code",
    key: "level" | "icon" | "language",
    value: string | number,
  ): Command {
    return (state, dispatch) => {
      const entry = this.#selectedEntry(state);
      if (
        !entry ||
        !isKnownSpaceBlock(entry.block) ||
        entry.block.type !== type ||
        Reflect.get(entry.block.content, key) === value
      )
        return false;
      return this.#dispatch(
        state.tr.setNodeMarkup(entry.pos, undefined, {
          block: { ...entry.block, content: { ...entry.block.content, [key]: value } },
        }),
        dispatch,
      );
    };
  }
  setHeadingLevel(level: 1 | 2 | 3): Command {
    return (state, dispatch) =>
      [1, 2, 3].includes(level) && this.#attribute("heading", "level", level)(state, dispatch);
  }
  setCalloutIcon(icon: string): Command {
    return this.#attribute("callout", "icon", icon);
  }
  setCodeLanguage(language: string): Command {
    return this.#attribute("code", "language", language);
  }

  linkSelection(state: EditorState) {
    const entry = this.#selectedEntry(state),
      selection = state.selection;
    if (
      !entry ||
      !(selection instanceof TextSelection) ||
      !isKnownSpaceBlock(entry.block) ||
      spaceEditorRuns(entry.block) === null
    )
      return null;
    const runs = spaceEditorRuns(entry.block)!;
    let offset = 0;
    const segments = runs.flatMap((run) => {
      const from = offset;
      offset += run.text.length;
      return run.text
        ? [
            {
              from,
              to: offset,
              href: run.marks.find((mark) => mark.type === "link")?.href as string | undefined,
            },
          ]
        : [];
    });
    let from = selection.$from.parentOffset,
      to = selection.$to.parentOffset;
    const text = runs.map((run) => run.text).join("");
    const splitsPair = (n: number) =>
      n > 0 &&
      n < text.length &&
      /[\uD800-\uDBFF]/.test(text[n - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[n]!);
    if ([from, to].some(splitsPair)) return null;
    if (selection.empty) {
      const index = segments.findIndex((segment) => segment.from <= from && from < segment.to);
      const at = index < 0 && from === text.length ? segments.length - 1 : index;
      const selected = segments[at];
      if (!selected?.href) return null;
      let left = at,
        right = at;
      while (left > 0 && segments[left - 1]!.href === selected.href) left--;
      while (right + 1 < segments.length && segments[right + 1]!.href === selected.href) right++;
      from = segments[left]!.from;
      to = segments[right]!.to;
    }
    if ([from, to].some(splitsPair)) return null;
    const selected = segments.filter((segment) => segment.from < to && segment.to > from);
    const href = selected[0]?.href;
    const start = selection.$from.start();
    if (!spaceMentionRangeSafe(state.doc, start + from, start + to)) return null;
    return {
      from: start + from,
      to: start + to,
      href: href && selected.every((segment) => segment.href === href) ? href : null,
      hasLink: selected.some((segment) => !!segment.href),
    };
  }
  setLink(href: string): Command {
    return (state, dispatch) => isSafeSpaceLink(href) && this.#link(href)(state, dispatch);
  }
  removeLink(): Command {
    return this.#link(null);
  }
  #link(href: string | null): Command {
    return (state, dispatch) => {
      const range = this.linkSelection(state),
        entry = this.#selectedEntry(state);
      if (
        !range ||
        !entry ||
        !isKnownSpaceBlock(entry.block) ||
        spaceEditorRuns(entry.block) === null ||
        (!href && !range.hasLink) ||
        (href !== null && range.href === href)
      )
        return false;
      const start = state.selection.$from.start(),
        from = range.from - start,
        to = range.to - start;
      let offset = 0;
      const runs: SpaceRichText = spaceEditorRuns(entry.block)!.flatMap((run) => {
        const a = Math.max(0, from - offset),
          b = Math.min(run.text.length, to - offset);
        offset += run.text.length;
        if (a >= b) return [run];
        const marks = run.marks.flatMap((mark) =>
          mark.type === "link" ? (href ? [{ ...mark, href }] : []) : [mark],
        );
        if (href && !run.marks.some((mark) => mark.type === "link"))
          marks.push({ type: "link", version: 1, href });
        return [
          ...(a > 0 ? [{ ...run, text: run.text.slice(0, a) }] : []),
          { ...run, text: run.text.slice(a, b), marks },
          ...(b < run.text.length ? [{ ...run, text: run.text.slice(b) }] : []),
        ];
      });
      const tr = state.tr.removeMark(range.from, range.to, state.schema.marks.space_link!);
      if (href)
        tr.addMark(
          range.from,
          range.to,
          state.schema.marks.space_link!.create({ value: { type: "link", version: 1, href } }),
        );
      tr.setNodeMarkup(entry.pos, undefined, {
        block: {
          ...entry.block,
          content: {
            ...entry.block.content,
            [mediaAssetId(entry.block) ? "caption" : "runs"]: runs,
          },
        },
      });
      return this.#dispatch(tr, dispatch);
    };
  }

  toggleTodo(id: SpaceBlockId): Command {
    return (state, dispatch) => {
      const entry = entries(state.doc).find((item) => item.block.id === id);
      const block = spaceDocumentBlocks(state.doc).find((item) => item.id === id);
      if (
        !entry ||
        entry.node.type.name === "spaceAtom" ||
        !block ||
        !isKnownSpaceBlock(block) ||
        block.type !== "todo_item"
      )
        return false;
      return this.#dispatch(
        state.tr.setNodeMarkup(entry.pos, undefined, {
          block: { ...block, content: { ...block.content, checked: !block.content.checked } },
        }),
        dispatch,
      );
    };
  }

  #mediaAllowed(before: SpaceBlock | null, after: SpaceBlock | null, operation?: Operation) {
    const supported = (b: SpaceBlock | null) =>
      !b || (!!mediaAssetId(b) && canEditSpaceEditorBlock(b));
    if (!supported(before) || !supported(after)) return false;
    if (after) {
      const text = spaceEditorRuns(after)!
        .map((run) => run.text)
        .join("");
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = text.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
      }
    }
    if (before && !after && !this.#committed.has(before.id)) return true;
    if (this.#options.canEditMedia?.() !== true && !(operation?.media?.before === null))
      return false;
    if (before && after && sameSpaceValue(mediaIdentity(before), mediaIdentity(after))) return true;
    const matches = (change: MediaChange) =>
      sameSpaceValue(change.before, before) && sameSpaceValue(change.after, after);
    const historyMatches = (change: MediaChange) =>
      sameSpaceValue(mediaIdentity(change.before), mediaIdentity(before)) &&
      sameSpaceValue(mediaIdentity(change.after), mediaIdentity(after));
    return (
      (!!operation?.media && matches(operation.media)) ||
      (!!operation?.history &&
        this.#mediaHistory.some(
          (change) =>
            historyMatches(change) ||
            historyMatches({ before: change.after, after: change.before }),
        ))
    );
  }
  clearMediaHistory() {
    this.#mediaHistory = [];
  }
  mediaTarget(state: EditorState, id: SpaceBlockId) {
    const entry = entries(state.doc).find((e) => e.block.id === id);
    const block = spaceDocumentBlocks(state.doc).find((b) => b.id === id);
    return entry?.node.type.name === "spaceMedia" &&
      block &&
      mediaAssetId(block) &&
      canEditSpaceEditorBlock(block)
      ? block
      : null;
  }
  replaceMedia(before: SpaceBlock, after: SpaceBlock): Command {
    return (state, dispatch) => {
      const entry = entries(state.doc).find((e) => e.block.id === before.id);
      const actual = this.mediaTarget(state, before.id);
      if (
        this.#options.canChangeStructure?.() === false ||
        this.#options.canEditMedia?.() !== true ||
        !entry ||
        !sameSpaceValue(actual, before) ||
        !mediaAssetId(before) ||
        !mediaAssetId(after) ||
        !canEditSpaceEditorBlock(before) ||
        !canEditSpaceEditorBlock(after) ||
        !isKnownSpaceBlock(before) ||
        !isKnownSpaceBlock(after) ||
        !sameSpaceValue(
          {
            ...before,
            type: after.type,
            content: {
              ...before.content,
              assetId: "assetId" in after.content ? after.content.assetId : null,
            },
          },
          after,
        )
      )
        return false;
      return this.#dispatch(
        closeHistory(state.tr).replaceWith(
          entry.pos,
          entry.pos + entry.node.nodeSize,
          spaceBlockNode(after, [], false, state.schema),
        ),
        dispatch,
        { media: { before, after } },
      );
    };
  }
  removeMedia(id: SpaceBlockId): Command {
    return (state, dispatch) => {
      const entry = entries(state.doc).find((e) => e.block.id === id);
      const all = spaceDocumentBlocks(state.doc),
        before = this.mediaTarget(state, id);
      if (
        !entry ||
        !before ||
        !mediaAssetId(before) ||
        !canEditSpaceEditorBlock(before) ||
        this.#options.canEditMedia?.() !== true ||
        this.#options.canChangeStructure?.() === false ||
        !this.#complete.has(null) ||
        all.some((b) => b.parentId === id)
      )
        return false;
      return this.#dispatch(
        closeHistory(state.tr).delete(entry.pos, entry.pos + entry.node.nodeSize),
        dispatch,
        { media: { before, after: null } },
      );
    };
  }

  remove(id: SpaceBlockId): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
      const entry = entries(state.doc).find((item) => item.block.id === id);
      if (
        !entry ||
        (mediaAssetId(entry.block) !== null && this.#committed.has(id)) ||
        (entry.node.type.name === "spaceAtom" &&
          entry.block.type !== "divider" &&
          !(
            ["image", "pdf", "video"].includes(entry.block.type) &&
            isKnownSpaceBlock(entry.block) &&
            !this.#committed.has(id)
          )) ||
        !this.#isComplete(entry.block.parentId, state.doc) ||
        !this.#subtreeComplete(entry.node, state.doc)
      )
        return false;
      const subtree = entries(state.schema.nodes.doc!.create(null, [entry.node]));
      if (
        subtree.some(
          (item) =>
            !canEditSpaceEditorBlock(item.block) ||
            (["child_page", "image", "pdf", "video"].includes(item.block.type) &&
              !(
                ["image", "pdf", "video"].includes(item.block.type) &&
                !this.#committed.has(item.block.id)
              )),
        )
      )
        return false;
      if (!dispatch) return this.#options.canEdit?.() !== false;
      return this.#dispatch(state.tr.delete(entry.pos, entry.pos + entry.node.nodeSize), dispatch);
    };
  }

  #dispatch(tr: Transaction, dispatch?: (tr: Transaction) => void, operation: Operation = {}) {
    if (this.#options.canEdit?.() === false) return false;
    tr.setMeta(this.#operation, operation);
    try {
      this.#validate(tr.doc);
    } catch {
      return false;
    }
    closeHistory(tr);
    dispatch?.(tr);
    return true;
  }

  #isComplete(parent: SpaceBlockId | null, doc: ProseMirrorNode) {
    if (this.#complete.has(parent)) return true;
    if (parent === null || !entries(doc).some((entry) => entry.block.id === parent)) return false;
    const original = this.#window.blocks.find((block) => block.id === parent);
    return !original || !isSpaceListItem(original);
  }
  #subtreeComplete(node: ProseMirrorNode, doc: ProseMirrorNode): boolean {
    return entries(node.type.schema.nodes.doc!.create(null, [node])).every(
      ({ block }) => !isSpaceListItem(block) || this.#isComplete(block.id, doc),
    );
  }
  #rank(
    parentId: SpaceBlockId | null,
    before: SpaceBlock | undefined,
    after: SpaceBlock | undefined,
  ) {
    const order = this.#options.allocateOrder({
      parentId,
      before: before?.order ?? null,
      after: after?.order ?? null,
    });
    if (!order || order === before?.order || order === after?.order)
      throw new Error("Order allocation failed");
    return order;
  }

  split(): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
      if (!spaceMentionRangeSafe(state.doc, state.selection.from, state.selection.to)) return false;
      const { $from, $to, empty } = state.selection;
      if (!empty || !$from.sameParent($to)) return false;
      const depth = $from.parent.type.name === "spaceBody" ? $from.depth - 1 : $from.depth;
      if (depth < 1) return false;
      const node = $from.node(depth);
      const blocks = spaceDocumentBlocks(state.doc);
      const block = blocks.find(
        (item) => item.id === (node.attrs.block as SpaceBlock | undefined)?.id,
      );
      if (
        !block ||
        blocks.length >= this.#options.maxBlocks ||
        !richBlockTypes.includes(node.type.name as (typeof richBlockTypes)[number]) ||
        !this.#isComplete(block.parentId, state.doc) ||
        !this.#subtreeComplete(node, state.doc)
      )
        return false;
      if (
        block.type === "toggle" &&
        $from.parent.type.name === "spaceBody" &&
        $from.parentOffset === $from.parent.content.size &&
        !isSpaceToggleCollapsed(state, block.id)
      ) {
        const firstChild = blocks.find((item) => item.parentId === block.id);
        let childOrder: string;
        try {
          childOrder = this.#rank(block.id, undefined, firstChild);
        } catch {
          return false;
        }
        if (!dispatch) return true;
        const child: SpaceBlock = {
          id: this.#options.allocateId(),
          parentId: block.id,
          order: childOrder,
          type: "paragraph",
          version: 1,
          content: { runs: [] },
        };
        const at = $from.after();
        const tr = state.tr.insert(at, spaceBlockNode(child, [], false, state.schema));
        tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
        return this.#dispatch(tr, dispatch);
      }
      const pos = $from.before(depth);
      const siblings = blocks.filter((item) => item.parentId === block.parentId);
      const sibling = siblings[siblings.findIndex((item) => item.id === block.id) + 1];
      const id = dispatch ? this.#options.allocateId() : null;
      let order: string;
      try {
        order = this.#rank(block.parentId, block, sibling);
      } catch {
        return false;
      }
      if (!dispatch) return true;
      const next = { id: id!, order };
      if (entries(state.doc).some((entry) => entry.block.id === next.id)) return false;
      const [first, second] = splitSpaceTextBlock(block, $from.parentOffset, next);
      const splitDepth = $from.parent.type.name === "spaceBody" ? 2 : 1;
      if (!canSplit(state.doc, $from.pos, splitDepth)) return false;
      const tr = state.tr.split($from.pos, splitDepth);
      tr.setNodeMarkup(pos, undefined, { block: first });
      const nextPos = tr.mapping.map($from.pos, 1) - (splitDepth === 2 ? 2 : 1);
      tr.setNodeMarkup(nextPos, state.schema.nodes[second.type], { block: second });
      const created = tr.doc.nodeAt(nextPos);
      if (block.type === "toggle" && created && created.childCount > 1) {
        const rest = created.content.cut(created.firstChild!.nodeSize);
        tr.delete(nextPos + 1 + created.firstChild!.nodeSize, nextPos + created.nodeSize - 1);
        tr.insert(nextPos - 1, rest);
      }
      return this.#dispatch(tr, dispatch);
    };
  }

  joinBackward(): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
      if (!spaceMentionRangeSafe(state.doc, state.selection.from, state.selection.to)) return false;
      const { $from, empty } = state.selection;
      if (!empty || $from.parentOffset !== 0 || !$from.parent.attrs.block) return false;
      const secondNode = $from.parent;
      const firstNode = $from.nodeBefore;
      const boundary = $from.before();
      const firstEntry = entries(state.doc).find(
        (entry) => entry.pos + entry.node.nodeSize === boundary,
      );
      if (
        !firstEntry ||
        firstNode ||
        firstEntry.node.type.name !== secondNode.type.name ||
        !richBlockTypes.includes(secondNode.type.name as (typeof richBlockTypes)[number]) ||
        !firstEntry.node.isTextblock ||
        !secondNode.isTextblock
      )
        return false;
      const blocks = spaceDocumentBlocks(state.doc);
      const first = blocks.find((block) => block.id === firstEntry.block.id)!;
      const second = blocks.find((block) => block.id === (secondNode.attrs.block as SpaceBlock).id);
      if (
        !second ||
        first.parentId !== second.parentId ||
        !this.#isComplete(second.parentId, state.doc)
      )
        return false;
      const joined = joinSpaceTextBlocks(first, second);
      const tr = state.tr
        .join(boundary)
        .setNodeMarkup(firstEntry.pos, undefined, { block: joined.block });
      return this.#dispatch(tr, dispatch, { merged: { from: second.id, into: first.id } });
    };
  }

  convert(
    id: SpaceBlockId,
    type:
      | "paragraph"
      | "heading"
      | "quote"
      | "callout"
      | "bulleted_item"
      | "numbered_item"
      | "todo_item"
      | "toggle",
  ): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
      const entry = entries(state.doc).find((item) => item.block.id === id);
      const block = spaceDocumentBlocks(state.doc).find((item) => item.id === id);
      const targetIsList = ["bulleted_item", "numbered_item", "todo_item", "toggle"].includes(type);
      if (
        !entry ||
        !block ||
        !isKnownSpaceBlock(block) ||
        !("runs" in block.content) ||
        block.type === type ||
        entry.node.type.name === "spaceAtom" ||
        (isSpaceListItem(block) &&
          !targetIsList &&
          (entry.node.childCount > 1 || !this.#isComplete(id, state.doc)))
      )
        return false;
      const knownKeys = new Set([
        "runs",
        ...(block.type === "heading"
          ? ["level"]
          : block.type === "todo_item"
            ? ["checked"]
            : block.type === "callout"
              ? ["icon"]
              : []),
      ]);
      if (Object.keys(block.content).some((key) => !knownKeys.has(key))) return false;
      if (!dispatch) return this.#options.canEdit?.() !== false;
      const content = {
        runs: block.content.runs,
        ...(type === "heading"
          ? { level: 1 }
          : type === "callout"
            ? { icon: "💡" }
            : type === "todo_item"
              ? { checked: false }
              : {}),
      };
      const next = { ...block, type, content };
      const children: ProseMirrorNode[] = [];
      if (isSpaceListItem(block) && targetIsList)
        entry.node.forEach((child, _offset, index) => {
          if (index > 0) children.push(child);
        });
      return this.#dispatch(
        state.tr.replaceWith(
          entry.pos,
          entry.pos + entry.node.nodeSize,
          spaceBlockNode(next, children, false, state.schema),
        ),
        dispatch,
      );
    };
  }

  move(
    id: SpaceBlockId,
    parentId: SpaceBlockId | null,
    beforeId: SpaceBlockId | null = null,
  ): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
      const all = entries(state.doc);
      const entry = all.find((item) => item.block.id === id);
      const parent = parentId === null ? undefined : all.find((item) => item.block.id === parentId);
      if (
        !entry ||
        !canEditSpaceEditorBlock(entry.block) ||
        mediaAssetId(entry.block) !== null ||
        (entry.node.type.name === "spaceAtom" &&
          (isSpaceListItem(entry.block) ||
            spaceBlockNode(entry.block).type.name !== "spaceAtom")) ||
        !this.#isComplete(entry.block.parentId, state.doc) ||
        !this.#isComplete(parentId, state.doc) ||
        !this.#subtreeComplete(entry.node, state.doc) ||
        (parentId !== null &&
          (!parent || !isSpaceListItem(parent.block) || parent.node.type.name === "spaceAtom"))
      )
        return false;
      const descendants = new Set(
        entries(state.schema.nodes.doc!.create(null, [entry.node])).map((item) => item.block.id),
      );
      if (
        (parentId !== null && descendants.has(parentId)) ||
        (beforeId !== null && descendants.has(beforeId))
      )
        return false;
      const siblings = all.filter(
        (item) => item.block.parentId === parentId && !descendants.has(item.block.id),
      );
      const index =
        beforeId === null
          ? siblings.length
          : siblings.findIndex((item) => item.block.id === beforeId);
      if (index < 0) return false;
      if (!dispatch) return this.#options.canEdit?.() !== false;
      const before = siblings[index - 1];
      const after = siblings[index];
      const block = spaceDocumentBlocks(state.doc).find((item) => item.id === id)!;
      let order: string;
      try {
        order = this.#rank(parentId, before?.block, after?.block);
      } catch {
        return false;
      }
      const moved = entry.node.type.create(
        { block: { ...block, parentId, order } },
        entry.node.content,
      );
      const insertAt =
        after?.pos ?? (parent ? parent.pos + parent.node.nodeSize - 1 : state.doc.content.size);
      const tr = state.tr.delete(entry.pos, entry.pos + entry.node.nodeSize);
      tr.insert(tr.mapping.map(insertAt), moved);
      return this.#dispatch(tr, dispatch);
    };
  }

  shift(direction: -1 | 1, id?: SpaceBlockId): Command {
    return (state, dispatch) => {
      const all = entries(state.doc);
      const selection = state.selection;
      let target = id;
      if (!target && selection instanceof NodeSelection)
        target = selection.node.attrs.block?.id as SpaceBlockId | undefined;
      for (let depth = selection.$from.depth; !target && depth > 0; depth--)
        target = selection.$from.node(depth).attrs.block?.id as SpaceBlockId | undefined;
      const entry = all.find((item) => item.block.id === target);
      if (!entry) return false;
      const siblings = all.filter((item) => item.block.parentId === entry.block.parentId);
      const index = siblings.findIndex((item) => item === entry);
      const beforeId =
        direction < 0 ? siblings[index - 1]?.block.id : (siblings[index + 2]?.block.id ?? null);
      if (beforeId === undefined || !siblings[index + direction]) return false;
      const move = this.move(entry.block.id, entry.block.parentId, beforeId);
      return move(
        state,
        dispatch &&
          ((tr) => {
            const moved = entries(tr.doc).find((item) => item.block.id === entry.block.id);
            if (
              moved &&
              selection.from >= entry.pos &&
              selection.to <= entry.pos + entry.node.nodeSize
            ) {
              const delta = moved.pos - entry.pos;
              tr.setSelection(
                selection instanceof NodeSelection
                  ? NodeSelection.create(tr.doc, moved.pos)
                  : TextSelection.create(tr.doc, selection.anchor + delta, selection.head + delta),
              );
            }
            dispatch(tr);
          }),
      );
    };
  }

  duplicate(id: SpaceBlockId): Command {
    return (state, dispatch) => {
      const all = entries(state.doc);
      const entry = all.find((item) => item.block.id === id);
      if (
        this.#options.canChangeStructure?.() === false ||
        !entry ||
        !this.#isComplete(entry.block.parentId, state.doc) ||
        !this.#subtreeComplete(entry.node, state.doc)
      )
        return false;
      try {
        const subtree = this.copyBlocks(state, [id]);
        if (
          all.length + subtree.length > this.#options.maxBlocks ||
          subtree.some((block) => mediaAssetId(block) !== null)
        )
          return false;
        if (!dispatch) return this.#options.canEdit?.() !== false;
        const next = all
          .filter((item) => item.block.parentId === entry.block.parentId)
          .find((item) => item.pos > entry.pos);
        const [root, ...rest] = copySpaceBlocks(
          subtree,
          this.#options.target,
          this.#options.allocateId,
        );
        const copied = [
          {
            ...root!,
            parentId: entry.block.parentId,
            order: this.#rank(entry.block.parentId, entry.block, next?.block),
          },
          ...rest,
        ];
        const doc = spaceWindowDocument(
          { revision: this.#window.revision, blocks: copied, completeParents: [] },
          this.#options.maxBlocks,
          this.#options.maxDepth,
          state.schema,
        );
        const at = entry.pos + entry.node.nodeSize;
        const tr = state.tr.insert(at, Fragment.from(doc.content));
        return this.#dispatch(tr.setSelection(this.#caretIn(tr.doc, at)), dispatch);
      } catch {
        return false;
      }
    };
  }

  insertAfter(id: SpaceBlockId, text = ""): Command {
    return (state, dispatch) => {
      const all = entries(state.doc);
      const entry = all.find((item) => item.block.id === id);
      if (
        this.#options.canChangeStructure?.() === false ||
        !entry ||
        all.length >= this.#options.maxBlocks ||
        !this.#isComplete(entry.block.parentId, state.doc)
      )
        return false;
      if (!dispatch) return this.#options.canEdit?.() !== false;
      const next = all
        .filter((item) => item.block.parentId === entry.block.parentId)
        .find((item) => item.pos > entry.pos);
      try {
        const block: SpaceBlock = {
          id: this.#options.allocateId(),
          parentId: entry.block.parentId,
          order: this.#rank(entry.block.parentId, entry.block, next?.block),
          type: "paragraph",
          version: 1,
          content: { runs: text ? [{ text, marks: [] }] : [] },
        };
        const at = entry.pos + entry.node.nodeSize;
        const tr = state.tr.insert(at, spaceBlockNode(block, [], false, state.schema));
        tr.setSelection(TextSelection.create(tr.doc, at + 1 + text.length));
        return this.#dispatch(tr, dispatch);
      } catch {
        return false;
      }
    };
  }

  #caretIn(doc: ProseMirrorNode, pos: number) {
    return doc.nodeAt(pos)?.type.name === "spaceAtom"
      ? NodeSelection.create(doc, pos)
      : TextSelection.near(doc.resolve(pos + 1));
  }

  copyBlocks(state: EditorState, ids: readonly SpaceBlockId[]): readonly SpaceBlock[] {
    const selected = new Set(ids);
    const all = entries(state.doc);
    const roots = all.filter(
      (entry) =>
        selected.has(entry.block.id) &&
        (entry.block.parentId === null || !selected.has(entry.block.parentId)),
    );
    if (!roots.length || roots.some((entry) => !this.#subtreeComplete(entry.node, state.doc)))
      throw new Error("Copy requires complete loaded subtrees");
    const included = new Set(
      roots.flatMap((entry) =>
        entries(state.schema.nodes.doc!.create(null, [entry.node])).map((item) => item.block.id),
      ),
    );
    const blocks = spaceDocumentBlocks(state.doc).filter((block) => included.has(block.id));
    if (blocks.some((block) => !canEditSpaceEditorBlock(block) || block.type === "child_page"))
      throw new Error("Copy needs explicit server duplication for child pages or opaque content");
    const copied = blocks.map((block) => ({
      ...block,
      parentId: block.parentId !== null && included.has(block.parentId) ? block.parentId : null,
    }));
    if (new TextEncoder().encode(JSON.stringify(copied)).length > this.#options.maxClipboardBytes)
      throw new Error("Clipboard limit exceeded");
    return copied;
  }

  pasteBlocks(blocks: readonly SpaceBlock[], source: SpacePageTarget): Command {
    return (state, dispatch) => {
      if (
        this.#options.canChangeStructure?.() === false ||
        source.environmentId !== this.#options.target.environmentId ||
        source.pageId !== this.#options.target.pageId ||
        !blocks.length ||
        blocks.length + entries(state.doc).length > this.#options.maxBlocks ||
        new TextEncoder().encode(JSON.stringify(blocks)).length > this.#options.maxClipboardBytes ||
        !this.#isComplete(null, state.doc)
      )
        return false;
      try {
        if (
          blocks.some(
            (block) =>
              block.parentId !== null && !blocks.some((parent) => parent.id === block.parentId),
          )
        )
          return false;
        if (
          blocks.some(
            (block) =>
              !canEditSpaceEditorBlock(block) || ["image", "pdf", "video"].includes(block.type),
          )
        )
          return false;
        const copied = copySpaceBlocks(blocks, source, this.#options.allocateId);
        if (copied.some((block) => entries(state.doc).some((entry) => entry.block.id === block.id)))
          return false;
        let previous = spaceDocumentBlocks(state.doc).findLast((block) => block.parentId === null);
        const ranked = copied.map((block) => {
          if (block.parentId !== null) return block;
          const next = { ...block, order: this.#rank(null, previous, undefined) };
          previous = next;
          return next;
        });
        const doc = spaceWindowDocument(
          { revision: this.#window.revision, blocks: ranked, completeParents: [] },
          this.#options.maxBlocks,
          this.#options.maxDepth,
          state.schema,
        );
        return this.#dispatch(
          state.tr.insert(state.doc.content.size, Fragment.from(doc.content)),
          dispatch,
        );
      } catch {
        return false;
      }
    };
  }

  undoLocal(): Command {
    return (state, dispatch) =>
      this.#options.canUndo?.() !== false &&
      undo(
        state,
        dispatch
          ? (tr) => {
              this.#dispatch(tr, dispatch, { history: true });
            }
          : undefined,
      );
  }
  redoLocal(): Command {
    return (state, dispatch) =>
      this.#options.canUndo?.() !== false &&
      redo(
        state,
        dispatch
          ? (tr) => {
              const nextIds = new Set(spaceDocumentBlocks(tr.doc).map((block) => block.id));
              const previousIds = new Set(spaceDocumentBlocks(tr.before).map((block) => block.id));
              const merged = this.#key
                .getState(state)!
                .joins.find(
                  (join) =>
                    previousIds.has(join.from) && !nextIds.has(join.from) && nextIds.has(join.into),
                );
              this.#dispatch(tr, dispatch, { ...(merged ? { merged } : {}), history: true });
            }
          : undefined,
      );
  }
}
