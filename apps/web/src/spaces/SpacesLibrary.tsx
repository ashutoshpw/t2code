import { lazy, Suspense } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import { SpacePageTree } from "./SpacePageTree";

const SpaceSearch = lazy(() => import("./SpaceSearch"));
const SpaceRecoveryControls = lazy(() => import("./SpaceRecoveryControls"));

export function SpacesLibrary({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}) {
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-4"
      aria-label="Space library"
    >
      <div className="max-h-1/2 min-h-0 shrink-0 overflow-y-auto">
        <Suspense fallback={<p role="status">Loading recovery…</p>}>
          <SpaceRecoveryControls key={environmentId} environmentId={environmentId} />
        </Suspense>
        <Suspense fallback={<p role="status">Loading search…</p>}>
          <SpaceSearch
            key={JSON.stringify([environmentId, spaceId])}
            environmentId={environmentId}
            spaceId={spaceId}
          />
        </Suspense>
      </div>
      <SpacePageTree environmentId={environmentId} spaceId={spaceId} />
    </section>
  );
}
