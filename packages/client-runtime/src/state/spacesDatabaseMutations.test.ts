import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import {
  SpaceDataSourceId,
  SpaceMutationAdmissionError,
  SpaceReceiptEpoch,
  type SpaceMutationAdmission,
} from "@t2code/contracts/spaces";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { createDatabaseMutations, PREPARE_FAILED } from "./spacesDatabaseMutations.ts";
import type { SpacesDatabaseAtoms } from "./spacesDatabases.ts";

const env = EnvironmentId.make("env");
const source = SpaceDataSourceId.make("source");
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

// @effect-diagnostics-next-line globalDate:off
const iso = (ms: number) => new Date(ms).toISOString();
const admission = (epoch: string, acceptsInMs: number): SpaceMutationAdmission => ({
  epoch: SpaceReceiptEpoch.make(epoch),
  acceptsUntil: iso(NOW + acceptsInMs),
  retainUntil: iso(NOW + acceptsInMs * 2),
});

const staleEpoch = new SpaceMutationAdmissionError({ receiptEpoch: SpaceReceiptEpoch.make("old") });

function setup(options: {
  readonly cached?: SpaceMutationAdmission;
  /** What a list answer brings, in order; an empty list brings nothing. */
  readonly fresh: ReadonlyArray<SpaceMutationAdmission>;
  readonly refuse: number;
}) {
  const registry = AtomRegistry.make();
  const admissions = Atom.family((_id: EnvironmentId) =>
    Atom.make<SpaceMutationAdmission | undefined>(options.cached).pipe(Atom.keepAlive),
  );
  const sent: Array<{ epoch: string; mutationId: string }> = [];
  let lists = 0;
  let refused = 0;
  const db = {
    admission: admissions,
    list: () => {
      const next = options.fresh[lists++];
      return Atom.make(
        Effect.sync(() => {
          if (next !== undefined) registry.set(admissions(env), next);
          return { items: [] };
        }),
      );
    },
    updateRows: {
      run: async (
        _registry: AtomRegistry.AtomRegistry,
        command: { input: { receiptEpoch: string; mutationId: string } },
      ) => {
        sent.push({ epoch: command.input.receiptEpoch, mutationId: command.input.mutationId });
        if (refused++ < options.refuse)
          return { _tag: "Failure" as const, cause: Cause.fail(staleEpoch) };
        return { _tag: "Success" as const, value: { dataRevision: 7 } };
      },
    },
  };
  let ids = 0;
  const mutations = createDatabaseMutations(db as never as SpacesDatabaseAtoms, {
    newMutationId: () => `m${++ids}`,
    now: () => NOW,
  });
  return { registry, sent, mutations, lists: () => lists, admissions };
}

const rows = { dataSourceId: source, rows: [] };

describe("createDatabaseMutations", () => {
  it("sends with the cached epoch and a new mutation id, without asking for another", async () => {
    const { registry, sent, mutations, lists } = setup({
      cached: admission("cached", 60_000),
      fresh: [],
      refuse: 0,
    });
    const result = await mutations.updateRows(registry, env, rows);
    expect(result.dataRevision).toBe(7);
    expect(sent).toEqual([{ epoch: "cached", mutationId: "m1" }]);
    expect(lists()).toBe(0);
  });

  it("fetches a fresh admission when the cached one is about to expire", async () => {
    const { registry, sent, mutations, lists } = setup({
      cached: admission("old", 5_000),
      fresh: [admission("fresh", 60_000)],
      refuse: 0,
    });
    await mutations.updateRows(registry, env, rows);
    expect(lists()).toBe(1);
    expect(sent.map((entry) => entry.epoch)).toEqual(["fresh"]);
  });

  it("refreshes and retries once after a stale epoch, with a new mutation id", async () => {
    const { registry, sent, mutations, lists } = setup({
      cached: admission("stale", 60_000),
      fresh: [admission("fresh", 60_000)],
      refuse: 1,
    });
    await mutations.updateRows(registry, env, rows);
    expect(lists()).toBe(1);
    expect(sent).toEqual([
      { epoch: "stale", mutationId: "m1" },
      { epoch: "fresh", mutationId: "m2" },
    ]);
  });

  it("gives up after the second refusal", async () => {
    const { registry, sent, mutations } = setup({
      cached: admission("stale", 60_000),
      fresh: [admission("fresh", 60_000)],
      refuse: 2,
    });
    await expect(mutations.updateRows(registry, env, rows)).rejects.toBeInstanceOf(
      SpaceMutationAdmissionError,
    );
    expect(sent).toHaveLength(2);
  });

  it("fails with a plain message when no answer brings a usable admission", async () => {
    const { registry, sent, mutations } = setup({ fresh: [], refuse: 0 });
    await expect(mutations.updateRows(registry, env, rows)).rejects.toThrow(PREPARE_FAILED);
    expect(sent).toHaveLength(0);
  });
});
