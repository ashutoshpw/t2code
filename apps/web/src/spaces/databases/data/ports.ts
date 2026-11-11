import { executeAtomQuery, type AtomCommandResult } from "@t2code/client-runtime/state/runtime";
import type { EnvironmentId } from "@t2code/contracts";
import {
  SpaceMutationAdmissionError,
  SpaceMutationId,
  type SpaceCursor,
  type SpaceDatabaseId,
  type SpaceDataSourceId,
  type SpaceDatabaseQueryInput,
  type SpaceId,
  type SpacePageId,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
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

const isAdmissionError = Schema.is(SpaceMutationAdmissionError);
const ADMISSION_MARGIN_MS = 10_000;
const PREPARE_FAILED = "Couldn't prepare the change. Try again.";

async function admission(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const atom = db.admission(environmentId);
  const usable = () => {
    const current = registry.get(atom);
    return current !== undefined &&
      Date.parse(current.acceptsUntil) - Date.now() > ADMISSION_MARGIN_MS
      ? current
      : undefined;
  };
  const known = usable();
  if (known !== undefined) return known;
  // Any answer carries a fresh admission; a one-row list is the cheapest.
  await executeAtomQuery(registry, db.list({ environmentId, input: { environmentId, limit: 1 } }), {
    refresh: true,
    reportFailure: false,
  });
  const refreshed = usable();
  if (refreshed === undefined) throw new Error(PREPARE_FAILED);
  return refreshed;
}

type MutationFields = "environmentId" | "mutationId" | "receiptEpoch";
function mutation<
  Input extends { readonly environmentId: EnvironmentId },
  Result,
  Failure,
>(command: {
  readonly run: (
    registry: AtomRegistry.AtomRegistry,
    input: { readonly environmentId: EnvironmentId; readonly input: Input },
  ) => Promise<AtomCommandResult<Result, Failure>>;
}) {
  return async (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    input: Omit<Input, MutationFields>,
  ): Promise<Result> => {
    const attempt = async () => {
      const { epoch } = await admission(registry, environmentId);
      return unwrap(
        await command.run(registry, {
          environmentId,
          input: {
            ...input,
            environmentId,
            mutationId: SpaceMutationId.make(randomUUID()),
            receiptEpoch: epoch,
          } as unknown as Input,
        }),
      );
    };
    try {
      return await attempt();
    } catch (failure) {
      if (!isAdmissionError(failure)) throw failure;
      // A stale epoch stays cached until something refetches: drop it and ask for a fresh one once.
      registry.set(db.admission(environmentId), undefined);
      return await attempt();
    }
  };
}

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
  run: {
    create: mutation(db.create),
    update: mutation(db.update),
    updateSchema: mutation(db.updateSchema),
    updateDataSource: mutation(db.updateDataSource),
    createView: mutation(db.createView),
    updateView: mutation(db.updateView),
    deleteView: mutation(db.deleteView),
    createRows: mutation(db.createRows),
    updateRows: mutation(db.updateRows),
    moveRows: mutation(db.moveRows),
  },
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
