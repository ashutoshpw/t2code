import { EditorContent, useEditor } from "@tiptap/react";
import { useState } from "react";
import type { Command } from "@tiptap/pm/state";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";

import { SpaceEditorAdapter, type SpaceEditorBatch } from "./adapter";
import { spaceDocumentBlocks } from "./document";

// Remount with a new adapter after acknowledgement/window replacement; history is local only.
export function SpaceEditor({
  adapter,
  onBatch,
}: {
  readonly adapter: SpaceEditorAdapter;
  readonly onBatch: (batch: SpaceEditorBatch) => void;
}) {
  const [blocks, setBlocks] = useState<readonly SpaceBlock[]>(() =>
    spaceDocumentBlocks(adapter.document),
  );
  const [selectedId, setSelectedId] = useState<SpaceBlockId | null>(null);
  const [clipboard, setClipboard] = useState<readonly SpaceBlock[] | null>(null);
  const [notice, setNotice] = useState("");
  const editor = useEditor(
    {
      extensions: adapter.extensions(),
      content: adapter.document.toJSON(),
      immediatelyRender: false,
      onTransaction({ editor, transaction }) {
        if (transaction.docChanged) {
          setBlocks(spaceDocumentBlocks(editor.state.doc));
          onBatch(adapter.batch(editor.state));
        }
      },
      onSelectionUpdate({ editor }) {
        const { $from } = editor.state.selection;
        let selected: SpaceBlockId | null = null;
        for (let depth = $from.depth; depth > 0; depth--) {
          const block = $from.node(depth).attrs.block as SpaceBlock | undefined;
          if (block) {
            selected = block.id;
            break;
          }
        }
        setSelectedId(selected);
      },
    },
    [adapter],
  );
  const run = (command: Command) => {
    if (!editor) return;
    setNotice(
      command(editor.state, editor.view.dispatch)
        ? "Local command applied"
        : "Command unavailable at this boundary",
    );
    editor.view.focus();
  };
  return (
    <section aria-label="Spaces feasibility editor">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => run(adapter.split())}>
          Split
        </Button>
        <Button variant="outline" onClick={() => run(adapter.joinBackward())}>
          Join previous
        </Button>
        <Button variant="outline" onClick={() => run(adapter.undoLocal())}>
          Local undo
        </Button>
        <Button variant="outline" onClick={() => run(adapter.redoLocal())}>
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
            disabled={!selectedId}
            onClick={() => selectedId && run(adapter.convert(selectedId, type))}
          >
            {type}
          </Button>
        ))}
        <Button
          variant="outline"
          disabled={!selectedId}
          onClick={() =>
            selectedId &&
            run(
              adapter.move(
                selectedId,
                null,
                blocks.find((block) => block.parentId === null && block.id !== selectedId)?.id ??
                  null,
              ),
            )
          }
        >
          Move to start
        </Button>
        <Button
          variant="outline"
          disabled={!selectedId}
          onClick={() => {
            if (!selectedId || !editor) return;
            try {
              setClipboard(adapter.copyBlocks(editor.state, [selectedId]));
              setNotice("Subtree copied locally");
            } catch (error) {
              setNotice(error instanceof Error ? error.message : "Copy unavailable");
            }
          }}
        >
          Copy subtree
        </Button>
        <Button
          variant="outline"
          disabled={!clipboard}
          onClick={() => clipboard && run(adapter.pasteBlocks(clipboard, adapter.target))}
        >
          Paste subtree at end
        </Button>
      </div>
      <p role="status">{notice}</p>
      <EditorContent editor={editor} />
      <details>
        <summary>Canonical blocks</summary>
        <pre>{JSON.stringify(blocks, null, 2)}</pre>
      </details>
    </section>
  );
}
