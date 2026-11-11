import { useContext, useId, useState, type KeyboardEvent } from "react";
import type {
  SpaceCellValue,
  SpaceKnownDatabaseProperty,
  SpaceStatusGroup,
} from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { DatabaseActionsContext } from "../shell/context";
import { OptionChip } from "../primitives/OptionChip";
import type { CellEditorProps } from "./CellEditor";
import { EditorPopover } from "./EditorPopover";
import { useSettleOnce } from "./settle";

type OptionKnown = Extract<
  SpaceKnownDatabaseProperty,
  { type: "select" | "multi_select" | "status" }
>;
type Option = OptionKnown["config"]["options"][number];

const STATUS_GROUPS: ReadonlyArray<{ group: SpaceStatusGroup; label: string }> = [
  { group: "todo", label: "To-do" },
  { group: "in_progress", label: "In progress" },
  { group: "complete", label: "Complete" },
];

const idsOf = (value: SpaceCellValue | undefined): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : typeof value === "string"
      ? [value]
      : [];

type Row =
  | { readonly kind: "option"; readonly option: Option }
  | { readonly kind: "create"; readonly name: string }
  | { readonly kind: "heading"; readonly label: string };

function rowsFor(known: OptionKnown, query: string, canCreate: boolean): ReadonlyArray<Row> {
  const needle = query.trim().toLowerCase();
  const matching = known.config.options.filter((option) =>
    option.name.toLowerCase().includes(needle),
  );
  const rows: Row[] = [];
  if (known.type === "status") {
    for (const { group, label } of STATUS_GROUPS) {
      const inGroup = matching.filter((option) => "group" in option && option.group === group);
      if (inGroup.length === 0) continue;
      rows.push({ kind: "heading", label });
      for (const option of inGroup) rows.push({ kind: "option", option });
    }
    return rows;
  }
  for (const option of matching) rows.push({ kind: "option", option });
  const exact = known.config.options.some((option) => option.name.toLowerCase() === needle);
  if (canCreate && needle !== "" && !exact) rows.push({ kind: "create", name: query.trim() });
  return rows;
}

/** Select, multi-select and status pickers in a popover with a search field. */
export function OptionEditor(props: CellEditorProps) {
  const { value, seed, onChange } = props;
  const known = props.known as OptionKnown;
  // Null on a row page, where no database surface exists; creating options is hidden then.
  const actions = useContext(DatabaseActionsContext);
  const listId = useId();
  const multi = known.type === "multi_select";
  const [query, setQuery] = useState(seed ?? "");
  const [active, setActive] = useState(0);
  const { commit, cancel } = useSettleOnce(props);
  const selected = idsOf(value);
  const rows = rowsFor(known, query, actions !== null);
  const pickable = rows.filter((row) => row.kind !== "heading");
  const current = Math.min(active, Math.max(0, pickable.length - 1));

  const toggle = (id: string) => {
    if (!multi) return commit(id);
    onChange?.(
      selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id],
    );
  };
  const create = async (name: string) => {
    if (actions === null) return;
    const id = await actions.addOption(known.id, name);
    if (id === null) return;
    if (multi) {
      onChange?.([...selected, id]);
      setQuery("");
    } else commit(id);
  };
  const choose = (row: Row | undefined) => {
    if (row?.kind === "option") toggle(row.option.id);
    else if (row?.kind === "create") void create(row.name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const count = pickable.length;
      if (count > 0) setActive((current + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(pickable[current]);
    } else if (event.key === "Backspace" && query === "" && multi && selected.length > 0) {
      onChange?.(selected.slice(0, -1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <EditorPopover label={known.name} onClose={cancel}>
      <div className="flex w-full flex-col text-sm">
        {multi && selected.length > 0 ? (
          <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
            {selected.map((id) => {
              const option = known.config.options.find((entry) => entry.id === id);
              return option === undefined ? null : (
                <OptionChip
                  key={id}
                  name={option.name}
                  color={option.color}
                  onRemove={() => onChange?.(selected.filter((entry) => entry !== id))}
                />
              );
            })}
          </div>
        ) : null}
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-label={`Search ${known.name}`}
          placeholder="Search or create"
          value={query}
          className="h-8 border-b bg-transparent px-2.5 text-sm outline-none"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul
          id={listId}
          role="listbox"
          aria-label={known.name}
          className="max-h-60 overflow-y-auto p-1"
        >
          {rows.map((row) => {
            if (row.kind === "heading")
              return (
                <li
                  key={`h:${row.label}`}
                  role="presentation"
                  className="px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground"
                >
                  {row.label}
                </li>
              );
            const index = pickable.indexOf(row);
            return (
              <li
                key={row.kind === "option" ? row.option.id : "create"}
                role="option"
                aria-selected={row.kind === "option" && selected.includes(row.option.id)}
                data-active={index === current ? "" : undefined}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 data-active:bg-accent",
                )}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(row)}
              >
                {row.kind === "option" ? (
                  <OptionChip name={row.option.name} color={row.option.color} />
                ) : (
                  <span>
                    Create <OptionChip name={row.name} color="default" />
                  </span>
                )}
              </li>
            );
          })}
          {pickable.length === 0 ? (
            <li role="presentation" className="px-2 py-1 text-muted-foreground">
              No options
            </li>
          ) : null}
        </ul>
        {!multi && selected.length > 0 ? (
          <button
            type="button"
            className="border-t px-2.5 py-1.5 text-start text-muted-foreground hover:bg-accent"
            onClick={() => commit(null)}
          >
            Clear
          </button>
        ) : null}
      </div>
    </EditorPopover>
  );
}
