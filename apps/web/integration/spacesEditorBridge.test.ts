import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import {
  createSpaceServiceSessionAdapter,
  type SpaceDocumentDraft,
  type SpaceServicePorts,
} from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as ServerEnvironment from "../../server/src/environment/ServerEnvironment.ts";
import * as Settings from "../../server/src/serverSettings.ts";
import * as SpacesService from "../../server/src/spaces/SpacesService.ts";
import { EditorState, TextSelection, type Command, type Transaction } from "@tiptap/pm/state";
import { SpaceDocumentController } from "../src/spaces/documentController.ts";
import { SpaceEditorBridge } from "../src/spaces/editorBridge.ts";
import { spaceDocumentBlocks } from "../src/spaces/document.ts";

const environmentId = EnvironmentId.make("editor-service");
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
  return { key, ports, run };
});

it.layer(NodeServices.layer)("Spaces editor commands with real SQLite", (it) => {
  it.effect.each([false, true])(
    "saves real editor commands once, resets acknowledged undo and retains later text (late reply: %s)",
    (late) =>
      fixture((service) =>
        Effect.gen(function* () {
          const { key, ports, run } = yield* boot(service);
          const committed = yield* Effect.sync(() => {
            let resolve!: () => void;
            const promise = new Promise<void>((done) => {
              resolve = done;
            });
            return { promise, resolve };
          });
          const reply = yield* Effect.sync(() => {
            let resolve!: () => void;
            const promise = new Promise<void>((done) => {
              resolve = done;
            });
            return { promise, resolve };
          });
          const requests: C.SpaceApplyBlockBatchInput[] = [];
          let stored: SpaceDocumentDraft | null = null;
          let mutationIds = 0;
          const controller = new SpaceDocumentController(
            key,
            {
              adapter: createSpaceServiceSessionAdapter(key, {
                ...ports,
                applyBlockBatch: async (input) => {
                  assert.equal(stored?.pending?.generation, input.generation);
                  assert.equal(stored?.pending?.receiptEpoch, input.receiptEpoch);
                  requests.push(input);
                  const result = await ports.applyBlockBatch(input);
                  if (late && requests.length === 1) {
                    committed.resolve();
                    await reply.promise;
                  }
                  return result;
                },
              }),
              drafts: {
                load: async () => null,
                write: async (_key, value) => {
                  stored = value;
                },
              },
              createMutationId: () => `editor-command-${++mutationIds}`,
              maxLoadedBlocks: 100,
              maxMutations: 100,
            },
            {
              getPage: () => ports.getPage(key),
              readBlocks: (input) => run(service.readBlocks(input)),
              windowLimit: () => 100,
            },
          );
          yield* Effect.promise(async () => {
            await controller.open();
            let ids = 0;
            const bridge = new SpaceEditorBridge(controller, () =>
              C.SpaceBlockId.make(`command-${++ids}`),
            );
            bridge.setWritable(true);
            let state = EditorState.create({
              doc: bridge.adapter.document,
              plugins: bridge.adapter.plugins(),
            });
            const dispatch = (tr: Transaction) => {
              state = bridge.apply(state, tr).state;
            };
            const command = (value: Command) => {
              assert.isTrue(value(state, dispatch));
            };
            const select = (id: string, offset = 0) => {
              let position = -1;
              state.doc.descendants((node, pos) => {
                if (node.attrs.block?.id === id) position = pos + 1 + offset;
              });
              dispatch(state.tr.setSelection(TextSelection.create(state.doc, position)));
            };
            const unsubscribe = controller.subscribe(() => {
              state = bridge.synchronize(state);
            });
            try {
              command(bridge.adapter.append());
              dispatch(state.tr.insertText("hello"));
              select("command-1", 2);
              command(bridge.adapter.split());
              select("command-2");
              command(bridge.adapter.joinBackward());
              command(bridge.adapter.undoLocal());
              command(bridge.adapter.redoLocal());
              const copied = bridge.adapter.copyBlocks(state, [C.SpaceBlockId.make("command-1")]);
              command(bridge.adapter.pasteBlocks(copied, key));
              const deletedTarget = spaceDocumentBlocks(state.doc).find(
                (block) => block.id === "command-3",
              )!;
              dispatch(
                state.tr.addMark(
                  1,
                  6,
                  state.schema.marks.space_block_mention!.create({
                    value: {
                      type: "block_mention",
                      version: 1,
                      target: { ...key, blockId: deletedTarget.id },
                    },
                  }),
                ),
              );
              command(bridge.adapter.remove(deletedTarget.id));
              select("command-1", 1);
              dispatch(state.tr.insertText("!"));
              const saving = controller.save();
              if (late) {
                await committed.promise;
                assert.isFalse(bridge.adapter.split()(state, dispatch));
                dispatch(state.tr.insertText("late"));
                reply.resolve();
              }
              await saving;
              assert.equal(requests.length, 1);
              const inserted = requests[0]!.mutations.filter((m) => m.kind === "insert");
              assert.equal(new Set(inserted.map((m) => m.block.id)).size, inserted.length);
              assert.equal(inserted.length, 3);
              assert.isTrue(inserted.every((m) => /^[0-9a-f]{32}$/.test(m.block.order)));
              assert.equal((await run(service.getPage(key))).page.revision, 1);
              const replayAdmission = await ports.getPage(key);
              const resurrection = await run(
                service
                  .applyBlockBatch({
                    ...key,
                    mutationId: C.SpaceMutationId.make("reference-resurrection"),
                    receiptEpoch: replayAdmission.mutationAdmission.epoch,
                    baseRevision: 1,
                    generation: 1,
                    mutations: [{ kind: "insert", block: deletedTarget }],
                  })
                  .pipe(Effect.flip),
              );
              assert.equal(resurrection._tag, "SpaceValidationError");
              if (resurrection._tag === "SpaceValidationError")
                assert.equal(resurrection.reason, "duplicate_id");
              assert.isFalse(bridge.adapter.undoLocal()(state, dispatch));
              assert.include(bridge.getSnapshot()!, "Saved changes cannot be undone");
              if (late) {
                assert.isTrue(controller.session.getSnapshot().dirty);
                assert.include(state.doc.textContent, "late");
              }
              select("command-1", 1);
              dispatch(state.tr.insertText("next"));
              command(bridge.adapter.undoLocal());
              command(bridge.adapter.redoLocal());
              const expected = spaceDocumentBlocks(state.doc);
              await controller.save();
              assert.equal(requests.length, 2);
              assert.equal(requests[1]!.baseRevision, 1);
              assert.equal(requests[1]!.mutations.length, 1);
              assert.equal(requests[1]!.mutations[0]!.kind, "replace");
              assert.deepEqual(
                (await run(service.readBlocks({ ...key, revision: 2 }))).blocks,
                expected,
              );
              assert.isNull(stored);
              assert.isFalse(bridge.adapter.redoLocal()(state, dispatch));
            } finally {
              unsubscribe();
            }
          });
        }),
      ),
  );
});
