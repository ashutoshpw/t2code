import { EnvironmentId } from "@t2code/contracts";

import { FIXTURE_IDS } from "./fixtures";

export const TEST_ENVIRONMENT = EnvironmentId.make(FIXTURE_IDS.environment);

const LIMITS = {
  maxQueryRows: 100,
  maxRowsPerMutation: 50,
  maxCellsPerMutation: 200,
  maxFilterDepth: 3,
  maxFilterConditions: 20,
  maxSorts: 5,
  maxGroupPreviewRows: 25,
  maxCellItems: 20,
};

/** The environment presentation the shell reads, with or without the databases capability. */
export function environmentWith(
  databases: boolean,
  { hideTitle = true, chartFormFeed = true } = {},
) {
  return {
    environmentId: TEST_ENVIRONMENT,
    serverConfig: {
      environment: {
        capabilities: {
          spaces: {
            version: 2,
            features: databases
              ? {
                  databases: true,
                  ...(hideTitle ? { databaseHideTitle: true } : {}),
                  ...(chartFormFeed ? { databaseChartFormFeed: true } : {}),
                }
              : {},
            limits: databases ? { databases: LIMITS } : {},
          },
        },
      },
    },
  };
}
