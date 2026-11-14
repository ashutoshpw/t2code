import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorState,
  type NodeViewProps,
} from "@tiptap/react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useContext, useState, type KeyboardEvent } from "react";
import type { SpaceBlock, SpaceBlockId } from "@t2code/contracts/spaces";
import { isSpaceTabPaneBlock } from "@t2code/client-runtime/spaces";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { RenameInput } from "../databases/shell/RenameInput";
import { runCommand } from "../spaceEditorSupport";
import { SpaceEditorAdapterContext } from "../spaceNodeViews";
import { activeSpacePane, switchSpacePane } from "./tabsActive";
import { addPane, fillPane, movePane, removePane, renamePane } from "./tabsCommands";

// Module constants: dnd-kit rebuilds its sensors when the options object changes.
const POINTER_OPTIONS = { activationConstraint: { distance: 4 } } as const;
const MODIFIERS = [restrictToHorizontalAxis];

interface PaneInfo {
  readonly id: SpaceBlockId;
  readonly title: string;
  readonly icon: string | undefined;
}

function Tab({
  pane,
  index,
  count,
  active,
  manage,
  renaming,
  onChoose,
  onRename,
  onRenamed,
  onMove,
  onDelete,
}: {
  readonly pane: PaneInfo;
  readonly index: number;
  readonly count: number;
  readonly active: boolean;
  readonly manage: boolean;
  readonly renaming: boolean;
  readonly onChoose: (id: SpaceBlockId) => void;
  readonly onRename: (id: SpaceBlockId | null) => void;
  readonly onRenamed: (id: SpaceBlockId, title: string) => void;
  readonly onMove: (id: SpaceBlockId, step: -1 | 1) => void;
  readonly onDelete: (id: SpaceBlockId) => void;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: pane.id,
    disabled: !manage || renaming,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The dialog opens once the menu has finished closing, or the menu leaves inert guards over it.
  const [deleteRequested, setDeleteRequested] = useState(false);
  const style = { transform: CSS.Translate.toString(transform), transition };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    if (event.altKey && manage) return onMove(pane.id, step);
    const tabs = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs?.[Math.max(0, Math.min(count - 1, index + step))]?.focus();
  };
  if (renaming)
    return (
      <div ref={setNodeRef} style={style} className="shrink-0 px-1">
        <RenameInput
          label="Tab name"
          value={pane.title}
          onCommit={(title) => {
            onRenamed(pane.id, title);
            onRename(null);
          }}
          onCancel={() => onRename(null)}
        />
      </div>
    );
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("flex shrink-0 items-center", isDragging && "z-10 opacity-80")}
      {...listeners}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        data-space-tab={pane.id}
        className={cn(
          "flex h-7 max-w-44 items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
        onClick={() => onChoose(pane.id)}
        onDoubleClick={() => manage && onRename(pane.id)}
        onKeyDown={onKeyDown}
      >
        {pane.icon ? <span aria-hidden>{pane.icon}</span> : null}
        <span className="truncate">{pane.title}</span>
      </button>
      {active && manage ? (
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onOpenChangeComplete={(open) => {
            if (!open && deleteRequested) {
              setDeleteRequested(false);
              setConfirming(true);
            }
          }}
        >
          <MenuTrigger
            render={<Button variant="ghost-muted" size="icon-xs" aria-label="Tab options" />}
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem onClick={() => onRename(pane.id)}>
              <PencilIcon />
              Rename
            </MenuItem>
            <MenuItem disabled={index === 0} onClick={() => onMove(pane.id, -1)}>
              <ArrowLeftIcon />
              Move left
            </MenuItem>
            <MenuItem disabled={index === count - 1} onClick={() => onMove(pane.id, 1)}>
              <ArrowRightIcon />
              Move right
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={count < 2}
              onClick={() => setDeleteRequested(true)}
            >
              <Trash2Icon />
              Delete tab
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tab “{pane.title}” and its content?</AlertDialogTitle>
            <AlertDialogDescription>Everything on this tab is removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => onDelete(pane.id)}
            >
              Delete tab
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export function SpaceTabsView({ node, editor }: NodeViewProps) {
  const adapter = useContext(SpaceEditorAdapterContext);
  const block = node.attrs.block as SpaceBlock;
  const editable = useEditorState({ editor, selector: ({ editor }) => editor.isEditable });
  const active = useEditorState({
    editor,
    selector: ({ editor }) => activeSpacePane(editor.state, block.id),
  });
  const [renaming, setRenaming] = useState<SpaceBlockId | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const manage = editable && adapter !== null;
  const panes: PaneInfo[] = [];
  const emptyPanes: SpaceBlockId[] = [];
  node.forEach((child) => {
    const pane = child.attrs.block as SpaceBlock;
    if (isSpaceTabPaneBlock(pane)) {
      if (child.childCount === 0) emptyPanes.push(pane.id);
      panes.push({ id: pane.id, title: pane.content.title, icon: pane.content.icon });
    }
  });
  const activeEmpty = emptyPanes.find((id) => id === active);
  const choose = (id: SpaceBlockId) => {
    if (!editor.isDestroyed) editor.view.dispatch(switchSpacePane(editor.state, block.id, id));
  };
  const run = (command: ReturnType<typeof addPane>) => runCommand(editor, manage, command);
  const move = (id: SpaceBlockId, step: -1 | 1) => {
    const index = panes.findIndex((pane) => pane.id === id);
    const before = step < 0 ? panes[index - 1] : panes[index + 2];
    if (adapter && index >= 0 && (step < 0 ? index > 0 : index < panes.length - 1))
      run(movePane(adapter, id, before?.id ?? null));
  };
  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    if (!adapter || !over || dragged.id === over.id) return;
    const from = panes.findIndex((pane) => pane.id === dragged.id);
    const to = panes.findIndex((pane) => pane.id === over.id);
    if (from >= 0 && to >= 0)
      run(movePane(adapter, panes[from]!.id, (to > from ? panes[to + 1] : panes[to])?.id ?? null));
  };
  return (
    <NodeViewWrapper data-space-block={block.id} data-space-type="tabs">
      <div contentEditable={false} data-space-tab-strip="" className="flex items-center gap-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={MODIFIERS}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={panes.map((pane) => pane.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div
              role="tablist"
              aria-label="Tabs"
              className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
            >
              {panes.map((pane, index) => (
                <Tab
                  key={pane.id}
                  pane={pane}
                  index={index}
                  count={panes.length}
                  active={pane.id === active}
                  manage={manage}
                  renaming={renaming === pane.id}
                  onChoose={choose}
                  onRename={setRenaming}
                  onRenamed={(id, title) => adapter && run(renamePane(adapter, id, title))}
                  onMove={move}
                  onDelete={(id) => adapter && run(removePane(adapter, id))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        {manage ? (
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Add a tab"
            onClick={() => adapter && run(addPane(adapter, block.id))}
          >
            <PlusIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      <NodeViewContent />
      {manage && activeEmpty !== undefined ? (
        <div contentEditable={false}>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => adapter && run(fillPane(adapter, activeEmpty))}
          >
            Click to write
          </Button>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
