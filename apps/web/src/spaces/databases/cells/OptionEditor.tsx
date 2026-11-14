import { PlusIcon } from "lucide-react";
import { useContext, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { nextOptionColor } from "@t2code/client-runtime/spaces";
import type { SpaceOptionId, SpaceStatusGroup } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { beforeIdAfterMove, movedId } from "../controls/propertyConfig";
import { SortableList, SortableRow } from "../controls/Sortable";
import { OptionChip } from "../primitives/OptionChip";
import { DatabaseActionsContext, useOptionalDatabase } from "../shell/context";
import type { CellEditorProps } from "./CellEditor";
import { EditorPopover } from "./EditorPopover";
import { OptionMenu } from "./OptionMenu";
import {
  idsOf,
  optionRows,
  selectedOptions,
  type Option,
  type OptionKnown,
  type OptionRow,
} from "./optionRows";
import { useSettleOnce } from "./settle";

/** Select, multi-select and status pickers in a popover with a search field. */
export function OptionEditor(props: CellEditorProps) {
  const { value, seed, onChange } = props;
  const known = props.known as OptionKnown;
  // Null on a row page, where no database surface exists.
  const actions = useContext(DatabaseActionsContext);
  const schemaEditable = useOptionalDatabase()?.model.permissions.schema === true;
  const canManage = actions !== null && schemaEditable;
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const multi = known.type === "multi_select";
  const [query, setQuery] = useState(seed ?? "");
  const [active, setActive] = useState<number | null>(null);
  const [createGroup, setCreateGroup] = useState<SpaceStatusGroup>("todo");
  const { commit, cancel } = useSettleOnce(props);
  const selected = idsOf(value);
  const chosen = selectedOptions(known, value);
  const rows = optionRows(known, query, { canCreate: canManage, createGroup });
  const pickable = rows.filter((row) => row.kind !== "heading");
  // Enter prefers an existing match over the create row, which a status can list first.
  const firstOption = pickable.findIndex((row) => row.kind === "option");
  const current = Math.min(active ?? Math.max(0, firstOption), Math.max(0, pickable.length - 1));
  const draggable = canManage && query.trim() === "";

  const toggle = (id: string) => {
    if (!multi) return commit(id);
    onChange?.(
      selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id],
    );
  };
  const remove = (id: string) => {
    if (multi) onChange?.(selected.filter((entry) => entry !== id));
    else if (onChange !== undefined) onChange(null);
    else commit(null);
  };
  const create = async (name: string) => {
    if (actions === null) return;
    const id = await actions.addOption(
      known.id,
      name,
      known.type === "status" ? createGroup : undefined,
    );
    if (id === null) return;
    if (multi) {
      onChange?.([...selected, id]);
      setQuery("");
    } else commit(id);
  };
  const choose = (row: OptionRow | undefined) => {
    if (row?.kind === "option") toggle(row.option.id);
    else if (row?.kind === "create") void create(row.name);
  };
  const reorder = (ids: ReadonlyArray<string>, next: ReadonlyArray<string>) => {
    const moved = movedId(ids, next);
    if (moved === null || actions === null) return;
    void actions.updateSchema([
      {
        op: "moveOption",
        propertyId: known.id,
        optionId: moved as SpaceOptionId,
        beforeOptionId: beforeIdAfterMove(next, moved) as SpaceOptionId | null,
      },
    ]);
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

  const optionRow = (option: Option, index: number) => {
    const body = (
      <>
        <div
          role="option"
          id={`${listId}-${index}`}
          aria-selected={selected.includes(option.id)}
          data-active={index === current ? "" : undefined}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center rounded-md px-1 data-active:bg-accent"
          onMouseMove={() => setActive(index)}
          onClick={() => toggle(option.id)}
        >
          <OptionChip name={option.name} color={option.color} />
        </div>
        {canManage ? (
          <span
            className={
              index === current ? "opacity-100" : "opacity-0 group-hover/sortable:opacity-100"
            }
          >
            <OptionMenu known={known} option={option} />
          </span>
        ) : null}
      </>
    );
    return canManage ? (
      <SortableRow key={option.id} id={option.id} label={option.name} disabled={!draggable} reveal>
        {body}
      </SortableRow>
    ) : (
      <div key={option.id} className="flex items-center gap-1.5">
        {body}
      </div>
    );
  };

  const list: ReactNode[] = [];
  let run: Option[] = [];
  const flush = (key: string) => {
    if (run.length === 0) return;
    const items = run;
    run = [];
    const rowsOf = items.map((option) =>
      optionRow(
        option,
        pickable.findIndex((row) => row.kind === "option" && row.option.id === option.id),
      ),
    );
    const ids = items.map((option) => option.id);
    list.push(
      canManage ? (
        <SortableList key={key} ids={ids} onReorder={(next) => reorder(ids, next)}>
          {rowsOf}
        </SortableList>
      ) : (
        <div key={key}>{rowsOf}</div>
      ),
    );
  };
  for (const row of rows) {
    if (row.kind === "option") {
      run.push(row.option);
      continue;
    }
    flush(`run:${list.length}`);
    if (row.kind === "heading")
      list.push(
        <div
          key={`h:${row.group}`}
          role="presentation"
          className="group/sortable flex items-center justify-between px-2 pt-1.5 pb-0.5 text-xs text-muted-foreground"
        >
          {row.label}
          {canManage ? (
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={`Add an option to ${row.label}`}
              onClick={() => {
                setCreateGroup(row.group);
                input.current?.focus();
              }}
            >
              <PlusIcon />
            </Button>
          ) : null}
        </div>,
      );
    else {
      const index = pickable.indexOf(row);
      list.push(
        <div
          key="create"
          role="option"
          id={`${listId}-${index}`}
          aria-selected={false}
          data-active={index === current ? "" : undefined}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm data-active:bg-accent"
          onMouseMove={() => setActive(index)}
          onClick={() => choose(row)}
        >
          Create
          <OptionChip
            name={row.name}
            color={nextOptionColor(known.config.options.map((option) => option.color))}
          />
        </div>,
      );
    }
  }
  flush("run:end");

  return (
    <EditorPopover label={known.name} onClose={cancel} width="md">
      <div className="flex w-full flex-col text-sm">
        <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
          {chosen.map((option) => (
            <OptionChip
              key={option.id}
              name={option.name}
              color={option.color}
              onRemove={() => remove(option.id)}
            />
          ))}
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={pickable.length > 0 ? `${listId}-${current}` : undefined}
            aria-label={`Search ${known.name}`}
            placeholder={chosen.length === 0 ? "Search for an option…" : undefined}
            value={query}
            className="h-6 min-w-16 flex-1 bg-transparent text-sm outline-none"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(null);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <span className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
          {canManage ? "Select an option or create one" : "Select an option"}
        </span>
        <div
          id={listId}
          role="listbox"
          aria-label={known.name}
          className="max-h-72 overflow-y-auto p-1"
        >
          {list}
          {pickable.length === 0 ? (
            <div role="presentation" className="px-2 py-1 text-muted-foreground">
              No options
            </div>
          ) : null}
        </div>
      </div>
    </EditorPopover>
  );
}
