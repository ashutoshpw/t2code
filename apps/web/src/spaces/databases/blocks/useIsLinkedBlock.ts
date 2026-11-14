import type { SpaceBlockId, SpaceDatabaseId } from "@t2code/contracts/spaces";

import { useEnvironmentQuery } from "../../../state/query";
import { databasePorts } from "../data/ports";
import { useDatabaseBlockHost } from "./DatabaseBlockHost";

/** A database block is linked when another block is the database's home (derived by the server). */
export function isLinkedBlock(
  home: { readonly blockId: SpaceBlockId } | null | undefined,
  blockId: SpaceBlockId,
): boolean {
  return home !== null && home !== undefined && home.blockId !== blockId;
}

export function useIsLinkedBlock(blockId: SpaceBlockId, databaseId: SpaceDatabaseId): boolean {
  const host = useDatabaseBlockHost();
  const query = useEnvironmentQuery(
    host === null ? null : databasePorts.databaseAtom(host.environmentId, databaseId),
  );
  return isLinkedBlock(query.data?.database.home, blockId);
}
