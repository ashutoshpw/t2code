import { SearchIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const SEARCH_DEBOUNCE_MS = 250;

/** A search icon that expands into a box; Escape or an empty blur folds it back. */
export function ToolbarSearch({
  search,
  onSearch,
}: {
  readonly search: string;
  readonly onSearch: (search: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const change = (next: string) => {
    setDraft(next);
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      onSearch(next);
      setDraft(null);
    }, SEARCH_DEBOUNCE_MS);
  };
  const clear = () => {
    cancel();
    setDraft(null);
    onSearch("");
    setOpen(false);
  };
  if (!open && search === "")
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Search"
              onClick={() => setOpen(true)}
            />
          }
        >
          <SearchIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Search</TooltipPopup>
      </Tooltip>
    );
  return (
    <div className="w-44">
      <Input
        type="search"
        size="compact"
        aria-label="Search rows"
        placeholder="Type to search…"
        autoFocus
        value={draft ?? search}
        onChange={(event) => change(event.target.value)}
        onBlur={(event) => {
          if (event.target.value === "") clear();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
        }}
      />
    </div>
  );
}
