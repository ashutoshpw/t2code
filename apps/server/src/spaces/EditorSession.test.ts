import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import {
  createSpaceServiceSessionAdapter,
  SpaceDocumentSession,
  type SpaceDocumentDraft,
  type SpaceServicePorts,
  type SpaceSaveRequest,
} from "../../../../packages/client-runtime/src/spaces/index.ts";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import type * as Scope from "effect/Scope";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as SpacesService from "./SpacesService.ts";

const environmentId = EnvironmentId.make("editor-service");
const block = (text: string, id = "a"): C.SpaceBlock => ({
  id: C.SpaceBlockId.make(id),
  parentId: null,
  order: (id === "a" ? "1" : "2").padStart(32, "0"),
  type: "paragraph",
  version: 1,
  content: { runs: [{ text, marks: [] }] },
});
const fixture = Effect.fn("SpaceEditorServiceTest.fixture")(function* <A, E>(
  use: (service: SpacesService.SpacesService["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-editor-" });
  return yield* SpacesService.SpacesService.pipe(
    Effect.flatMap(use),
    Effect.provide(
      SpacesService.layerFromPath(path.join(directory, "spaces.sqlite")).pipe(
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ),
        Layer.provide(Settings.layerTest({ spacesEnabled: true })),
      ),
    ),
  );
});

const boot = Effect.fn("SpaceEditorServiceTest.boot")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const library = yield* service.listSpaces({ environmentId });
  const created = yield* service.createPage({
    environmentId,
    receiptEpoch: library.mutationAdmission.epoch,
    mutationId: "create-page",
    spaceId: library.defaultSpaceId,
    baseRootOrderRevision: 0,
    title: "Document",
  });
  if (created.status !== "saved") throw new Error("Unexpected create conflict");
  const key = { environmentId, pageId: created.page.id };
  const opaque = { ...block("future neighbor", "b"), future: { toString: false, ordered: [2, 1] } };
  yield* service.applyBlockBatch({
    ...key,
    receiptEpoch: library.mutationAdmission.epoch,
    mutationId: "seed-blocks",
    baseRevision: 0,
    generation: 1,
    mutations: [
      { kind: "insert", block: block("initial") },
      { kind: "insert", block: opaque },
    ],
  });
  const capability = yield* service.getCapability(environmentId);
  if (!capability) throw new Error("Missing real capability");
  const jobs = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Queue.take(jobs).pipe(Effect.flatten, Effect.forever, Effect.forkScoped);
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    new Promise((resolve, reject) => {
      Queue.offerUnsafe(
        jobs,
        effect.pipe(
          Effect.matchCause({
            onSuccess: resolve,
            onFailure: (cause) => reject(Cause.squash(cause)),
          }),
        ),
      );
    });
  const ports: SpaceServicePorts = {
    getPage: (input) => run(service.getPage(input)),
    applyBlockBatch: (input) => run(service.applyBlockBatch(input)),
    lookupMutationReceipt: (input) => run(service.lookupMutationReceipt(input)),
    limits: () => capability.limits,
  };
  return { key, ports, run, opaque, capability };
});

it.layer(NodeServices.layer)("Production Spaces editor adapter", (it) => {
  it.effect("refuses a receipt delivered for a different operation", () =>
    fixture((service) =>
      Effect.gen(function* () {
        const { key, ports } = yield* boot(service);
        const adapter = createSpaceServiceSessionAdapter(key, {
          ...ports,
          lookupMutationReceipt: async (input) => {
            const actual = await ports.lookupMutationReceipt(input);
            if (actual.status !== "found") return actual;
            return {
              status: "found" as const,
              receipt: {
                operation: "createSpace" as const,
                result: {
                  status: "saved" as const,
                  mutationId: actual.receipt.result.mutationId,
                  receiptEpoch: actual.receipt.result.receiptEpoch,
                  space: (await ports.getPage(key)).space,
                },
              },
            };
          },
        });
        const admission = yield* service.getPage(key);
        yield* Effect.promise(async () => {
          const request: SpaceSaveRequest = {
            key,
            mutationId: "wrong-operation",
            receiptEpoch: admission.mutationAdmission.epoch,
            baseRevision: 1,
            generation: 1,
            mutations: [{ kind: "replace", block: block("committed") }],
          };
          await adapter.save(request);
          try {
            await adapter.lookupReceipt(request);
            assert.fail("Expected operation correlation error");
          } catch (error) {
            assert.include(String(error), "Unexpected Spaces receipt operation");
          }
        });
      }),
    ),
  );
  it.effect(
    "recovers a lost real committed response by receipt once and preserves the later generation",
    () =>
      fixture((service) =>
        Effect.gen(function* () {
          const { key, ports, opaque, run } = yield* boot(service);
          let stored: SpaceDocumentDraft | null = null;
          let sends = 0;
          let lost = true;
          const adapter = createSpaceServiceSessionAdapter(key, {
            ...ports,
            applyBlockBatch: async (input) => {
              sends++;
              assert.deepEqual(stored?.pending?.mutations, input.mutations);
              assert.equal(stored?.pending?.receiptEpoch, input.receiptEpoch);
              const result = await ports.applyBlockBatch(input);
              if (lost) {
                lost = false;
                throw new Error("Real commit response lost");
              }
              return result;
            },
          });
          let ids = 0;
          const options = {
            adapter,
            drafts: {
              load: async () => stored,
              write: async (_key: C.SpacePageTarget, value: SpaceDocumentDraft | null) => {
                stored = value;
              },
            },
            createMutationId: () => `edit-${++ids}`,
            maxLoadedBlocks: 100,
            maxMutations: 100,
          };
          const session = new SpaceDocumentSession(key, options);
          yield* Effect.promise(async () => {
            await session.hydrate(await run(service.readBlocks({ ...key, revision: 1 })));
            session.apply([{ kind: "replace", block: block("committed") }]);
            try {
              await session.save();
              assert.fail("Expected lost response");
            } catch (error) {
              assert.include(String(error), "Real commit response lost");
            }
            const pending = session.getSnapshot().pending!;
            session.apply([{ kind: "replace", block: block("typed after send") }]);
            await session.persistDraft();
            const recovered = new SpaceDocumentSession(key, options);
            await recovered.hydrate(await run(service.readBlocks({ ...key, revision: 2 })));
            await recovered.save();
            assert.equal(sends, 1);
            assert.equal(recovered.getSnapshot().baseRevision, 2);
            assert.isTrue(recovered.getSnapshot().dirty);
            assert.deepEqual(recovered.getSnapshot().blocks, [block("typed after send"), opaque]);
            assert.deepEqual(await adapter.lookupReceipt(pending), {
              status: "saved",
              revision: 2,
            });
            await recovered.save();
            assert.equal(sends, 2);
            assert.equal(recovered.getSnapshot().baseRevision, 3);
            assert.deepEqual(stored?.mutations, []);
            assert.isNull(stored?.pending);
            assert.equal(stored?.history?.undo?.revision, 3);
            assert.deepEqual((await run(service.readBlocks({ ...key, revision: 3 }))).blocks, [
              block("typed after send"),
              opaque,
            ]);
          });
        }),
      ),
  );

  it.effect("retains a draft on a real competing revision and does not overwrite the server", () =>
    fixture((service) =>
      Effect.gen(function* () {
        const { key, ports, run } = yield* boot(service);
        const adapter = createSpaceServiceSessionAdapter(key, ports);
        let stored: SpaceDocumentDraft | null = null;
        const session = new SpaceDocumentSession(key, {
          adapter,
          drafts: {
            load: async () => null,
            write: async (_key, draft) => {
              stored = draft;
            },
          },
          createMutationId: () => "local-conflict",
          maxLoadedBlocks: 100,
          maxMutations: 100,
        });
        yield* Effect.promise(async () => {
          await session.hydrate(await run(service.readBlocks({ ...key, revision: 1 })));
          session.apply([{ kind: "replace", block: block("local") }]);
          await adapter.save({
            key,
            mutationId: "competing",
            receiptEpoch: (await adapter.getMutationAdmission()).epoch,
            baseRevision: 1,
            generation: 1,
            mutations: [{ kind: "replace", block: block("external") }],
          });
          await session.save();
          assert.equal(session.getSnapshot().status, "conflict");
          assert.equal(session.getSnapshot().conflictRevision, 2);
          assert.deepEqual(stored?.blocks[0], block("local"));
          assert.deepEqual(
            (await run(service.readBlocks({ ...key, revision: 2 }))).blocks[0],
            block("external"),
          );
        });
      }),
    ),
  );

  it.effect(
    "distinguishes active absent from expired unknown and replays retained intent despite narrower new policy",
    () =>
      fixture((service) =>
        Effect.gen(function* () {
          const { key, ports, run, capability } = yield* boot(service);
          let narrow = false;
          const adapter = createSpaceServiceSessionAdapter(key, {
            ...ports,
            limits: () =>
              narrow ? { ...capability.limits, maxMutationBytes: 1 } : capability.limits,
          });
          const admission = yield* service.getPage(key);
          const request: SpaceSaveRequest = {
            key,
            mutationId: "retained",
            receiptEpoch: admission.mutationAdmission.epoch,
            baseRevision: 1,
            generation: 1,
            mutations: [{ kind: "replace", block: block("saved") }],
          };
          yield* Effect.promise(async () => {
            assert.deepEqual(await adapter.lookupReceipt(request), { status: "absent" });
            assert.deepEqual(await adapter.save(request), { status: "saved", revision: 2 });
            narrow = true;
            assert.throws(() => adapter.validateNewRequest!(request), "exceeds");
            assert.deepEqual(await adapter.save(request), { status: "saved", revision: 2 });
            try {
              await adapter.save({ ...request, generation: 2 });
              assert.fail("Expected fingerprint mismatch");
            } catch (error) {
              assert.include(String(error), "SpaceMutationIdMismatchError");
            }
            const absent = { ...request, mutationId: "never-sent" };
            assert.deepEqual(await adapter.lookupReceipt(absent), { status: "absent" });
            await run(TestClock.adjust(86_400_001));
            assert.deepEqual(await adapter.lookupReceipt(absent), { status: "unknown" });
            assert.deepEqual(await adapter.lookupReceipt(request), {
              status: "saved",
              revision: 2,
            });
            assert.equal((await run(service.getPage(key))).page.revision, 2);
          });
        }),
      ),
  );

  it.effect.each(["mutationId", "receiptEpoch", "generation"] as const)(
    "refuses a miscorrelated %s acknowledgement from a real save",
    (field) =>
      fixture((service) =>
        Effect.gen(function* () {
          const { key, ports } = yield* boot(service);
          const adapter = createSpaceServiceSessionAdapter(key, {
            ...ports,
            applyBlockBatch: async (input) => {
              const actual = await ports.applyBlockBatch(input);
              return {
                ...actual,
                ...(field === "mutationId"
                  ? { mutationId: C.SpaceMutationId.make("wrong") }
                  : field === "receiptEpoch"
                    ? { receiptEpoch: C.SpaceReceiptEpoch.make("wrong") }
                    : { generation: actual.generation + 1 }),
              };
            },
          });
          const admission = yield* service.getPage(key);
          yield* Effect.promise(async () => {
            try {
              await adapter.save({
                key,
                mutationId: "correlate",
                receiptEpoch: admission.mutationAdmission.epoch,
                baseRevision: 1,
                generation: 1,
                mutations: [{ kind: "replace", block: block("actual") }],
              });
              assert.fail("Expected correlation error");
            } catch (error) {
              assert.include(String(error), "does not match");
            }
          });
        }),
      ),
  );
});
