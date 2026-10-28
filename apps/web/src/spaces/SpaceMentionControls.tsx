import { createContext, useContext, useRef, useState, useSyncExternalStore } from "react";
import { MarkViewContent, type MarkViewProps } from "@tiptap/react";
import type { SpacePageNavigationTarget, SpaceSearchWindow } from "@t2code/client-runtime/spaces";
import { AtSignIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { Input } from "../components/ui/input";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import type { SpaceMentionController, SpaceMentionMark, SpaceMentionSelection } from "./mentions";

export const SpaceMentionContext = createContext<{
  owner: SpaceMentionController | null;
  current: () => boolean;
  onOpen: (target: SpacePageNavigationTarget) => void;
} | null>(null);
export function SpaceMentionView({ mark }: MarkViewProps) {
  const context = useContext(SpaceMentionContext),
    owner = context?.owner ?? null;
  useSyncExternalStore(owner?.subscribe ?? noSubscribe, owner?.getSnapshot ?? noVersion);
  const value = mark.attrs.value as SpaceMentionMark;
  const presentation = owner?.presentation(value);
  const allowed = !!context?.current() && !!owner?.canActivate(value);
  const activate = async () => {
    if (!allowed || !context?.current()) return;
    const destination = await owner?.activate(value);
    if (destination && context.current() && owner?.current()) context.onOpen(destination);
  };
  return (
    <span
      role="link"
      tabIndex={allowed ? 0 : -1}
      aria-disabled={!allowed}
      contentEditable={false}
      className="cursor-pointer rounded bg-muted px-1"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void activate();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          void activate();
        }
      }}
    >
      <MarkViewContent contentEditable={false} />
      {presentation?.status === "resolved" ? (
        <span>
          {" "}
          · {presentation.title}
          {value.type === "block_mention" ? " (block)" : ""}
        </span>
      ) : presentation?.status === "unavailable" ? (
        <span> (current source unavailable)</span>
      ) : null}
    </span>
  );
}
function noSubscribe() {
  return () => {};
}
function noVersion() {
  return 0;
}

export function SpaceMentionControls({
  owner,
  capture,
  available,
  onInserted,
}: {
  owner: SpaceMentionController | null;
  capture: () => SpaceMentionSelection;
  available: boolean;
  onInserted: () => void;
}) {
  const [selection, setSelection] = useState<SpaceMentionSelection | null>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{
    owner: SpaceMentionController;
    busy: boolean;
    window: SpaceSearchWindow | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const saved = state?.owner === owner ? state : null,
    window = saved?.window;
  const ready = window?.status === "ready" && window.current() ? window : null;
  const select = () => {
    try {
      setSelection(capture());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mention selection unavailable");
    }
  };
  const search = async (next = false) => {
    if (!owner || !selection?.current() || !owner.supported()) return;
    const id = ++request.current;
    setState({ owner, busy: true, window: null });
    setError(null);
    const result = await (next && ready ? ready.next() : owner.search(query));
    if (request.current === id) setState({ owner, busy: false, window: result });
  };
  const choose = async (index: number) => {
    if (!owner || !ready || !selection) return;
    setState({ owner, busy: true, window: ready });
    await owner
      .choose(ready, index, selection)
      .then((inserted) => {
        if (inserted) {
          setSelection(null);
          onInserted();
        } else
          setError(
            "Source or editor selection changed, or the label exceeds its limit. Explicitly reselect the editor position and search again.",
          );
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Mention was not inserted");
      })
      .finally(() => {
        setState({ owner, busy: false, window: ready });
      });
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Insert page or block mention…"
              disabled={!available || !owner?.supported()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={select}
            />
          }
        >
          <AtSignIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Insert page or block mention…</TooltipPopup>
      </Tooltip>
      {selection ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              request.current++;
              setSelection(null);
            }
          }}
        >
          <DialogPopup>
            <DialogTitle>Choose a current page or block</DialogTitle>
            <p>
              The stored label stays unchanged when its source is renamed. Activate a mention to
              resolve its current title and location.
            </p>
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void search();
              }}
            >
              <label>
                Search this environment
                <Input
                  value={query}
                  maxLength={254}
                  onChange={(event) => {
                    request.current++;
                    setQuery(event.target.value);
                    setState(null);
                  }}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant="outline"
                  disabled={saved?.busy || !selection.current() || !owner?.supported()}
                >
                  Search / First results
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={saved?.busy || !selection.current() || !ready?.result.nextCursor}
                  onClick={() => void search(true)}
                >
                  Next results
                </Button>
              </div>
            </form>
            {!selection.current() ? (
              <p role="status">
                The editor position changed. Close this chooser, select the intended position and
                open it again.
              </p>
            ) : null}
            {!owner?.supported() ? (
              <p role="status">
                Mentions require a current readable connection with search and reference resolution
                support.
              </p>
            ) : null}
            {saved?.busy ? <p role="status">Resolving…</p> : null}
            {window && window.status !== "ready" ? (
              <p role={window.status === "error" ? "alert" : "status"}>
                {
                  {
                    idle: "Enter a query.",
                    "invalid-query": "Query exceeds the byte or term limit.",
                    unsupported: "Search/reference resolution is unavailable.",
                    unavailable: "Results became unavailable. Retry First results explicitly.",
                    building: "Search index is building. Retry First results explicitly.",
                    error: "Search failed. Retry explicitly.",
                  }[window.status]
                }
              </p>
            ) : null}
            {ready ? (
              <ul className="space-y-2" aria-label="Mention results">
                {!ready.result.items.length ? (
                  <li>
                    {ready.result.nextCursor
                      ? "No results in this window. Next results continues the search."
                      : "No results; this search has ended."}
                  </li>
                ) : null}
                {ready.result.items.map((hit, index) => (
                  <li key={JSON.stringify([hit.page.id, hit.blockId, index])}>
                    <p>
                      {hit.page.title || "Untitled page"} · {hit.blockId ? "Block" : "Page"}
                    </p>
                    <p>{hit.snippet}</p>
                    <Button
                      variant="outline"
                      disabled={saved?.busy || !selection.current() || !owner?.supported()}
                      onClick={() => void choose(index)}
                    >
                      Insert {hit.blockId ? "block" : "page"} mention
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
          </DialogPopup>
        </Dialog>
      ) : error ? (
        <p role="alert" className="basis-full text-sm">
          {error}
        </p>
      ) : null}
    </>
  );
}
