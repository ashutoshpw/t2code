import type { SpaceCapability, SpaceDatabaseLimits } from "@t2code/contracts/spaces";

export const DATABASES_NEED_NEWER_SERVER = "Databases need a newer T2 Code server.";

/** The database limits when the server speaks version 2 and has databases on; null otherwise. */
export function databaseLimitsOf(
  capability: SpaceCapability | undefined,
): SpaceDatabaseLimits | null {
  return capability?.version === 2 && capability.features?.databases === true
    ? (capability.limits.databases ?? null)
    : null;
}
