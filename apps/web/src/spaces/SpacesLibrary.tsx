import { lazy, Suspense } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment } from "../state/spaces";
import { SpacePageTable } from "./SpacePageTable";

const SpaceSearch = lazy(() => import("./SpaceSearch"));
const SpaceRecoveryControls = lazy(() => import("./SpaceRecoveryControls"));
const CreatePageButton = lazy(() =>
  import("./SpaceCreateControls").then((module) => ({ default: module.CreatePageButton })),
);
const CreateStatus = lazy(() =>
  import("./SpaceCreateControls").then((module) => ({ default: module.CreateStatus })),
);

export function SpacesLibrary({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}) {
  const title = useEnvironmentQuery(
    spacesEnvironment.pages({ environmentId, input: { environmentId, spaceId, limit: 1 } }),
  ).data?.space.title;
  return (
    <section
      className="scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-y-auto"
      aria-label="Space library"
    >
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-3xl font-semibold">{title}</h1>
          <div className="flex items-center gap-2">
            <Suspense
              fallback={
                <span role="status" className="text-sm text-muted-foreground">
                  Loading recovery…
                </span>
              }
            >
              <SpaceRecoveryControls key={environmentId} environmentId={environmentId} />
            </Suspense>
            <Suspense fallback={null}>
              <CreatePageButton environmentId={environmentId} spaceId={spaceId} label="New page" />
            </Suspense>
          </div>
        </header>
        <Suspense fallback={null}>
          <CreateStatus environmentId={environmentId} />
        </Suspense>
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              Loading search…
            </p>
          }
        >
          <SpaceSearch
            key={JSON.stringify([environmentId, spaceId])}
            environmentId={environmentId}
            spaceId={spaceId}
          />
        </Suspense>
        <SpacePageTable
          key={JSON.stringify([environmentId, spaceId])}
          environmentId={environmentId}
          spaceId={spaceId}
        />
      </div>
    </section>
  );
}
