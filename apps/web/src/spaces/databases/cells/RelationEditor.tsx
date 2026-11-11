import { RegistryContext } from "@effect/atom-react";
import { rowTitle } from "@t2code/client-runtime/spaces";
import { useContext, useEffect, useState, type KeyboardEvent } from "react";
import type { SpaceCellValue, SpaceDatabaseRow, SpaceRelatedPage } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { databasePorts } from "../data/ports";
import { useOptionalDatabase } from "../shell/context";
import type { CellEditorProps } from "./CellEditor";
import { EditorPopover } from "./EditorPopover";
import { useSettleOnce } from "./settle";

const SEARCH_DEBOUNCE_MS = 200;
const RESULT_LIMIT = 20;

const idsOf = (value: SpaceCellValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Pick pages of the related data source by title. Creating rows in the target is not offered. */
export function RelationEditor(props: CellEditorProps) {
  const { value, relatedPages, onChange, onPicked } = props;
  const known = props.known as Extract<typeof props.known, { type: "relation" }>;
  const registry = useContext(RegistryContext);
  const database = useOptionalDatabase();
  const environmentId = props.environmentId ?? database?.model.environmentId;
  const [query, setQuery] = useState(props.seed ?? "");
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<ReadonlyArray<SpaceDatabaseRow> | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Readonly<Record<string, SpaceRelatedPage>>>({});
  const { commit, cancel } = useSettleOnce(props);
  const selected = idsOf(value);
  const one = known.config.limit === "one";

  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Search the related data source on the server; a newer search or an unmount drops the older answer.
  useEffect(() => {
    if (environmentId === undefined) return;
    let current = true;
    const timer = setTimeout(
      () => {
        databasePorts
          .query(registry, {
            environmentId,
            dataSourceId: known.config.dataSourceId,
            mode: "rows",
            filter: null,
            sorts: [],
            group: null,
            subGroup: null,
            properties: [],
            aggregates: [],
            limit: RESULT_LIMIT,
            timeZone: viewerZone(),
            ...(query.trim() === "" ? {} : { search: query.trim() }),
          })
          .then(
            (result) => {
              if (!current) return;
              setResults(result.rows);
              setFailed(false);
            },
            () => {
              if (current) setFailed(true);
            },
          );
      },
      query === "" ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [registry, environmentId, known.config.dataSourceId, query]);

  const toggle = (row: SpaceDatabaseRow) => {
    const pageId = row.page.id;
    if (!selected.includes(pageId)) {
      const page: SpaceRelatedPage = {
        title: row.page.title,
        ...(row.page.icon === undefined ? {} : { icon: row.page.icon }),
        dataSourceId: known.config.dataSourceId,
      };
      setPicked((current) => ({ ...current, [pageId]: page }));
      onPicked?.({ [pageId]: page });
    }
    if (one) return commit(selected.includes(pageId) ? null : [pageId]);
    const next = selected.includes(pageId)
      ? selected.filter((id) => id !== pageId)
      : [...selected, pageId];
    onChange?.(next.length === 0 ? null : next);
  };
  const rows = results ?? [];
  const current = Math.min(active, Math.max(0, rows.length - 1));
  const titleOf = (pageId: string) => (relatedPages[pageId] ?? picked[pageId])?.title || "Untitled";

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length > 0)
        setActive((current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[current];
      if (row !== undefined) toggle(row);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  return (
    <EditorPopover label={known.name} onClose={cancel}>
      <div className="flex w-full flex-col text-sm">
        {selected.length > 0 ? (
          <ul className="flex flex-wrap gap-1 border-b px-2 py-1.5">
            {selected.map((id) => (
              <li
                key={id}
                className="flex items-center gap-1 rounded-sm bg-foreground/6 px-1.5 text-xs/5"
              >
                <span className="truncate">{titleOf(id)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${titleOf(id)}`}
                  onClick={() => {
                    const next = selected.filter((entry) => entry !== id);
                    onChange?.(next.length === 0 ? null : next);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-label={`Search ${known.name}`}
          placeholder="Search pages"
          value={query}
          className="h-8 border-b bg-transparent px-2.5 text-sm outline-none"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul role="listbox" aria-label={known.name} className="max-h-60 overflow-y-auto p-1">
          {rows.map((row, index) => (
            <li
              key={row.page.id}
              role="option"
              aria-selected={selected.includes(row.page.id)}
              data-active={index === current ? "" : undefined}
              className={cn("cursor-pointer truncate rounded-md px-2 py-1 data-active:bg-accent")}
              onMouseMove={() => setActive(index)}
              onClick={() => toggle(row)}
            >
              {rowTitle(row) || "Untitled"}
            </li>
          ))}
          {results === null && !failed ? (
            <li role="presentation" className="px-2 py-1 text-muted-foreground">
              Searching
            </li>
          ) : null}
          {failed ? (
            <li role="alert" className="px-2 py-1 text-muted-foreground">
              Couldn't search pages
            </li>
          ) : null}
          {results !== null && rows.length === 0 && !failed ? (
            <li role="presentation" className="px-2 py-1 text-muted-foreground">
              No pages
            </li>
          ) : null}
        </ul>
      </div>
    </EditorPopover>
  );
}
