import { useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import type { SpaceReferenceController, SpaceSearchWindow } from "@t2code/client-runtime/spaces";
import { Button } from "../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { useSpaceReferenceController } from "./useSpaceReferences";
import { SpaceSourceOpen } from "./SpaceSourceOpen";

export default function SpaceSearch({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId?: SpaceId;
}) {
  const [attempt, setAttempt] = useState(0);
  const owner = useSpaceReferenceController(environmentId, attempt);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<{
    owner: SpaceReferenceController;
    busy: boolean;
    window: SpaceSearchWindow | null;
  } | null>(null);
  const request = useRef(0);
  const current = () => {
    const params = router.state.matches.at(-1)?.params ?? {};
    if (!spaceId) return router.state.location.pathname === "/spaces" && !("pageId" in params);
    return (
      "environmentId" in params &&
      params.environmentId === environmentId &&
      "spaceId" in params &&
      params.spaceId === spaceId &&
      !("pageId" in params)
    );
  };
  const saved = state?.owner === owner ? state : null;
  const window = saved?.window;
  const ready = window?.status === "ready" && window.current() ? window : null;
  const run = async (next = false) => {
    if (!owner || !current()) return;
    const id = ++request.current;
    setState({ owner, busy: true, window: null });
    const result = await (next && ready ? ready.next() : owner.search(query));
    if (request.current === id && current()) setState({ owner, busy: false, window: result });
  };
  return (
    <section aria-label="Search Spaces" className="space-y-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <InputGroup className="max-w-sm flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search this environment"
            placeholder="Search pages"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              owner?.invalidate();
              request.current++;
              setState(null);
            }}
          />
        </InputGroup>
        <Button
          type="submit"
          variant="outline"
          aria-label="Search"
          disabled={!owner || saved?.busy}
        >
          Search
        </Button>
        {ready?.result.nextCursor ? (
          <Button
            type="button"
            variant="ghost"
            disabled={saved?.busy}
            onClick={() => void run(true)}
          >
            Next results
          </Button>
        ) : null}
      </form>
      {!owner?.current() ? (
        <div className="flex items-center gap-2">
          <p role="status" className="text-sm text-muted-foreground">
            Search requires a current connection and read access.
          </p>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry source connection
          </Button>
        </div>
      ) : null}
      {saved?.busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          Searching…
        </p>
      ) : null}
      {window && window.status !== "ready" ? (
        <p
          role={window.status === "error" ? "alert" : "status"}
          className="text-sm text-muted-foreground"
        >
          {
            {
              idle: "Enter a search query.",
              "invalid-query": "Query exceeds the supported byte or term limit.",
              unsupported: "Search is not advertised by this environment.",
              unavailable:
                "Search became unavailable or exceeded client limits; refine the query or retry First results.",
              building: "Search is still getting ready. Try again in a moment.",
              error: "Search failed. Retry First results.",
            }[window.status]
          }
        </p>
      ) : null}
      {window?.status === "ready" && !ready ? (
        <p role="status" className="text-sm text-muted-foreground">
          Results are stale. Request First results again.
        </p>
      ) : null}
      {ready ? (
        <>
          <p className="text-sm text-muted-foreground">Results for “{ready.query}”</p>
          {!ready.result.items.length ? (
            <p className="text-sm text-muted-foreground">
              {ready.result.nextCursor
                ? "No matches yet. Choose Next results to keep searching."
                : "No results."}
            </p>
          ) : null}
          <ul className="divide-y rounded-lg border">
            {ready.result.items.map((hit, index) => {
              const target = ready.target(index);
              return (
                <li
                  key={JSON.stringify([hit.page.id, hit.blockId, index])}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {hit.page.title || "Untitled page"} · {hit.blockId ? "Block" : "Page"}
                    </p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{hit.snippet}</p>
                  </div>
                  {target ? (
                    <SpaceSourceOpen
                      owner={owner}
                      target={target}
                      current={() => current() && ready.current()}
                      label="current result"
                      onOpen={(destination) => {
                        if (!current() || !ready.current()) return;
                        void router.navigate({
                          to: "/spaces/$environmentId/$spaceId/$pageId",
                          params: destination,
                          search: destination.blockId ? { block: destination.blockId } : {},
                        });
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
