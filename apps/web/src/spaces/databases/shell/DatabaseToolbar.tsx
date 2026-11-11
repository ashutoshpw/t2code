import { useRef, useState } from "react";

import { Input } from "~/components/ui/input";
import { ViewControls } from "../controls/ViewControls";
import { NewRowMenu } from "./NewRowMenu";
import { WriterStatus } from "./WriterStatus";

const SEARCH_DEBOUNCE_MS = 250;

export function DatabaseToolbar({
  search,
  onSearch,
}: {
  readonly search: string;
  readonly onSearch: (search: string) => void;
}) {
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
        <NewRowMenu />
      </div>
    </div>
  );
}
