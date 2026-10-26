import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import { SpacePageTree } from "./SpacePageTree";

export function SpacesLibrary({
  environmentId,
  spaceId,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}) {
  return (
    <section className="p-4" aria-label="Space library">
      <SpacePageTree environmentId={environmentId} spaceId={spaceId} />
    </section>
  );
}
