import { lazy, Suspense } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import { SpacePageTree } from "./SpacePageTree";

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
      <Suspense fallback={<p role="status">Loading recovery…</p>}>
        <SpaceRecoveryControls key={environmentId} environmentId={environmentId} />
      </Suspense>
      <SpacePageTree environmentId={environmentId} spaceId={spaceId} />
    </section>
  );
}
