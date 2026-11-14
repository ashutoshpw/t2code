import { useAtomValue } from "@effect/atom-react";

import { useEnvironmentQuery } from "~/state/query";
import { spacesEnvironment } from "~/state/spaces";
import { createSyncedController } from "./syncedController";
import type { SyncedPorts } from "./SyncedContext";

export const defaultSyncedPorts: SyncedPorts = {
  useSubtree: (environmentId, blockId) => {
    const query = useEnvironmentQuery(
      blockId === null
        ? null
        : spacesEnvironment.readSubtree({ environmentId, input: { environmentId, blockId } }),
    );
    return { data: query.data, error: query.error };
  },
  useWritable: (environmentId) =>
    useAtomValue(spacesEnvironment.apply.permissionAtom(environmentId)),
  createController: createSyncedController,
};
