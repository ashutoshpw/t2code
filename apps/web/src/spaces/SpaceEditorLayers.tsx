import { useEditorState } from "@tiptap/react";
import {
  useContext,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  BoldIcon,
  ChevronDownIcon,
  CodeIcon,
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
  PanelTopIcon,
  PilcrowIcon,
  QuoteIcon,
  RefreshCcwIcon,
  SquareCodeIcon,
  PaletteIcon,
  StrikethroughIcon,
  TableIcon,
  UnderlineIcon,
} from "lucide-react";
import { NodeSelection, type Command } from "@tiptap/pm/state";
import {
  SPACE_TEXT_COLORS,
  type SpaceBlockId,
  type SpaceDatabaseBlock,
} from "@t2code/contracts/spaces";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { Separator } from "~/components/ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { SpaceEditorAdapter } from "./adapter";
import {
  slashMatch,
  SlashItem,
  TURN_INTO,
  canTurnInto,
  runTurnInto,
  SpaceEditorWrapperContext,
  selectedBlock,
  editorCapabilities,
  runCommand,
  placeAt,
  fromNestedEditor,
  type SpaceEditorParts,
} from "./spaceEditorSupport";
import { insertTabs } from "./tabs/tabsCommands";
import { insertSynced } from "./synced/syncedCommands";

/** Block kinds the connected environment can store; the slash menu offers only these. */
export interface SpaceBlockFeatures {
  readonly tabs?: boolean;
  readonly synced?: boolean;
}

/** Asks the host to create a database, then to place its block with `place`. */
export type SlashDatabaseCreate = (
  place: (content: SpaceDatabaseBlock["content"]) => boolean,
  kind?: "new" | "linked",
) => void;

export function BubbleLayer({
  editor,
  adapter,
  bridge,
  editable,
  children,
}: SpaceEditorParts & { readonly children: ReactNode }) {
  const wrapper = useContext(SpaceEditorWrapperContext);
  const [linkOpen, setLinkOpen] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const bubbleState = useEditorState({
    editor,
    selector: ({ editor }) => {
      const state = editor.state;
      const caps = editorCapabilities(bridge, editable, false);
      if (!caps.writable || state.selection instanceof NodeSelection) return null;
      const { from, to } = state.selection;
      const link = adapter.linkSelection(state);
      if (from === to && !link?.hasLink) return null;
      const at = placeAt(editor, wrapper, from, 320);
      if (!at) return null;
      return {
        from,
        to,
        at,
        structure: caps.structure,
        selectedId: selectedBlock(state)?.id ?? null,
        link,
      };
    },
  });
  const run = (command: Command) => runCommand(editor, editable, command);
  const can = (command: Command) => !!bubbleState && command(editor.state);
  const visible = !!bubbleState && (focused || turnIntoOpen || colorOpen);
  const bubbleAt = visible ? bubbleState.at : null;
  const bubble = bubbleAt
    ? bubbleAt.top > 48
      ? { left: bubbleAt.left, top: bubbleAt.top - 6, transform: "translateY(-100%)" }
      : { left: bubbleAt.left, top: bubbleAt.bottom + 6 }
    : undefined;
  const link = bubbleState?.link ?? null;
  const selectedId = bubbleState?.selectedId ?? null;
  const linkKey = `${bubbleState?.from}-${bubbleState?.to}`;
  return (
    <div
      className="contents"
      onFocus={(event) => {
        if (fromNestedEditor(event)) return;
        setFocused(
          !(event.target instanceof Element && event.target.closest("[data-space-database]")),
        );
      }}
      onBlur={(event) => {
        if (fromNestedEditor(event)) return;
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {children}
      {bubble && bubbleState ? (
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
                ["underline", "Underline", UnderlineIcon],
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
            <Menu open={colorOpen} onOpenChange={setColorOpen}>
              <MenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="Text color" />}
              >
                <PaletteIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                {(
                  [
                    ["color", "Text color"],
                    ["highlight", "Background"],
                  ] as const
                ).map(([style, heading]) => (
                  <MenuGroup key={style}>
                    <MenuGroupLabel>{heading}</MenuGroupLabel>
                    {[null, ...SPACE_TEXT_COLORS].map((value) => (
                      <MenuItem
                        key={value ?? "default"}
                        disabled={!can(adapter.textStyle(style, value))}
                        onClick={() => run(adapter.textStyle(style, value))}
                      >
                        <span
                          className="w-5 rounded-sm text-center font-semibold"
                          {...(value
                            ? {
                                [style === "color" ? "data-space-color" : "data-space-highlight"]:
                                  value,
                              }
                            : {})}
                        >
                          A
                        </span>
                        <span className="capitalize">{value ?? "Default"}</span>
                      </MenuItem>
                    ))}
                  </MenuGroup>
                ))}
              </MenuPopup>
            </Menu>
            <Separator orientation="vertical" className="mx-1 h-5" />
            <Menu open={turnIntoOpen} onOpenChange={setTurnIntoOpen}>
              <MenuTrigger render={<Button variant="ghost" size="sm" />}>
                Turn into
                <ChevronDownIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                {TURN_INTO.map((entry) => (
                  <MenuItem
                    key={entry.key}
                    disabled={
                      !bubbleState.structure ||
                      !selectedId ||
                      !can((state) => canTurnInto(adapter, state, selectedId, entry))
                    }
                    onClick={() =>
                      selectedId && runTurnInto(editor, editable, adapter, selectedId, entry)
                    }
                  >
                    <entry.icon />
                    {entry.label}
                  </MenuItem>
                ))}
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
              writable
              can={can}
              run={run}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SlashLayer({
  editor,
  adapter,
  bridge,
  editable,
  onCreatePage,
  onCreateDatabase,
  blockFeatures,
  children,
}: SpaceEditorParts & {
  readonly onCreatePage: ((blockId: SpaceBlockId | null) => void) | undefined;
  readonly onCreateDatabase?: SlashDatabaseCreate | undefined;
  readonly blockFeatures?: SpaceBlockFeatures | undefined;
  readonly children: ReactNode;
}) {
  const wrapper = useContext(SpaceEditorWrapperContext);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [slashSel, setSlashSel] = useState({ query: "", index: 0 });
  const slash = useEditorState({
    editor,
    selector: ({ editor }) => {
      const state = editor.state;
      if (!editorCapabilities(bridge, editable, false).structure) return null;
      const match = slashMatch(state);
      if (!match) return null;
      const at = placeAt(editor, wrapper, state.selection.from, 240);
      return {
        ...match,
        key: `${selectedBlock(state)?.id}:${match.from}`,
        menu: at ? { left: at.left, top: at.bottom + 4 } : null,
      };
    },
  });
  const run = (command: Command) => runCommand(editor, editable, command);
  const convertTo =
    (type: Parameters<SpaceEditorAdapter["convert"]>[1]) => (id: SpaceBlockId | null) => {
      if (id && selectedBlock(editor.state)?.type !== type) run(adapter.convert(id, type));
    };
  const headingTo = (level: 1 | 2 | 3) => (id: SpaceBlockId | null) => {
    const entry = TURN_INTO.find((item) => item.level === level);
    if (id && entry) runTurnInto(editor, editable, adapter, id, entry);
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
    ...(blockFeatures?.tabs
      ? [
          {
            label: "Tabs",
            icon: PanelTopIcon,
            keywords: "tabs tab sections",
            apply: (id: SpaceBlockId | null) => run(insertTabs(adapter, id)),
          },
        ]
      : []),
    ...(blockFeatures?.synced
      ? [
          {
            label: "Synced block",
            icon: RefreshCcwIcon,
            keywords: "synced sync mirror",
            apply: (id: SpaceBlockId | null) => run(insertSynced(adapter, id)),
          },
        ]
      : []),
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
    ...(onCreateDatabase
      ? [
          {
            label: "Database",
            icon: TableIcon,
            keywords: "table board grid kanban",
            apply: (id: SpaceBlockId | null) =>
              onCreateDatabase(
                (content) =>
                  editable &&
                  !editor.isDestroyed &&
                  adapter.placeDatabase(id, content)(editor.state, editor.view.dispatch),
              ),
          },
          {
            label: "Linked view of database",
            icon: LinkIcon,
            keywords: "database link view existing table board",
            apply: (id: SpaceBlockId | null) =>
              onCreateDatabase(
                (content) =>
                  editable &&
                  !editor.isDestroyed &&
                  adapter.placeDatabase(id, content)(editor.state, editor.view.dispatch),
                "linked",
              ),
          },
        ]
      : []),
  ];
  const slashItems = slash
    ? allSlashItems.filter((item) =>
        `${item.label} ${item.keywords}`.toLowerCase().includes(slash.query.toLowerCase()),
      )
    : [];
  const slashOpen = !!slash && dismissed !== slash.key && slashItems.length > 0;
  const slashIndex =
    slash && slashSel.query === slash.query ? Math.min(slashSel.index, slashItems.length - 1) : 0;
  const slashMenu = slashOpen ? slash.menu : null;
  const pickSlash = (item: SlashItem) => {
    if (!slash) return;
    const { from } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.delete(slash.from, from));
    item.apply(selectedBlock(editor.state)?.id ?? null);
  };
  const onSlashKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (fromNestedEditor(event)) return;
    if (event.key === "/") setDismissed(null);
    if (!slashOpen || event.nativeEvent.isComposing) return;
    const count = slashItems.length;
    const step = (delta: number) =>
      setSlashSel({ query: slash.query, index: (slashIndex + delta + count) % count });
    if (event.key === "ArrowDown") step(1);
    else if (event.key === "ArrowUp") step(-1);
    else if (event.key === "Enter") pickSlash(slashItems[slashIndex]!);
    else if (event.key === "Escape") setDismissed(slash.key);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      className="contents"
      onKeyDownCapture={onSlashKey}
      onBlur={(event) => {
        if (fromNestedEditor(event)) return;
        if (slash && !event.currentTarget.contains(event.relatedTarget)) setDismissed(slash.key);
      }}
    >
      {children}
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
