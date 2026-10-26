import { Extension, type Extensions } from "@tiptap/core";
import { closeHistory, history, redo, undo } from "@tiptap/pm/history";
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
import { canSplit } from "@tiptap/pm/transform";
import { toggleMark } from "@tiptap/pm/commands";
import { Schema } from "effect";
import {
  copySpaceBlocks,
  isKnownSpaceBlock,
  isSpaceListItem,
  joinSpaceTextBlocks,
  splitSpaceTextBlock,
  type SpaceMutation,
} from "@t2code/client-runtime/spaces";
import { SpaceBlock, type SpaceBlockId, type SpacePageTarget } from "@t2code/contracts/spaces";

import {
  canEditSpaceEditorBlock,
  sameSpaceValue,
  spaceBlockNode,
  spaceDocumentBlocks,
  spaceWindowDocument,
  type SpaceEditorWindow,
} from "./document";
import { richBlockTypes, spaceSchemaExtensions } from "./schema";

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
}
export interface SpaceEditorBatch {
  readonly baseRevision: number;
  readonly memberIds: readonly SpaceBlockId[];
  readonly mutations: readonly SpaceMutation[];
}
interface Operation {
  readonly merged?: { readonly from: SpaceBlockId; readonly into: SpaceBlockId };
}
interface AdapterState {
  readonly batch: SpaceEditorBatch;
  readonly joins: readonly NonNullable<Operation["merged"]>[];
}
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

export class SpaceEditorAdapter {
  readonly #options: SpaceEditorOptions;
  readonly #key = new PluginKey<AdapterState>("spaces-window");
  readonly #operation = new PluginKey<Operation>("spaces-operation");
  #members: ReadonlySet<SpaceBlockId>;
  #complete: ReadonlySet<SpaceBlockId | null>;
  #window: SpaceEditorWindow;
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
          for (const entry of before.filter((item) => item.node.type.name === "spaceAtom")) {
            const next = after.find((item) => item.block.id === entry.block.id);
            if (!next && entry.block.type === "divider" && canEditSpaceEditorBlock(entry.block))
              continue;
            if (
              !next &&
              !this.#members.has(entry.block.id) &&
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
        handleDOMEvents: {
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
    return [history({ depth: localHistoryDepth }), this.#plugin()];
  }

  extensions(): Extensions {
    const plugins = this.plugins();
    const split = this.split();
    const join = this.joinBackward();
    const undo = this.undoLocal();
    const redo = this.redoLocal();
    const bold = this.mark("bold"),
      italic = this.mark("italic"),
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
              if (this.editor.state.selection.$from.parent.type.name === "code")
                this.editor.view.dispatch(this.editor.state.tr.insertText("\n"));
              else run(split);
              return true;
            },
            Backspace: () => {
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
            "Mod-Shift-x": () => {
              run(strike);
              return true;
            },
            "Mod-`": () => {
              run(code);
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
    this.#window = window;
    this.#members = new Set(window.blocks.map((block) => block.id));
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

  mark(type: "bold" | "italic" | "strike" | "code"): Command {
    return (state, dispatch) =>
      this.#options.canEdit?.() !== false &&
      toggleMark(state.schema.marks[`space_${type}`]!, { value: { type, version: 1 } })(
        state,
        dispatch,
      );
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

  remove(id: SpaceBlockId): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
      const entry = entries(state.doc).find((item) => item.block.id === id);
      if (
        !entry ||
        (entry.node.type.name === "spaceAtom" && entry.block.type !== "divider") ||
        !this.#isComplete(entry.block.parentId, state.doc) ||
        !this.#subtreeComplete(entry.node, state.doc)
      )
        return false;
      const subtree = entries(state.schema.nodes.doc!.create(null, [entry.node]));
      if (
        subtree.some(
          (item) =>
            !canEditSpaceEditorBlock(item.block) ||
            ["child_page", "image", "pdf", "video"].includes(item.block.type),
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
      tr.setNodeMarkup(nextPos, undefined, { block: second });
      return this.#dispatch(tr, dispatch);
    };
  }

  joinBackward(): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
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
      | "todo_item",
  ): Command {
    return (state, dispatch) => {
      if (this.#options.canChangeStructure?.() === false) return false;
      const entry = entries(state.doc).find((item) => item.block.id === id);
      const block = spaceDocumentBlocks(state.doc).find((item) => item.id === id);
      const targetIsList = ["bulleted_item", "numbered_item", "todo_item"].includes(type);
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
      const all = entries(state.doc);
      const entry = all.find((item) => item.block.id === id);
      const parent = parentId === null ? undefined : all.find((item) => item.block.id === parentId);
      if (
        !entry ||
        !canEditSpaceEditorBlock(entry.block) ||
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
      const before = siblings[index - 1];
      const after = siblings[index];
      const block = spaceDocumentBlocks(state.doc).find((item) => item.id === id)!;
      const moved = entry.node.type.create(
        { block: { ...block, parentId, order: this.#rank(parentId, before?.block, after?.block) } },
        entry.node.content,
      );
      const insertAt =
        after?.pos ?? (parent ? parent.pos + parent.node.nodeSize - 1 : state.doc.content.size);
      const tr = state.tr.delete(entry.pos, entry.pos + entry.node.nodeSize);
      tr.insert(tr.mapping.map(insertAt), moved);
      return this.#dispatch(tr, dispatch);
    };
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
              this.#dispatch(tr, dispatch);
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
              this.#dispatch(tr, dispatch, merged ? { merged } : {});
            }
          : undefined,
      );
  }
}
