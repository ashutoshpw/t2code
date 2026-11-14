import type { SpaceCapability } from "@t2code/contracts/spaces";
import type { SpacesAvailability } from "@t2code/client-runtime/state/spaces";

export interface SpacesReadAccess {
  readonly availability: SpacesAvailability;
  readonly capability: SpaceCapability | undefined;
  readonly current: () => boolean;
}
