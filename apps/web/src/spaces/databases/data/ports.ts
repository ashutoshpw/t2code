import { executeAtomQuery, type AtomCommandResult } from "@t2code/client-runtime/state/runtime";
import { createDatabaseMutations } from "@t2code/client-runtime/state/spaces-database-mutations";
import type { EnvironmentId } from "@t2code/contracts";
import {
  type SpaceCursor,
  type SpaceDatabaseId,
  type SpaceDataSourceId,
  type SpaceDatabaseQueryInput,
  type SpaceId,
  type SpacePageId,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import type { AtomRegistry } from "effect/reactivity";

import { randomUUID } from "../../../lib/utils";
import { spacesEnvironment } from "../../../state/spaces";
import { spaceRootReorder } from "../../sessionRuntime";

/**
 * The only module of the database feature that talks to the server layer. Browser tests replace
 * it with the in-memory fake in `../test/fakeDatabase.ts`.
 */
const db = spacesEnvironment.databases;

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw Cause.squash(result.cause);
}

const mutations = createDatabaseMutations(db, {
  newMutationId: randomUUID,
  now: () => Date.now(),
});

export const databasePorts = {
  databaseAtom: (environmentId: EnvironmentId, databaseId: SpaceDatabaseId) =>
    db.database({ environmentId, input: { environmentId, databaseId } }),
  rowAtom: (environmentId: EnvironmentId, pageId: SpacePageId) =>
    db.row({ environmentId, input: { environmentId, pageId } }),
  listAtom: (environmentId: EnvironmentId, spaceId: SpaceId) =>
    db.list({ environmentId, input: { environmentId, spaceId } }),
  /** One page of the space's databases (every space's when `spaceId` is absent), after `cursor`. */
  listPage: async (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    spaceId: SpaceId | undefined,
    cursor: SpaceCursor | undefined,
  ) =>
    unwrap(
      await executeAtomQuery(
        registry,
        db.list({
          environmentId,
          input: {
            environmentId,
            ...(spaceId === undefined ? {} : { spaceId }),
            ...(cursor === undefined ? {} : { cursor }),
          },
        }),
        { refresh: true, reportFailure: false },
      ),
    ),
  /** Fetched imperatively: no query atom stays subscribed, so a write never refetches windows. */
  query: async (registry: AtomRegistry.AtomRegistry, input: SpaceDatabaseQueryInput) =>
    unwrap(
      await executeAtomQuery(registry, db.query({ environmentId: input.environmentId, input }), {
        refresh: true,
        reportFailure: false,
      }),
    ),
  run: mutations,
  permission: {
    cells: db.updateRows.permissionAtom,
    rows: db.createRows.permissionAtom,
    schema: db.updateSchema.permissionAtom,
    views: db.updateView.permissionAtom,
    create: db.create.permissionAtom,
    rename: db.update.permissionAtom,
  },
  changed: {
    database: db.databaseChanged,
    dataSource: db.dataSourceChanged,
  },
  rowPageChanged: db.rowPageChanged,
  /** Through the structure owner, as "Move to trash" on a page does, so journal and receipts stay whole. */
  trashRow: async (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    pageId: SpacePageId,
    dataSourceId: SpaceDataSourceId,
  ): Promise<void> => {
    db.noteRowDataSource(registry, environmentId, pageId, dataSourceId);
    const owner = spaceRootReorder(registry, environmentId);
    if (!owner.getSnapshot().hydrated) await owner.hydrate();
    await owner.previewRecovery(pageId, "trash");
    const preview = owner.getSnapshot().recoveryPreview;
    if (preview?.pageId !== pageId || preview.operation !== "trash")
      throw new Error("Couldn't move the row to trash");
    await owner.confirmRecovery(preview, false);
    db.rowPageChanged(registry, environmentId, pageId);
  },
};
