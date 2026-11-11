import { newRowCells } from "@t2code/client-runtime/spaces";
import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ViewControls } from "../controls/ViewControls";
import { useDatabase, useDatabaseActions } from "./context";
import { WriterStatus } from "./WriterStatus";

const SEARCH_DEBOUNCE_MS = 250;
const localDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

export function DatabaseToolbar({
  search,
  onSearch,
}: {
  readonly search: string;
  readonly onSearch: (search: string) => void;
}) {
  const { model, view, columns } = useDatabase();
  const actions = useDatabaseActions();
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const change = (next: string) => {
    setDraft(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onSearch(next);
      setDraft(null);
    }, SEARCH_DEBOUNCE_MS);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        type="search"
        size="compact"
        aria-label="Search rows"
        placeholder="Search"
        className="w-40"
        value={draft ?? search}
        onChange={(event) => change(event.target.value)}
      />
      <ViewControls />
      <WriterStatus />
      <div className="ms-auto">
        <Button
          size="xs"
          disabled={!model.permissions.rows}
          onClick={() =>
            void actions
              .createRow({
                cells: newRowCells({
                  filter: view.filter,
                  properties: Object.fromEntries(
                    columns.map((column) => [column.property.id, column.property]),
                  ),
                  today: localDay(),
                }),
              })
              .then((row) => {
                if (row !== null) actions.openRow(row.page.id);
              })
          }
        >
          <PlusIcon />
          New
        </Button>
      </div>
    </div>
  );
}
