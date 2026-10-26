import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCursor, SpaceId } from "@t2code/contracts/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { Button } from "../components/ui/button";
import { SpacesUnavailable } from "./SpacesUnavailable";

export function SpacesLibrary({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}) {
  const [cursor, setCursor] = useState<SpaceCursor>();
  const availability = useSpacesAvailability(environmentId);
  const environment = useEnvironment(environmentId);
  const limit = Math.min(
    50,
    environment?.serverConfig?.environment.capabilities.spaces?.limits.maxListRows ?? 1,
  );
  const query = useEnvironmentQuery(
    canBrowseSpaces(availability)
      ? spacesEnvironment.pages({
          environmentId,
          input: {
            environmentId,
            spaceId,
            limit,
            ...(cursor ? { cursor } : {}),
          },
        })
      : null,
  );
  if (!canBrowseSpaces(availability)) return <SpacesUnavailable availability={availability} />;
  return (
    <section className="p-4" aria-label="Space library">
      <h1 className="text-xl font-semibold">{query.data?.space.title ?? "Spaces"}</h1>
      {query.error ? (
        <div>
          <p role="alert">{query.error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setCursor(undefined);
              query.refresh();
            }}
          >
            Retry from first pages
          </Button>
        </div>
      ) : !query.data ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Loading pages…
        </p>
      ) : query.data.items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No pages in this space.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {query.data.items.map((page) => (
            <li key={page.id}>
              <Link
                to="/spaces/$environmentId/$spaceId/$pageId"
                params={{ environmentId, spaceId: page.spaceId, pageId: page.id }}
                search={{}}
                className="break-words text-sm underline"
              >
                {page.title || "Untitled page"}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex gap-2">
        {cursor ? (
          <Button variant="outline" onClick={() => setCursor(undefined)}>
            First pages
          </Button>
        ) : null}
        {query.data?.nextCursor && !query.error ? (
          <Button
            variant="outline"
            disabled={query.isPending}
            onClick={() => setCursor(query.data!.nextCursor!)}
          >
            Next pages
          </Button>
        ) : null}
      </div>
    </section>
  );
}
