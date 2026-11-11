import type { EnvironmentId } from "@t2code/contracts";
import {
  SpaceMutationAdmissionError,
  SpaceMutationId,
  type SpaceReceiptEpoch,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { AtomRegistry } from "effect/reactivity";

import { executeAtomQuery, type AtomCommandResult } from "./runtime.ts";
import type { SpacesDatabaseAtoms } from "./spacesDatabases.ts";

type Registry = AtomRegistry.AtomRegistry;

const isAdmissionError = Schema.is(SpaceMutationAdmissionError);
const ADMISSION_MARGIN_MS = 10_000;
export const PREPARE_FAILED = "Couldn't prepare the change. Try again.";

type MutationFields = "environmentId" | "mutationId" | "receiptEpoch";
interface Fields {
  readonly environmentId: EnvironmentId;
  readonly mutationId: SpaceMutationId;
  readonly receiptEpoch: SpaceReceiptEpoch;
}

export interface DatabaseMutationOptions {
  newMutationId(): string;
  now(): number;
}

function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw Cause.squash(result.cause);
}

/**
 * Every database write carries the receipt epoch of the newest admission an answer brought. A stale
 * epoch is refused once: the cached admission is dropped, a fresh one is fetched, and the write is
 * sent again with a new mutation id.
 */
export function createDatabaseMutations(db: SpacesDatabaseAtoms, options: DatabaseMutationOptions) {
  async function admission(registry: Registry, environmentId: EnvironmentId) {
    const atom = db.admission(environmentId);
    const usable = () => {
      const current = registry.get(atom);
      return current !== undefined &&
        Date.parse(current.acceptsUntil) - options.now() > ADMISSION_MARGIN_MS
        ? current
        : undefined;
    };
    const known = usable();
    if (known !== undefined) return known;
    // Any answer carries a fresh admission; a one-row list is the cheapest.
    await executeAtomQuery(
      registry,
      db.list({ environmentId, input: { environmentId, limit: 1 } }),
      { refresh: true, reportFailure: false },
    );
    const refreshed = usable();
    if (refreshed === undefined) throw new Error(PREPARE_FAILED);
    return refreshed;
  }

  function mutation<Input extends { readonly environmentId: EnvironmentId }, Result, Failure>(
    command: {
      readonly run: (
        registry: Registry,
        input: { readonly environmentId: EnvironmentId; readonly input: Input },
      ) => Promise<AtomCommandResult<Result, Failure>>;
    },
    compose: (input: Omit<Input, MutationFields>, fields: Fields) => Input,
  ) {
    return async (
      registry: Registry,
      environmentId: EnvironmentId,
      input: Omit<Input, MutationFields>,
    ): Promise<Result> => {
      const attempt = async () => {
        const { epoch } = await admission(registry, environmentId);
        return unwrap(
          await command.run(registry, {
            environmentId,
            input: compose(input, {
              environmentId,
              mutationId: SpaceMutationId.make(options.newMutationId()),
              receiptEpoch: epoch,
            }),
          }),
        );
      };
      try {
        return await attempt();
      } catch (failure) {
        if (!isAdmissionError(failure)) throw failure;
        registry.set(db.admission(environmentId), undefined);
        return await attempt();
      }
    };
  }

  return {
    create: mutation(db.create, (input, fields) => ({ ...input, ...fields })),
    update: mutation(db.update, (input, fields) => ({ ...input, ...fields })),
    updateSchema: mutation(db.updateSchema, (input, fields) => ({ ...input, ...fields })),
    updateDataSource: mutation(db.updateDataSource, (input, fields) => ({ ...input, ...fields })),
    createView: mutation(db.createView, (input, fields) => ({ ...input, ...fields })),
    updateView: mutation(db.updateView, (input, fields) => ({ ...input, ...fields })),
    deleteView: mutation(db.deleteView, (input, fields) => ({ ...input, ...fields })),
    createRows: mutation(db.createRows, (input, fields) => ({ ...input, ...fields })),
    updateRows: mutation(db.updateRows, (input, fields) => ({ ...input, ...fields })),
    moveRows: mutation(db.moveRows, (input, fields) => ({ ...input, ...fields })),
  };
}

export type DatabaseMutations = ReturnType<typeof createDatabaseMutations>;
