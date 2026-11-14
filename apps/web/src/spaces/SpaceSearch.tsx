import { useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import type { SpaceReferenceController, SpaceSearchWindow } from "@t2code/client-runtime/spaces";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useSpaceReferenceController } from "./useSpaceReferences";
import { SpaceSourceOpen } from "./SpaceSourceOpen";

export default function SpaceSearch({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
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
    <section aria-label="Search Spaces" className="mb-4 space-y-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label>
          Search this environment
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              owner?.invalidate();
              request.current++;
              setState(null);
            }}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" disabled={!owner || saved?.busy}>
            Search / First results
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saved?.busy || !ready?.result.nextCursor}
            onClick={() => void run(true)}
          >
            Next results
          </Button>
        </div>
      </form>
      {!owner?.current() ? (
        <div>
          <p role="status">Search requires a current connection and read access.</p>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry source connection
          </Button>
        </div>
      ) : null}
      {saved?.busy ? <p role="status">Searching…</p> : null}
      {window && window.status !== "ready" ? (
        <p role={window.status === "error" ? "alert" : "status"}>
          {
            {
              idle: "Enter a search query.",
              "invalid-query": "Query exceeds the supported byte or term limit.",
              unsupported: "Search is not advertised by this environment.",
              unavailable:
                "Search became unavailable or exceeded client limits; refine the query or retry First results.",
              building: "Search index is building. Retry explicitly when ready.",
              error: "Search failed. Retry First results.",
            }[window.status]
          }
        </p>
      ) : null}
      {window?.status === "ready" && !ready ? (
        <p role="status">Results are stale. Request First results again.</p>
      ) : null}
      {ready ? (
        <>
          <p>Results for “{ready.query}”</p>
          {!ready.result.items.length ? (
            <p>
              {ready.result.nextCursor
                ? "No results in this window. Next results continues the bounded search."
                : "No results in this window; the search has ended."}
            </p>
          ) : null}
          <ul className="space-y-3">
            {ready.result.items.map((hit, index) => {
              const target = ready.target(index);
              return (
                <li key={JSON.stringify([hit.page.id, hit.blockId, index])}>
                  <p>
                    {hit.page.title || "Untitled page"} · {hit.blockId ? "Block" : "Page"}
                  </p>
                  <p>{hit.snippet}</p>
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
