import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert, expect } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  WS_METHODS,
} from "@t2code/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t2code/client-runtime/connection";
import type { RpcSession } from "../../../packages/client-runtime/src/rpc/session.ts";
import type { WsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import { createSpacesEnvironmentAtoms } from "@t2code/client-runtime/state/spaces";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";
import * as C from "@t2code/contracts/spaces";
import {
  SpaceReferenceController,
  SpaceImageUploads,
  decodeSpaceImageRecord,
  imageAssetId,
  mediaAssetId,
  type SpaceImageRecord,
  type SpaceImageStore,
  type SpaceReferenceAccess,
  createSpaceServiceSessionAdapter,
  type SpaceDocumentDraft,
  type SpaceServicePorts,
  readSpacePageLocation,
  SpaceRootReorder,
  decodeSpaceStructureJournal,
  checkSpaceStructureDrafts,
  type SpaceStructureJournal,
  copySpaceBlocks,
  decodeSpaceDocumentDraft,
} from "@t2code/client-runtime/spaces";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, type AsyncResult } from "effect/reactivity";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as ServerEnvironment from "../../server/src/environment/ServerEnvironment.ts";
import * as Settings from "../../server/src/serverSettings.ts";
import * as ServerConfig from "../../server/src/config.ts";
import * as ServerSecrets from "../../server/src/auth/ServerSecretStore.ts";
import * as SpacesRpc from "../../server/src/spaces/Rpc.ts";
import * as RpcAuthorization from "../../server/src/auth/RpcAuthorization.ts";
import { WS_RPC_SERVER_OPTIONS } from "../../server/src/ws.ts";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { HttpRouter } from "effect/http";
import * as ServerHttp from "../../server/src/http.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Clock from "effect/Clock";
import * as SpacesService from "../../server/src/spaces/SpacesService.ts";
import {
  EditorState,
  NodeSelection,
  TextSelection,
  type Command,
  type Transaction,
} from "@tiptap/pm/state";
import {
  SpaceDocumentController,
  SpaceDocumentControllers,
} from "../src/spaces/documentController.ts";
import { SpaceEditorBridge } from "../src/spaces/editorBridge.ts";
import { spaceDocumentBlocks } from "../src/spaces/document.ts";

const environmentId = EnvironmentId.make("editor-service");
const fixture = Effect.fn("SpaceEditorServiceTest.fixture")(function* <A, E>(
  use: (
    service: SpacesService.SpacesService["Service"],
    databasePath: string,
  ) => Effect.Effect<
    A,
    E,
    | Scope.Scope
    | ServerSecrets.ServerSecretStore
    | SpacesService.SpacesService
    | FileSystem.FileSystem
    | Path.Path
  >,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-editor-" });
  return yield* SpacesService.SpacesService.pipe(
    Effect.flatMap((service) => use(service, path.join(directory, "spaces.sqlite"))),
    Effect.provide(
      Layer.mergeAll(
        SpacesService.layerFromPath(path.join(directory, "spaces.sqlite")).pipe(
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
          ),
          Layer.provide(Settings.layerTest({ spacesEnabled: true })),
        ),
        ServerSecrets.layer.pipe(
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "editor-rpc-" }),
          ),
        ),
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
  return { key, ports, run, capability };
});

const queryRuntime = Effect.fn("SpaceEditorServiceTest.queryRuntime")(function* (
  ports: SpaceServicePorts,
  readBlocks: (input: C.SpaceReadBlocksInput) => Promise<C.SpaceReadBlocksResult>,
) {
  const blocked = yield* Queue.unbounded<{
    reply: Deferred.Deferred<void>;
    canceled: Deferred.Deferred<void>;
  }>();
  let holdNext = false;
  const client = {
    [WS_METHODS.spacesPagesGet]: (input: C.SpacePageGetInput) =>
      Effect.tryPromise(() => ports.getPage(input)),
    [WS_METHODS.spacesBlocksRead]: (input: C.SpaceReadBlocksInput) =>
      Effect.gen(function* () {
        const value = yield* Effect.tryPromise(() => readBlocks(input));
        if (holdNext) {
          holdNext = false;
          const reply = yield* Deferred.make<void>();
          const canceled = yield* Deferred.make<void>();
          yield* Queue.offer(blocked, { reply, canceled });
          yield* Deferred.await(reply).pipe(
            Effect.onInterrupt(() => Deferred.succeed(canceled, undefined)),
          );
        }
        return value;
      }),
  } as unknown as WsRpcProtocolClient;
  const makeSession = (): RpcSession => ({
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  });
  const sessions = yield* SubscriptionRef.make(Option.some(makeSession()));
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Editor integration",
      httpBaseUrl: "https://editor.example.test",
      wsBaseUrl: "wss://editor.example.test",
    }),
    state,
    session: sessions,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _id,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const queries = createSpacesEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
  );
  async function read<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) {
    const result = await executeAtomQuery(registry, atom, { refresh: true, reportFailure: false });
    if (result._tag === "Failure") throw Cause.squash(result.cause);
    return result.value;
  }
  return {
    registry,
    queries,
    read,
    blocked,
    sessions,
    makeSession,
    holdNext: () => {
      holdNext = true;
    },
  };
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function savedParagraph(
  id: string,
  text: string,
  order = "40000000000000000000000000000000",
): C.SpaceBlock {
  return {
    id: C.SpaceBlockId.make(id),
    parentId: null,
    order,
    type: "paragraph",
    version: 1,
    content: { runs: [{ text, marks: [] }] },
  };
}
const savedUndoFixture = Effect.fn("SpaceEditorServiceTest.savedUndo")(function* (
  service: SpacesService.SpacesService["Service"],
  blocks: readonly C.SpaceBlock[] = [savedParagraph("a", "original")],
) {
  const h = yield* boot(service);
  const admission = yield* service.getPage(h.key);
  yield* service.applyBlockBatch({
    ...h.key,
    mutationId: "seed-undo",
    receiptEpoch: admission.mutationAdmission.epoch,
    baseRevision: 0,
    generation: 1,
    mutations: blocks.map((block) => ({ kind: "insert", block })),
  });
  let stored: SpaceDocumentDraft | null = null,
    ids = 0,
    admissions = 0;
  const requests: C.SpaceApplyBlockBatchInput[] = [];
  const lookups: C.SpaceReceiptLookupInput[] = [];
  const transport = {
    lose: null as "before" | "after" | null,
    hold: false,
    committed: signal(),
    reply: signal(),
  };
  const persistence = { hold: false, fail: false, started: signal(), release: signal() };
  const createController = () =>
    new SpaceDocumentController(
      h.key,
      {
        adapter: createSpaceServiceSessionAdapter(h.key, {
          ...h.ports,
          getPage: async (input) => {
            admissions++;
            return h.ports.getPage(input);
          },
          applyBlockBatch: async (input) => {
            assert.deepEqual(stored?.pending, {
              key: h.key,
              mutationId: input.mutationId,
              receiptEpoch: input.receiptEpoch,
              baseRevision: input.baseRevision,
              generation: input.generation,
              mutations: input.mutations,
            });
            requests.push(input);
            const lose = transport.lose;
            transport.lose = null;
            if (lose === "before") throw new Error("request interrupted");
            const result = await h.ports.applyBlockBatch(input);
            if (lose === "after") throw new Error("reply interrupted");
            if (transport.hold) {
              transport.hold = false;
              transport.committed.resolve();
              await transport.reply.promise;
            }
            return result;
          },
          lookupMutationReceipt: async (input) => {
            lookups.push(input);
            return h.ports.lookupMutationReceipt(input);
          },
        }),
        drafts: {
          load: async () => stored,
          write: async (key, value) => {
            const decoded = value === null ? null : decodeSpaceDocumentDraft(value, key);
            if (persistence.hold && decoded?.pending) {
              persistence.hold = false;
              persistence.started.resolve();
              await persistence.release.promise;
            }
            if (persistence.fail) throw new Error("draft storage blocked");
            stored = decoded;
          },
        },
        createMutationId: () => `saved-history-${++ids}`,
        maxLoadedBlocks: 100,
        maxMutations: 100,
      },
      {
        getPage: () => h.ports.getPage(h.key),
        readBlocks: (input) => h.run(service.readBlocks(input)),
        windowLimit: () => 100,
      },
    );
  return {
    ...h,
    createController,
    transport,
    persistence,
    requests,
    lookups,
    admissions: () => admissions,
    stored: () => stored,
  };
});
function savedView(controller: SpaceDocumentController) {
  let ids = 0;
  const bridge = new SpaceEditorBridge(controller, () => C.SpaceBlockId.make(`saved-new-${++ids}`));
  bridge.setWritable(true);
  let state = EditorState.create({
    doc: bridge.adapter.document,
    plugins: bridge.adapter.plugins(),
  });
  const stop = controller.subscribe(() => {
    state = bridge.synchronize(state);
  });
  const dispatch = (tr: Transaction) => {
    state = bridge.apply(state, tr).state;
  };
  return {
    bridge,
    stop,
    get state() {
      return state;
    },
    dispatch,
    edit(text: string) {
      dispatch(state.tr.insertText(text));
    },
  };
}

it.layer(NodeServices.layer)("Spaces editor commands with real SQLite", (it) => {
  it.effect.each([false, true])(
    "retries only the saved compensation prefix after unsent persistence failure and retains newer edits (reload: %s)",
    (reload) =>
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* savedUndoFixture(service);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              view.edit("saved-");
              await controller.save();
              h.persistence.hold = true;
              const undoing = view.bridge.compensate("undo");
              const rejected = expect(undoing).rejects.toThrow("draft storage blocked");
              await h.persistence.started.promise;
              h.persistence.fail = true;
              const prefix = controller.session.getSnapshot().pending!;
              assert.isNotNull(prefix);
              view.edit("newer-");
              view.edit("again-");
              assert.include(view.state.doc.textContent, "newer-");
              const newer = controller.session.getSnapshot().blocks;
              assert.equal(h.requests.length, 1);
              h.persistence.release.resolve();
              await rejected;
              assert.equal(h.requests.length, 1);
              assert.equal(controller.session.getSnapshot().status, "draft");
              assert.isNotNull(controller.session.getSnapshot().persistenceError);
              h.persistence.fail = false;
              await controller.session.persistDraft();
              const retrying = reload ? h.createController() : controller;
              if (reload) await retrying.open();
              const admissions = h.admissions();
              await retrying.save();
              assert.equal(h.admissions(), admissions);
              assert.equal(h.requests.length, 2);
              assert.deepEqual(h.requests[1], {
                environmentId,
                pageId: h.key.pageId,
                mutationId: C.SpaceMutationId.make(prefix.mutationId),
                receiptEpoch: prefix.receiptEpoch!,
                baseRevision: prefix.baseRevision,
                generation: prefix.generation,
                mutations: prefix.mutations,
              });
              assert.equal(h.lookups.length, reload ? 1 : 0);
              if (reload) assert.deepEqual(h.lookups[0]?.request.input, h.requests[1]);
              assert.isNull(retrying.session.getSnapshot().pending);
              assert.isTrue(retrying.session.getSnapshot().dirty);
              assert.deepEqual(retrying.session.getSnapshot().blocks, newer);
              assert.equal(retrying.session.getSnapshot().baseRevision, 3);
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 3 }))).blocks,
                [savedParagraph("a", "original")],
              );
              await retrying.save();
              assert.equal(h.requests.length, 3);
              assert.equal(h.requests[2]!.baseRevision, 3);
              assert.notEqual(h.requests[2]!.mutationId, prefix.mutationId);
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 4 }))).blocks,
                newer,
              );
            } finally {
              h.persistence.release.resolve();
              view.stop();
            }
          });
        }),
      ),
  );
  it.effect.each(["delete", "join", "insert"] as const)(
    "refuses saved %s compensation rather than resurrecting retired identities",
    (operation) =>
      fixture((service) =>
        Effect.gen(function* () {
          const a = savedParagraph("a", "left"),
            b = {
              ...savedParagraph("b", "right", "c0000000000000000000000000000000"),
              content: {
                runs: [
                  {
                    text: "right",
                    marks: [
                      {
                        type: "block_mention",
                        version: 1,
                        target: {
                          environmentId,
                          pageId: C.SpacePageId.make("self"),
                          blockId: C.SpaceBlockId.make("b"),
                        },
                      },
                    ],
                  },
                ],
              },
            };
          const h = yield* savedUndoFixture(service, [a, b]);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              if (operation === "delete")
                assert.isTrue(view.bridge.adapter.remove(b.id)(view.state, view.dispatch));
              else if (operation === "insert")
                assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              else {
                let position = -1;
                view.state.doc.descendants((node, pos) => {
                  if (node.attrs.block?.id === b.id) position = pos + 1;
                });
                view.dispatch(
                  view.state.tr.setSelection(TextSelection.create(view.state.doc, position)),
                );
                assert.isTrue(view.bridge.adapter.joinBackward()(view.state, view.dispatch));
              }
              await controller.save();
              const before = controller.session.getSnapshot();
              assert.isFalse(await view.bridge.compensate("undo"));
              assert.equal(controller.session.getSnapshot(), before);
              assert.include(controller.session.compensationAvailability("undo")!, "structural");
              assert.equal(h.requests.length, 1);
              if (operation !== "insert") {
                const admission = await h.ports.getPage(h.key);
                const rejected = await h.run(
                  service
                    .applyBlockBatch({
                      ...h.key,
                      mutationId: "retired-undo",
                      receiptEpoch: admission.mutationAdmission.epoch,
                      baseRevision: 2,
                      generation: 1,
                      mutations: [{ kind: "insert", block: b }],
                    })
                    .pipe(Effect.flip),
                );
                assert.equal(rejected._tag, "SpaceValidationError");
                if (rejected._tag === "SpaceValidationError")
                  assert.equal(rejected.reason, "duplicate_id");
                const self = {
                  ...b,
                  content: {
                    runs: [
                      {
                        text: "copy",
                        marks: [
                          {
                            type: "block_mention",
                            version: 1,
                            target: { ...h.key, blockId: b.id },
                          },
                        ],
                      },
                    ],
                  },
                };
                const copied = copySpaceBlocks([self], h.key, () =>
                  C.SpaceBlockId.make("restored-copy"),
                );
                const copy = await h.run(
                  service.applyBlockBatch({
                    ...h.key,
                    mutationId: "fresh-copy",
                    receiptEpoch: admission.mutationAdmission.epoch,
                    baseRevision: 2,
                    generation: 1,
                    mutations: copied.map((block) => ({ kind: "insert", block })),
                  }),
                );
                assert.equal(copy.status, "saved");
                assert.deepEqual(
                  (await h.run(service.readBlocks({ ...h.key, revision: 3 }))).blocks.find(
                    (block) => block.id === "restored-copy",
                  ),
                  {
                    ...self,
                    id: C.SpaceBlockId.make("restored-copy"),
                    content: {
                      runs: [
                        {
                          text: "copy",
                          marks: [
                            {
                              type: "block_mention",
                              version: 1,
                              target: { ...h.key, blockId: "restored-copy" },
                            },
                          ],
                        },
                      ],
                    },
                  },
                );
              }
            } finally {
              view.stop();
            }
          });
        }),
      ),
  );
  it.effect.each([65536, 65537])(
    "admits saved history through the exact %i-byte window and retains only the last save",
    (bytes) =>
      fixture((service) =>
        Effect.gen(function* () {
          const ranks = [
            "40000000000000000000000000000000",
            "80000000000000000000000000000000",
            "c0000000000000000000000000000000",
          ];
          const empty = ranks.map((rank, i) => savedParagraph(`byte-${i}`, "", rank));
          const padding = bytes - new TextEncoder().encode(JSON.stringify(empty)).length;
          const blocks = ranks.map((rank, i) =>
            savedParagraph(
              `byte-${i}`,
              "x".repeat(Math.floor(padding / 3) + (i < padding % 3 ? 1 : 0)),
              rank,
            ),
          );
          assert.equal(new TextEncoder().encode(JSON.stringify(blocks)).length, bytes);
          const h = yield* savedUndoFixture(service, blocks);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)));
              view.edit("y");
              await controller.save();
              assert.isFalse(controller.session.getSnapshot().dirty);
              if (bytes === 65537) {
                assert.isFalse(await view.bridge.compensate("undo"));
                assert.include(controller.session.compensationAvailability("undo")!, "64 KiB");
                return;
              }
              const first = view.state.doc.textContent;
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)));
              view.edit("z");
              await controller.save();
              const second = view.state.doc.textContent;
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.equal(view.state.doc.textContent, first);
              assert.isFalse(await view.bridge.compensate("undo"));
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.equal(view.state.doc.textContent, second);
            } finally {
              view.stop();
            }
          });
        }),
      ),
  );
  it.effect(
    "submits saved content undo and redo as distinct guarded saves shared across views and reload",
    () =>
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* savedUndoFixture(service);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            try {
              view.edit("first-");
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(view.state.doc.textContent, "original");
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              await controller.save();
              assert.equal(controller.session.getSnapshot().baseRevision, 2);
              assert.isTrue(await peer.bridge.compensate("undo"));
              assert.equal(view.state.doc.textContent, "original");
              assert.equal(peer.state.doc.textContent, "original");
              assert.equal(controller.session.getSnapshot().baseRevision, 3);
              assert.isFalse(await view.bridge.compensate("undo"));
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.equal(peer.state.doc.textContent, "first-original");
              assert.deepEqual(
                h.requests.map((request) => request.baseRevision),
                [1, 2, 3],
              );
              assert.equal(new Set(h.requests.map((request) => request.mutationId)).size, 3);
              assert.equal(h.admissions(), 3);
              assert.isTrue(
                h.requests.every((request) =>
                  request.mutations.every((mutation) => mutation.kind === "replace"),
                ),
              );
              peer.bridge.setWritable(false);
              assert.isFalse(await peer.bridge.compensate("undo"));
              assert.equal(h.requests.length, 3);
              const restored = h.createController();
              await restored.open();
              const reopened = savedView(restored);
              try {
                assert.isTrue(await reopened.bridge.compensate("undo"));
                assert.equal(reopened.state.doc.textContent, "original");
              } finally {
                reopened.stop();
              }
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
  );
  it.effect("keeps the attempted saved undo draft on a real revision conflict without rebase", () =>
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* savedUndoFixture(service);
        yield* Effect.promise(async () => {
          const controller = h.createController();
          await controller.open();
          const view = savedView(controller);
          try {
            view.edit("saved-");
            await controller.save();
            const current = await h.ports.getPage(h.key);
            const external = savedParagraph("a", "external");
            await h.run(
              service.applyBlockBatch({
                ...h.key,
                mutationId: "external",
                receiptEpoch: current.mutationAdmission.epoch,
                baseRevision: 2,
                generation: 1,
                mutations: [{ kind: "replace", block: external }],
              }),
            );
            assert.isFalse(await view.bridge.compensate("undo"));
            assert.equal(controller.session.getSnapshot().status, "conflict");
            assert.equal(controller.session.getSnapshot().baseRevision, 2);
            assert.equal(controller.session.getSnapshot().history.action, "undo");
            assert.equal(view.state.doc.textContent, "original");
            assert.deepEqual(h.stored()?.blocks, [savedParagraph("a", "original")]);
            assert.deepEqual((await h.run(service.readBlocks({ ...h.key, revision: 3 }))).blocks, [
              external,
            ]);
            const admissions = h.admissions();
            await expect(controller.save()).rejects.toThrow("conflict");
            assert.equal(h.admissions(), admissions);
            assert.equal(h.requests.length, 2);
            await controller.discard();
            assert.equal(view.state.doc.textContent, "external");
            assert.isFalse(await view.bridge.compensate("undo"));
          } finally {
            view.stop();
          }
        });
      }),
    ),
  );
  it.effect.each(["before", "after"] as const)(
    "recovers saved undo after %s interruption using the exact persisted receipt intent",
    (lose) =>
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* savedUndoFixture(service);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              view.edit("saved-");
              await controller.save();
              h.transport.lose = lose;
              await expect(view.bridge.compensate("undo")).rejects.toThrow("interrupted");
              const pending = controller.session.getSnapshot().pending!;
              const wire = JSON.stringify(h.requests[1]);
              assert.equal(h.stored()?.history?.action, "undo");
              assert.isFalse(await view.bridge.compensate("redo"));
              const restored = h.createController();
              await restored.open();
              assert.equal(restored.session.getSnapshot().status, "uncertain");
              const admissionCount = h.admissions();
              await restored.save();
              assert.equal(h.admissions(), admissionCount);
              assert.equal(JSON.stringify(h.lookups[0]?.request.input), wire);
              assert.equal(restored.session.getSnapshot().baseRevision, 3);
              assert.isNull(restored.session.getSnapshot().pending);
              assert.isNull(restored.session.compensationAvailability("redo"));
              if (lose === "before") {
                assert.equal(h.requests.length, 3);
                assert.equal(JSON.stringify(h.requests[2]), wire);
              } else assert.equal(h.requests.length, 2);
              assert.equal(pending.receiptEpoch, h.requests[1]!.receiptEpoch);
            } finally {
              view.stop();
            }
          });
        }),
      ),
  );
  it.effect(
    "keeps edits typed during saved undo acknowledgement and guards redo until that draft is resolved",
    () =>
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* savedUndoFixture(service);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              view.edit("saved-");
              await controller.save();
              h.transport.hold = true;
              const undoing = view.bridge.compensate("undo");
              await h.transport.committed.promise;
              view.edit("late-");
              h.transport.reply.resolve();
              assert.isTrue(await undoing);
              assert.isTrue(controller.session.getSnapshot().dirty);
              assert.include(view.state.doc.textContent, "late-");
              assert.isFalse(await view.bridge.compensate("redo"));
              await controller.save();
              assert.equal(h.requests[2]!.baseRevision, 3);
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.equal(view.state.doc.textContent, "original");
            } finally {
              h.transport.reply.resolve();
              view.stop();
            }
          });
        }),
      ),
  );
  it.effect(
    "keeps two document views and exact pending intent across fresh v2 location ownership and moves",
    () =>
      fixture((service) =>
        Effect.gen(function* () {
          const { key, ports, run, capability } = yield* boot(service);
          assert.equal(capability.version, 2);
          const h = yield* queryRuntime(ports, (input) => run(service.readBlocks(input)));
          yield* Effect.promise(async () => {
            const drafts = new Map<C.SpacePageId, SpaceDocumentDraft | null>();
            const requests: C.SpaceApplyBlockBatchInput[] = [];
            const committed = signal(),
              reply = signal();
            let holdReply = false,
              reads = 0,
              ids = 0,
              mutations = 0;
            const documents = new SpaceDocumentControllers(
              (target) =>
                new SpaceDocumentController(
                  target,
                  {
                    adapter: createSpaceServiceSessionAdapter(target, {
                      ...ports,
                      applyBlockBatch: async (input) => {
                        assert.deepEqual(
                          drafts.get(target.pageId)?.pending?.mutations,
                          input.mutations,
                        );
                        requests.push(input);
                        const result = await ports.applyBlockBatch(input);
                        if (holdReply) {
                          holdReply = false;
                          committed.resolve();
                          await reply.promise;
                        }
                        return result;
                      },
                    }),
                    drafts: {
                      load: async (target) => drafts.get(target.pageId) ?? null,
                      write: async (target, value) => {
                        drafts.set(target.pageId, value);
                      },
                    },
                    createMutationId: () => `v2-editor-${++mutations}`,
                    maxLoadedBlocks: 100,
                    maxMutations: 100,
                  },
                  {
                    getPage: () => h.read(h.queries.page({ environmentId, input: target })),
                    readBlocks: (input) => {
                      reads++;
                      return h.read(h.queries.blocks({ environmentId, input }));
                    },
                    windowLimit: () => 100,
                  },
                ),
            );
            const route = documents.open(key),
              panel = documents.open(key);
            const leases = [route, panel];
            const controller = await route.ready;
            assert.equal(await panel.ready, controller);
            assert.isNull(controller.getSnapshot().error);
            assert.equal(reads, 1);
            const bridge = new SpaceEditorBridge(controller, () =>
              C.SpaceBlockId.make(`v2-block-${++ids}`),
            );
            const peer = new SpaceEditorBridge(controller, () =>
              C.SpaceBlockId.make(`v2-peer-${++ids}`),
            );
            bridge.setWritable(true);
            peer.setWritable(true);
            let state = EditorState.create({
              doc: bridge.adapter.document,
              plugins: bridge.adapter.plugins(),
            });
            let peerState = EditorState.create({
              doc: peer.adapter.document,
              plugins: peer.adapter.plugins(),
            });
            const stop = controller.subscribe(() => {
              state = bridge.synchronize(state);
              peerState = peer.synchronize(peerState);
            });
            const dispatch = (tr: Transaction) => {
              state = bridge.apply(state, tr).state;
            };
            try {
              assert.isTrue(bridge.adapter.append()(state, dispatch));
              dispatch(state.tr.insertText("unsaved text"));
              await controller.session.persistDraft();
              const dirty = controller.session.getSnapshot(),
                editor = state;
              const admission = (await ports.getPage(key)).mutationAdmission;
              const other = await run(
                service.createSpace({
                  environmentId,
                  mutationId: "v2-space",
                  receiptEpoch: admission.epoch,
                  title: "Destination",
                }),
              );
              const parent = await run(
                service.createPage({
                  environmentId,
                  mutationId: "v2-parent",
                  receiptEpoch: admission.epoch,
                  title: "Parent",
                  spaceId: other.space.id,
                  baseRootOrderRevision: 0,
                }),
              );
              if (parent.status !== "saved") throw new Error("Expected parent");
              const move = async (mutationId: string, destination: C.SpacePageDestination) => {
                const inspected = await run(
                  service.inspectStructure({
                    environmentId,
                    target: { kind: "page", pageId: key.pageId },
                    destination,
                  }),
                );
                const current = await ports.getPage(key);
                const result = await run(
                  service.movePage({
                    ...key,
                    mutationId,
                    receiptEpoch: current.mutationAdmission.epoch,
                    destination,
                    guards: inspected.guards,
                  }),
                );
                assert.equal(result.status, "saved");
              };
              await move("v2-nest", {
                kind: "child",
                placement: { pageId: parent.page.id, parentId: null, beforeBlockId: null },
              });
              const location = h.queries.location({ environmentId, input: { ...key, version: 2 } });
              const moved = await h.read(location);
              assert.equal(moved.current()?.page.spaceId, other.space.id);
              assert.deepEqual(
                moved.ancestors.map((page) => page.id),
                [parent.page.id],
              );
              assert.deepEqual(
                (
                  await run(service.listPages({ environmentId, spaceId: other.space.id }))
                ).items.map((page) => page.id),
                [parent.page.id],
              );
              assert.deepEqual(
                (
                  await run(
                    service.listPages({
                      environmentId,
                      spaceId: other.space.id,
                      parentPageId: parent.page.id,
                    }),
                  )
                ).items.map((page) => page.id),
                [key.pageId],
              );
              assert.equal(controller.session.getSnapshot(), dirty);
              assert.equal(state, editor);
              assert.deepEqual(spaceDocumentBlocks(peerState.doc), dirty.blocks);
              route.release();
              const canonicalTarget = {
                ...key,
                spaceId: other.space.id,
                blockId: dirty.blocks[0]!.id,
              };
              const canonical = documents.open(canonicalTarget);
              leases.push(canonical);
              assert.equal(await canonical.ready, controller);
              assert.equal(reads, 1);
              await controller.save();
              assert.equal(controller.session.getSnapshot().status, "conflict");
              assert.deepEqual(controller.session.getSnapshot().blocks, dirty.blocks);
              await controller.discard();
              assert.equal(controller.session.getSnapshot().baseRevision, moved.page.revision);
              assert.deepEqual(controller.session.getSnapshot().blocks, []);
              assert.isTrue(bridge.adapter.append()(state, dispatch));
              dispatch(state.tr.insertText("saved through move"));
              holdReply = true;
              const saving = controller.save();
              await committed.promise;
              const pending = controller.session.getSnapshot().pending!;
              const pendingWire = JSON.stringify(requests[1]);
              await move("v2-promote", {
                kind: "root",
                spaceId: other.space.id,
                beforePageId: null,
              });
              const current = await h.read(location);
              assert.equal(current.page.location?.kind, "root");
              assert.deepEqual(current.ancestors, []);
              assert.equal(controller.session.getSnapshot().pending, pending);
              assert.equal(JSON.stringify(requests[1]), pendingWire);
              assert.equal(pending.key.pageId, key.pageId);
              reply.resolve();
              await saving;
              assert.isNull(controller.session.getSnapshot().pending);
              assert.isFalse(controller.session.getSnapshot().dirty);
              assert.equal(controller.session.getSnapshot().baseRevision, current.page.revision);
              assert.include(controller.editorWindow().completeParents, null);
              assert.deepEqual(
                spaceDocumentBlocks(state.doc),
                controller.session.getSnapshot().blocks,
              );
              assert.deepEqual(
                spaceDocumentBlocks(peerState.doc),
                controller.session.getSnapshot().blocks,
              );
              assert.include(state.doc.textContent, "saved through move");
              assert.equal(requests.length, 2);
              assert.equal(requests[1]!.baseRevision, moved.page.revision);
              assert.equal(requests[1]!.receiptEpoch, pending.receiptEpoch);
              assert.equal(requests[1]!.generation, pending.generation);
            } finally {
              reply.resolve();
              stop();
              for (const lease of leases) lease.release();
            }
          });
        }),
      ),
  );
  it.effect(
    "releases an interrupted opening, ignores an obsolete RPC session read and replaces only a clean current window",
    () =>
      fixture((service) =>
        Effect.gen(function* () {
          const { key, ports, run } = yield* boot(service);
          const h = yield* queryRuntime(ports, (input) => run(service.readBlocks(input)));
          const documents = new SpaceDocumentControllers(
            (target) =>
              new SpaceDocumentController(
                target,
                {
                  adapter: createSpaceServiceSessionAdapter(target, ports),
                  drafts: { load: async () => null, write: async () => {} },
                  createMutationId: () => "unused",
                  maxLoadedBlocks: 100,
                  maxMutations: 100,
                },
                {
                  getPage: () => h.read(h.queries.page({ environmentId, input: target })),
                  readBlocks: (input) => h.read(h.queries.blocks({ environmentId, input })),
                  windowLimit: () => 100,
                },
              ),
          );
          h.holdNext();
          const first = documents.open(key);
          const blocked = yield* Queue.take(h.blocked);
          first.release();
          yield* SubscriptionRef.set(h.sessions, Option.some(h.makeSession()));
          yield* Deferred.await(blocked.canceled);
          const old = yield* Effect.promise(() => first.ready);
          assert.isFalse(old.session.getSnapshot().hydrated);
          const admission = yield* service.getPage(key);
          const block: C.SpaceBlock = {
            id: C.SpaceBlockId.make("current"),
            parentId: null,
            order: "80000000000000000000000000000000",
            type: "paragraph",
            version: 1,
            content: { runs: [{ text: "new connection", marks: [] }] },
          };
          yield* service.applyBlockBatch({
            ...key,
            mutationId: "after-reconnect",
            receiptEpoch: admission.mutationAdmission.epoch,
            baseRevision: 0,
            generation: 1,
            mutations: [{ kind: "insert", block }],
          });
          const next = documents.open(key);
          try {
            const current = yield* Effect.promise(() => next.ready);
            assert.notEqual(current, old);
            yield* Deferred.succeed(blocked.reply, undefined);
            assert.equal(current.session.getSnapshot().baseRevision, 1);
            assert.deepEqual(current.session.getSnapshot().blocks, [block]);
            first.release();
            const secondBlock = {
              ...block,
              content: { runs: [{ text: "clean refresh", marks: [] }] },
            };
            yield* service.applyBlockBatch({
              ...key,
              mutationId: "clean-update",
              receiptEpoch: admission.mutationAdmission.epoch,
              baseRevision: 1,
              generation: 2,
              mutations: [{ kind: "replace", block: secondBlock }],
            });
            yield* Effect.promise(() => current.refresh());
            assert.equal(current.session.getSnapshot().baseRevision, 2);
            assert.deepEqual(current.session.getSnapshot().blocks, [secondBlock]);
            assert.include(current.editorWindow().completeParents, null);
          } finally {
            next.release();
          }
        }),
      ),
  );
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
              assert.include(bridge.getSnapshot()!, "Use saved undo/redo");
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
              assert.isNull(stored?.pending);
              assert.isNotNull(stored?.history?.undo);
              assert.isFalse(bridge.adapter.redoLocal()(state, dispatch));
            } finally {
              unsubscribe();
            }
          });
        }),
      ),
  );
});

const decodeStructureServiceError = Schema.decodeUnknownOption(C.SpaceServiceError);
const encodedRootRpc = Effect.fn("SpaceEditorServiceTest.encodedRootRpc")(function* (
  service: SpacesService.SpacesService["Service"],
  callerId = "editor-integration",
) {
  const responses = yield* Queue.unbounded<string | Uint8Array>();
  const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
  const parser = RpcSerialization.json.makeUnsafe();
  const protocol = yield* RpcServer.Protocol.make((send) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(receive, send);
      return {
        disconnects: yield* Queue.unbounded<number>(),
        send: (_id, response) => Queue.offer(responses, parser.encode(response)!),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
        supportsNotifications: true,
        codecFor: RpcSerialization.json.codecFor,
      };
    }),
  );
  const handlers = yield* SpacesRpc.handlers(callerId).pipe(
    Effect.provideService(SpacesService.SpacesService, service),
  );
  const context = yield* SpacesRpc.group.toHandlers(handlers);
  yield* RpcServer.make(SpacesRpc.group, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeedContext(context),
        Layer.succeed(RpcServer.Protocol, protocol),
        RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
      ),
    ),
    Effect.forkScoped,
  );
  const write = yield* Deferred.await(receive);
  let sequence = 0;
  return Effect.fn("SpaceEditorServiceTest.encodedRootRequest")(function* (
    tag: string,
    payload: unknown,
  ) {
    const frame = parser.encode({
      _tag: "Request",
      id: String(++sequence),
      tag,
      payload,
      headers: [],
    })!;
    for (const message of parser.decode(frame))
      yield* write(0, message as RpcMessage.FromClientEncoded);
    const response = parser.decode(yield* Queue.take(responses))[0] as RpcMessage.FromServerEncoded;
    if (response._tag !== "Exit" || response.exit._tag !== "Success") {
      if (response._tag === "Exit" && response.exit._tag === "Failure")
        for (const cause of response.exit.cause) {
          if (cause._tag === "Fail") {
            const decoded = decodeStructureServiceError(cause.error);
            if (Option.isSome(decoded)) throw decoded.value;
          }
        }
      throw new Error(JSON.stringify(response));
    }
    return response.exit.value;
  });
});

const decodeBlockMoveResult = Schema.decodeUnknownSync(C.SpaceMoveBlocksResult);
const decodeMoveSpaces = Schema.decodeUnknownSync(C.SpaceListResult);
const decodeMoveBody = Schema.decodeUnknownSync(C.SpaceReadBlocksResult);
const decodeRootList = Schema.decodeUnknownSync(C.SpacePageListResult);
const decodeRootInspect = Schema.decodeUnknownSync(C.SpaceInspectStructureResult);
const decodeRootRequest = Schema.decodeUnknownSync(C.SpaceMutationRequest, {
  onExcessProperty: "error",
});
const decodeRootResult = Schema.decodeUnknownSync(C.SpaceMovePageResult, {
  onExcessProperty: "error",
});
const decodeChildResult = Schema.decodeUnknownSync(C.SpaceCreateChildPageResult);
const decodePurgeResult = Schema.decodeUnknownSync(C.SpacePagePurgeResult);
const decodeRecoveryResult = Schema.decodeUnknownSync(C.SpacePageRecoveryResult);
const decodeTrashList = Schema.decodeUnknownSync(C.SpaceTrashListResult);
const decodeLibraryReceipt = Schema.decodeUnknownSync(C.SpaceMutationReceipt);
const decodeRootReceipt = Schema.decodeUnknownSync(C.SpaceReceiptLookupResult);

const rootReorderFixture = Effect.fn("SpaceEditorServiceTest.rootReorder")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* boot(service);
  const pages = [h.key.pageId];
  for (const title of ["Second", "Third", "Fourth"]) {
    const current = yield* service.getPage(h.key);
    const created = yield* service.createPage({
      environmentId,
      spaceId: current.space.id,
      title,
      mutationId: C.SpaceMutationId.make(`root-${title}`),
      receiptEpoch: current.mutationAdmission.epoch,
      baseRootOrderRevision: current.space.rootOrderRevision,
    });
    if (created.status !== "saved") throw new Error("Root fixture conflict");
    pages.push(created.page.id);
  }
  const initial = yield* service.getPage(h.key);
  const rpc = yield* encodedRootRpc(service);
  let stored: SpaceStructureJournal | null = null;
  let ids = 0,
    admissions = 0,
    rows = 50,
    writable = true,
    refreshed = 0,
    maxBytes = h.capability.limits.maxMutationBytes,
    blockFeature = true;
  const libraryRequests: C.SpaceMutationRequest[] = [];
  const childRequests: C.SpaceCreateChildPageInput[] = [];
  const recoveryRequests: C.SpaceMutationRequest[] = [];
  const blockRequests: C.SpaceMoveBlocksInput[] = [];
  const requests: C.SpaceMovePageInput[] = [],
    lookups: C.SpaceReceiptLookupInput[] = [];
  const disk = { fail: false, hold: false, started: signal(), release: signal() };
  const network = {
    lose: null as "before" | "after" | null,
    after: null as (() => Promise<void>) | null,
    rewritePurgeReply: null as ((reply: C.SpacePagePurgeResult) => C.SpacePagePurgeResult) | null,
    rewriteChildReply: null as
      | ((reply: C.SpaceCreateChildPageResult) => C.SpaceCreateChildPageResult)
      | null,
  };
  const documentReads = { failNext: false, attempted: [] as C.SpacePageId[] };
  const structureBodyReads: C.SpacePageId[] = [];
  const draftRecords = new Map<string, SpaceDocumentDraft>();
  const drafts = {
    load: async (key: C.SpacePageTarget) => {
      const value = draftRecords.get(key.pageId);
      return value ? decodeSpaceDocumentDraft(value, key) : null;
    },
    write: async (key: C.SpacePageTarget, draft: SpaceDocumentDraft | null) => {
      if (draft) draftRecords.set(key.pageId, decodeSpaceDocumentDraft(draft, key));
      else draftRecords.delete(key.pageId);
    },
  };
  const makeDocuments = () =>
    new SpaceDocumentControllers(
      (key) =>
        new SpaceDocumentController(
          key,
          {
            adapter: createSpaceServiceSessionAdapter(key, h.ports),
            drafts,
            createMutationId: () => `content-${++ids}`,
            maxLoadedBlocks: 100,
            maxMutations: 100,
          },
          {
            getPage: () => h.ports.getPage(key),
            windowLimit: () => 100,
            readBlocks: (input) => {
              documentReads.attempted.push(input.pageId);
              if (documentReads.failNext) {
                documentReads.failNext = false;
                return Promise.reject(new Error("Controlled first refresh failure"));
              }
              return h.run(service.readBlocks(input));
            },
          },
        ),
    );
  let documents = makeDocuments();
  const make = (changed = () => {}, media?: SpaceImageUploads) =>
    new SpaceRootReorder(environmentId, {
      store: {
        load: async () => stored,
        write: async (env, journal) => {
          const encoded = JSON.parse(JSON.stringify(journal)) as unknown;
          const value = decodeSpaceStructureJournal(encoded, env);
          if (disk.hold) {
            disk.started.resolve();
            await disk.release.promise;
          }
          if (disk.fail) throw new Error("Controlled transaction abort");
          stored = value;
        },
      },
      spaces: async (input) => decodeMoveSpaces(await h.run(rpc(WS_METHODS.spacesList, input))),
      blocks: async (input) => {
        structureBodyReads.push(input.pageId);
        return decodeMoveBody(await h.run(rpc(WS_METHODS.spacesBlocksRead, input)));
      },
      list: async (input) => decodeRootList(await h.run(rpc(WS_METHODS.spacesPagesList, input))),
      inspect: async (input) =>
        decodeRootInspect(await h.run(rpc(WS_METHODS.spacesStructureInspect, input))),
      getPage: (pageId) => {
        admissions++;
        return h.ports.getPage({ environmentId, pageId });
      },
      move: async (input) => {
        // Exercise the strict wire envelope as well as the real SQLite service.
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "movePage", input })),
        );
        if (request.operation !== "movePage") throw new Error("Wrong wire operation");
        requests.push(request.input);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesPagesMove, request.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        return decodeRootResult(JSON.parse(JSON.stringify(result)));
      },
      receipt: async (input) => {
        lookups.push(input);
        return decodeRootReceipt(await h.run(rpc(WS_METHODS.spacesReceiptsGet, input)));
      },
      assertAccess: (write) => {
        if (write && !writable) throw new Error("Operate revoked");
      },
      maxMutationBytes: () => maxBytes,
      maxRows: () => rows,
      capability: () => (blockFeature ? h.capability : { version: 2, limits: h.capability.limits }),
      moveBlocks: async (input) => {
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "moveBlocks", input })),
        );
        if (request.operation !== "moveBlocks") throw new Error("Wrong block-move operation");
        blockRequests.push(request.input);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesBlocksMove, request.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        return decodeBlockMoveResult(result);
      },
      libraryAccess: (write: boolean) => {
        if (write && !writable) throw new Error("Operate revoked");
      },
      library: async (request: import("@t2code/client-runtime/spaces").SpaceLibraryRequest) => {
        const wire = decodeRootRequest(JSON.parse(JSON.stringify(request)));
        libraryRequests.push(wire);
        const tags = {
          createSpace: WS_METHODS.spacesCreate,
          renameSpace: WS_METHODS.spacesRename,
          setDefaultSpace: WS_METHODS.spacesSetDefault,
          createPage: WS_METHODS.spacesPagesCreate,
          updatePage: WS_METHODS.spacesPagesUpdate,
        };
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(tags[request.operation], wire.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        const receipt = decodeLibraryReceipt({ operation: request.operation, result });
        if (
          receipt.operation !== "createSpace" &&
          receipt.operation !== "renameSpace" &&
          receipt.operation !== "setDefaultSpace" &&
          receipt.operation !== "createPage" &&
          receipt.operation !== "updatePage"
        )
          throw new Error("Wrong library receipt");
        return receipt;
      },
      createChild: async (input: C.SpaceCreateChildPageInput) => {
        childRequests.push(input);
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "createChildPage", input })),
        );
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesPagesCreateChild, request.input));
        if (network.after) {
          const after = network.after;
          network.after = null;
          await after();
        }
        if (lose === "after") throw new Error("Lost committed response");
        const decoded = decodeChildResult(result);
        return network.rewriteChildReply ? network.rewriteChildReply(decoded) : decoded;
      },
      trashList: async (input: C.SpaceTrashListInput) =>
        decodeTrashList(await h.run(rpc(WS_METHODS.spacesTrashList, input))),
      purge: async (input: C.SpacePageRecoveryInput) => {
        const request = decodeRootRequest(
          JSON.parse(JSON.stringify({ operation: "permanentlyDeletePage", input })),
        );
        recoveryRequests.push(request);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(rpc(WS_METHODS.spacesPagesPermanentlyDelete, request.input));
        if (lose === "after") throw new Error("Lost committed response");
        const decoded = decodePurgeResult(result);
        return network.rewritePurgeReply ? network.rewritePurgeReply(decoded) : decoded;
      },
      recovery: async (operation: "trashPage" | "restorePage", input: C.SpacePageRecoveryInput) => {
        const request = decodeRootRequest(JSON.parse(JSON.stringify({ operation, input })));
        recoveryRequests.push(request);
        const lose = network.lose;
        network.lose = null;
        if (lose === "before") throw new Error("Lost before server received request");
        const result = await h.run(
          rpc(
            operation === "trashPage" ? WS_METHODS.spacesPagesTrash : WS_METHODS.spacesPagesRestore,
            request.input,
          ),
        );
        if (lose === "after") throw new Error("Lost committed response");
        return decodeRecoveryResult(result);
      },
      newId: () => `placement-${++ids}`,
      reserve: (pages, restoring) => {
        const releaseMedia = media?.reserve(environmentId, pages);
        try {
          const release = documents.reserve(environmentId, pages, restoring);
          return () => {
            release();
            releaseMedia?.();
          };
        } catch (error) {
          releaseMedia?.();
          throw error;
        }
      },
      checkDrafts: async (pages) => {
        await media?.checkPages(environmentId, pages);
        await checkSpaceStructureDrafts(drafts, environmentId, pages);
      },
      refresh: async (pages) => {
        refreshed++;
        await documents.refreshStructure(environmentId, pages);
      },
      changed,
    });
  return {
    ...h,
    pages,
    spaceId: initial.space.id,
    make,
    documents,
    drafts,
    draftRecords,
    documentReads,
    structureBodyReads,
    requests,
    lookups,
    disk,
    network,
    counts: () => ({ admissions, refreshed }),
    stored: () => stored,
    blockRequests,
    childRequests,
    libraryRequests,
    recoveryRequests,
    setBlockFeature: (value: boolean) => {
      blockFeature = value;
    },
    setMaxBytes: (value: number) => {
      maxBytes = value;
    },
    setRows: (value: number) => {
      rows = value;
    },
    setWritable: (value: boolean) => {
      writable = value;
    },
    reload: () => {
      documents = makeDocuments();
      return make();
    },
    order: async () =>
      (await h.run(service.listPages({ environmentId, spaceId: initial.space.id }))).items.map(
        (p) => p.id,
      ),
  };
});

it.effect(
  "reorders real roots and saves guarded inverse/redo with new identities and stable page IDs",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
            await owner.compensate("undo");
            assert.deepEqual(await h.order(), h.pages);
            assert.equal(owner.getSnapshot().journal.history?.direction, "redo");
            await owner.compensate("redo");
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
            assert.equal(new Set(h.requests.map((r) => r.mutationId)).size, 3);
            assert.equal(h.counts().admissions, 3);
            assert.equal(h.counts().refreshed, 3);
            assert.isTrue(
              h.requests.every(
                (r) => r.destination.kind === "root" && r.destination.spaceId === h.spaceId,
              ),
            );
            assert.isTrue(
              (await h.run(service.listPages({ environmentId, spaceId: h.spaceId }))).items.every(
                (p) => /^[0-9a-f]{32}$/.test(p.rootOrder!),
              ),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a stale inverse conflict without renewing guards and requires explicit new-position intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            const expected = owner.getSnapshot().journal.history!.guards;
            const peer = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
            await h.run(
              service.updatePage({
                environmentId,
                pageId: peer.page.id,
                mutationId: "concurrent-title",
                receiptEpoch: peer.mutationAdmission.epoch,
                baseRevision: peer.page.revision,
                title: "Newer title",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.requests[1]!.guards, expected);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
            await expect(owner.compensate("undo")).rejects.toThrow("retained placement");
            await owner.reinspect();
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.isNull(owner.getSnapshot().journal.history);
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, h.pages[1]!);
            assert.deepEqual(await h.order(), h.pages);
            assert.notEqual(h.requests[1]!.mutationId, h.requests[2]!.mutationId);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "journals before sending and interlocks two real controllers through aborted persistence and exact unsent retry",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const first = h.documents.open(h.key),
              second = h.documents.open(h.key);
            const doc = await first.ready;
            assert.equal(await second.ready, doc);
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.disk.hold = true;
            h.disk.fail = true;
            const moving = owner.move(h.pages[0]!, h.spaceId, null);
            await h.disk.started.promise;
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.requests.length, 0);
            assert.isTrue(doc.structureBlocked());
            assert.throws(
              () =>
                doc.session.apply([{ kind: "insert", block: savedParagraph("blocked", "unsent") }]),
              "reserved",
            );
            await expect(doc.save()).rejects.toThrow("reserved");
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            first.release();
            h.disk.release.resolve();
            await expect(moving).rejects.toThrow("abort");
            assert.equal(h.requests.length, 0);
            assert.deepEqual(owner.getSnapshot().journal.pending, pending);
            h.disk.hold = false;
            h.disk.fail = false;
            await owner.recover();
            assert.deepEqual(h.requests[0], pending.request.input);
            assert.equal(h.lookups.length, 0);
            assert.isFalse(doc.structureBlocked());
            assert.equal(
              doc.session.getSnapshot().baseRevision,
              (await h.ports.getPage(h.key)).page.revision,
            );
            assert.equal(h.counts().refreshed, 1);
            second.release();
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers a lost committed response after reload using exact receipt in read-only mode without another write",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "after";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow(
              "Lost committed",
            );
            const pending = h.stored()!.pending!;
            const revision = (await h.ports.getPage(h.key)).page.revision;
            const restored = h.reload();
            h.setWritable(false);
            await restored.hydrate();
            await restored.recover();
            assert.deepEqual(h.lookups[0], { request: pending.request });
            assert.equal(h.requests.length, 1);
            assert.equal(h.counts().admissions, 1);
            assert.isNull(h.stored()!.pending);
            assert.equal((await h.ports.getPage(h.key)).page.revision, revision);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "replays an absent receipt only with operate permission and the original guards, ID and epoch",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "before";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow("Lost before");
            const original = h.stored()!.pending!.request.input;
            const restored = h.reload();
            h.setWritable(false);
            await expect(restored.recover()).rejects.toThrow("Operate revoked");
            assert.equal(h.requests.length, 1);
            h.setWritable(true);
            h.setMaxBytes(1);
            await restored.recover();
            assert.deepEqual(h.requests, [original, original]);
            assert.equal(h.counts().admissions, 1);
            assert.equal(h.lookups.length, 2);
            assert.isNull(restored.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses hidden durable dirty drafts and resident dirty state without publishing a pending structural intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const hidden = h.documents.open({ environmentId, pageId: h.pages[1]! });
            const doc = await hidden.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("hidden-dirty", "retained") },
            ]);
            await doc.session.persistDraft();
            hidden.release();
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await expect(owner.move(h.pages[0]!, h.spaceId, h.pages[1]!)).rejects.toThrow(
              "affected document",
            );
            const restored = h.reload();
            await restored.browse(h.spaceId, h.pages[0]!);
            await expect(restored.move(h.pages[0]!, h.spaceId, h.pages[1]!)).rejects.toThrow(
              "retained draft",
            );
            assert.equal(h.requests.length, 0);
            assert.isNull(restored.getSnapshot().journal.pending);
            assert.isNotNull(h.draftRecords.get(h.pages[1]!)?.mutations.length);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "does not infer a successor at a partial window and learns it only through explicit next pagination",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            h.setRows(1);
            await owner.browse(h.spaceId, h.pages[0]!);
            assert.isNull(owner.getSnapshot().position);
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow(
              "proven destination",
            );
            await owner.browse(h.spaceId, h.pages[0]!, true);
            assert.equal(owner.getSnapshot().position?.beforePageId, h.pages[1]);
            assert.equal(owner.getSnapshot().window!.items.length, 1);
            await owner.move(h.pages[0]!, h.spaceId, h.pages[1]!);
            assert.deepEqual(await h.order(), h.pages);
            assert.isNull(owner.getSnapshot().journal.history);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps an expired absent root receipt unresolved rather than capturing a new epoch or identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "before";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow("Lost before");
            const original = h.stored()!.pending!;
            await h.run(TestClock.adjust(86_400_001));
            const restored = h.reload();
            await restored.recover();
            assert.include(restored.getSnapshot().notice!, "unknown");
            assert.deepEqual(h.stored()!.pending, original);
            assert.equal(h.requests.length, 1);
            assert.equal(h.counts().admissions, 1);
            await expect(restored.reinspect()).rejects.toThrow("definite conflict");
            assert.deepEqual(await h.order(), h.pages);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps saved content compensation on its old revision after clean structural refresh",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const opened = h.documents.open(h.key);
            const doc = await opened.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("initial-content", "initial") },
            ]);
            await doc.save();
            doc.session.apply([
              { kind: "replace", block: savedParagraph("initial-content", "saved edit") },
            ]);
            await doc.save();
            assert.isNull(doc.session.compensationAvailability("undo"));
            const history = doc.session.getSnapshot().history.undo;
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.deepEqual(doc.session.getSnapshot().history.undo, history);
            assert.isNotNull(doc.session.compensationAvailability("undo"));
            opened.release();
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a changed inverse context after a definite commit rather than admitting refreshed compensation guards",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.after = async () => {
              const peer = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
              await h.run(
                service.updatePage({
                  environmentId,
                  pageId: peer.page.id,
                  mutationId: "late-inverse-peer",
                  receiptEpoch: peer.mutationAdmission.epoch,
                  baseRevision: peer.page.revision,
                  title: "Newer inverse anchor",
                }),
              );
            };
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.isNull(owner.getSnapshot().journal.history);
            assert.include(owner.getSnapshot().notice!, "inverse placement changed");
            await expect(owner.compensate("undo")).rejects.toThrow("No guarded placement");
            assert.equal(h.requests.length, 1);
            assert.deepEqual(await h.order(), [h.pages[1], h.pages[2], h.pages[3], h.pages[0]]);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "admits an eight-page observed root closure and refuses nine before durable intent or network mutation",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const placement = { pageId: h.pages[0]!, parentId: null, beforeBlockId: null };
          const addChild = (index: number) =>
            Effect.gen(function* () {
              const inspected = yield* service.inspectStructure({
                environmentId,
                target: { kind: "blocks", pageId: placement.pageId, blockIds: [] },
                destination: { kind: "child", placement },
              });
              const page = yield* service.getPage(h.key);
              const child = yield* service.createChildPage({
                environmentId,
                mutationId: C.SpaceMutationId.make(`budget-child-${index}`),
                receiptEpoch: page.mutationAdmission.epoch,
                title: "Child",
                placement,
                guards: inspected.guards,
              });
              if (child.status !== "saved") throw new Error("Unexpected child fixture conflict");
            });
          for (let i = 0; i < 5; i++) yield* addChild(i);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.move(h.pages[0]!, h.spaceId, null);
            assert.equal(owner.getSnapshot().journal.history?.observed.pages.length, 8);
            await owner.compensate("undo");
            assert.deepEqual(await h.order(), h.pages);
          });
          yield* addChild(5);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            const writes = h.requests.length;
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow("eight-page");
            assert.equal(h.requests.length, writes);
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.deepEqual(await h.order(), h.pages);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not replace the saved inverse on a definite no-op root placement", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        yield* Effect.promise(async () => {
          const owner = h.make();
          await owner.browse(h.spaceId, h.pages[0]!);
          await owner.move(h.pages[0]!, h.spaceId, null);
          const history = owner.getSnapshot().journal.history;
          await owner.browse(h.spaceId, h.pages[0]!);
          await owner.move(h.pages[0]!, h.spaceId, null);
          assert.deepEqual(owner.getSnapshot().journal.history, history);
          assert.include(owner.getSnapshot().notice!, "already");
          await owner.compensate("undo");
          assert.deepEqual(await h.order(), h.pages);
        });
      }),
    ),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains the attempted original move when a real remote root/anchor change occurs during journal persistence",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.disk.hold = true;
            const moving = owner.move(h.pages[0]!, h.spaceId, h.pages[2]!);
            await h.disk.started.promise;
            const original = owner.getSnapshot().journal.pending!;
            const peer = h.pages[2]!;
            const destination = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: peer },
                destination,
              }),
            );
            const admission = await h.ports.getPage({ environmentId, pageId: peer });
            await h.run(
              service.movePage({
                environmentId,
                pageId: peer,
                destination,
                guards: inspected.guards,
                mutationId: "remote-anchor-move",
                receiptEpoch: admission.mutationAdmission.epoch,
              }),
            );
            h.disk.release.resolve();
            await moving;
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.requests[0], original.request.input);
            assert.deepEqual(await h.order(), [h.pages[0], h.pages[1], h.pages[3], h.pages[2]]);
            assert.isNull(owner.getSnapshot().journal.history);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "blocks actual PM commands in two views and retains their shared editor when root metadata refreshes",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const controller = await route.ready;
            assert.equal(await panel.ready, controller);
            const a = savedView(controller),
              b = savedView(controller);
            try {
              const owner = h.make();
              await owner.browse(h.spaceId, h.pages[0]!);
              h.disk.hold = true;
              const moving = owner.move(h.pages[0]!, h.spaceId, null);
              await h.disk.started.promise;
              const beforeA = a.state.doc.toJSON(),
                beforeB = b.state.doc.toJSON();
              assert.isFalse(a.bridge.adapter.append()(a.state, a.dispatch));
              assert.isFalse(b.bridge.adapter.append()(b.state, b.dispatch));
              assert.deepEqual(a.state.doc.toJSON(), beforeA);
              assert.deepEqual(b.state.doc.toJSON(), beforeB);
              h.disk.release.resolve();
              await moving;
              assert.isTrue(a.bridge.adapter.append()(a.state, a.dispatch));
              assert.deepEqual(a.state.doc.toJSON(), b.state.doc.toJSON());
              assert.isTrue(controller.session.getSnapshot().dirty);
              const third = h.documents.open(h.key);
              assert.equal(await third.ready, controller);
              third.release();
              assert.isTrue(controller.session.getSnapshot().dirty);
            } finally {
              a.stop();
              b.stop();
              route.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refreshes every changed resident after real root rebalance when the first refresh fails before reservation release",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          // Seed adjacent valid ranks so the actual service must rebalance multiple roots.
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            for (const [index, value] of [16, 32, 33, 64].entries())
              sql
                .prepare("UPDATE spaces_pages SET root_order = ? WHERE page_id = ?")
                .run(value.toString(16).padStart(32, "0"), h.pages[index]!);
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const views = h.pages.map((pageId) => h.documents.open({ environmentId, pageId }));
            const documents = await Promise.all(views.map((view) => view.ready));
            const bridges = documents.map((doc) => savedView(doc));
            try {
              const owner = h.make();
              await owner.browse(h.spaceId, h.pages[0]!);
              h.documentReads.attempted.length = 0;
              h.documentReads.failNext = true;
              await expect(owner.move(h.pages[0]!, h.spaceId, h.pages[2]!)).rejects.toThrow();
              const receipt = await h.ports.lookupMutationReceipt({
                request: { operation: "movePage", input: h.requests[0]! },
              });
              if (
                receipt.status !== "found" ||
                receipt.receipt.operation !== "movePage" ||
                receipt.receipt.result.status !== "saved"
              )
                throw new Error("Expected actual rebalance receipt");
              const changed = receipt.receipt.result.changed.pages;
              assert.isAtLeast(changed.length, 2);
              assert.deepEqual(
                h.documentReads.attempted,
                changed.map((row) => row.pageId),
              );
              const failedId = changed[0]!.pageId;
              for (const row of changed) {
                const index = h.pages.indexOf(row.pageId),
                  doc = documents[index]!;
                assert.isFalse(doc.structureBlocked());
                if (row.pageId === failedId) {
                  assert.isNotNull(doc.getSnapshot().error);
                  assert.isFalse(bridges[index]!.bridge.canEdit());
                } else {
                  assert.isNull(doc.getSnapshot().error);
                  assert.equal(doc.session.getSnapshot().baseRevision, row.revision);
                  assert.isTrue(bridges[index]!.bridge.canEdit());
                }
              }
              assert.isNull(owner.getSnapshot().journal.pending);
              assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
              assert.equal(h.requests.length, 1);
              const failed = documents[h.pages.indexOf(failedId)]!;
              await failed.refresh();
              assert.isNull(failed.getSnapshot().error);
              assert.equal(failed.session.getSnapshot().baseRevision, changed[0]!.revision);
            } finally {
              bridges.forEach((view) => view.stop());
              views.forEach((view) => view.release());
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reacquires an affected page after exact uncertain-placement recovery without remounting its failed owner",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            h.network.lose = "after";
            await expect(owner.move(h.pages[0]!, h.spaceId, null)).rejects.toThrow(
              "Lost committed response",
            );
            const pending = owner.getSnapshot().journal.pending!;
            const target = { environmentId, pageId: h.pages[1]! };
            const blocked = h.documents.open(target);
            await expect(blocked.ready).rejects.toThrow("reserved");
            await owner.recover();
            assert.deepEqual(h.lookups[0], { request: pending.request });
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.equal(h.requests.length, 1);
            const retried = h.documents.open(target),
              doc = await retried.ready;
            blocked.release();
            const panel = h.documents.open(target);
            try {
              assert.equal(await panel.ready, doc);
              assert.isNull(doc.getSnapshot().error);
              assert.equal(
                doc.session.getSnapshot().baseRevision,
                (await h.ports.getPage(target)).page.revision,
              );
            } finally {
              retried.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const nestedMoveFixture = Effect.fn("SpaceEditorServiceTest.nestedMoves")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* rootReorderFixture(service);
  let serial = 0;
  const child = Effect.fn("SpaceEditorServiceTest.child")(function* (
    parent: C.SpacePageId,
    parentId: C.SpaceBlockId | null = null,
  ) {
    const placement = { pageId: parent, parentId, beforeBlockId: null };
    const inspected = yield* service.inspectStructure({
      environmentId,
      target: { kind: "blocks", pageId: parent, blockIds: [] },
      destination: { kind: "child", placement },
    });
    const admission = yield* service.getPage({ environmentId, pageId: parent });
    const created = yield* service.createChildPage({
      environmentId,
      mutationId: C.SpaceMutationId.make(`nested-move-child-${++serial}`),
      receiptEpoch: admission.mutationAdmission.epoch,
      title: `Child ${serial}`,
      placement,
      guards: inspected.guards,
    });
    if (created.status !== "saved") throw new Error("Unexpected fixture child conflict");
    return created;
  });
  const a = yield* child(h.pages[0]!);
  const descendant = yield* child(a.page.id);
  const b = yield* child(h.pages[1]!);
  const library = yield* service.listSpaces({ environmentId });
  const space = yield* service.createSpace({
    environmentId,
    mutationId: "move-other-space",
    receiptEpoch: library.mutationAdmission.epoch,
    title: "Destination",
  });
  const root = yield* service.createPage({
    environmentId,
    mutationId: "move-other-root",
    receiptEpoch: library.mutationAdmission.epoch,
    spaceId: space.space.id,
    baseRootOrderRevision: 0,
    title: "Other root",
  });
  if (root.status !== "saved") throw new Error("Unexpected fixture root conflict");
  return { ...h, a, b, descendant, other: space.space.id, otherRoot: root.page.id, child };
});

it.effect(
  "moves a real opaque page subtree across root spaces and compensates exact placement without changing page or block IDs",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const opaque = {
            id: C.SpaceBlockId.make("opaque-descendant"),
            parentId: null,
            order: "40000000000000000000000000000000",
            type: "future_widget",
            version: 7,
            content: { vendor: [1, { value: "unchanged" }] },
            future: { marks: [{ type: "future_mark", version: 2 }] },
          };
          const payload = JSON.stringify(opaque),
            bytes = Buffer.byteLength(payload);
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            sql.prepare("INSERT INTO spaces_ids(id,kind) VALUES (?,'block')").run(opaque.id);
            sql
              .prepare(
                "INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes,deleted) VALUES (?,?,NULL,?,?,?,0)",
              )
              .run(opaque.id, h.descendant.page.id, opaque.order, payload, bytes);
            sql
              .prepare(
                "UPDATE spaces_pages SET block_count=block_count+1,block_bytes=block_bytes+? WHERE page_id=?",
              )
              .run(bytes, h.descendant.page.id);
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.browse(h.other, h.pages[0]!);
            await owner.move(h.pages[0]!, h.other, h.otherRoot);
            for (const pageId of [h.pages[0]!, h.a.page.id, h.descendant.page.id])
              assert.equal(
                (await h.ports.getPage({ environmentId, pageId })).page.spaceId,
                h.other,
              );
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
            await owner.compensate("undo");
            assert.deepEqual(await h.order(), h.pages);
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.descendant.page.id })).page.spaceId,
              h.spaceId,
            );
            await owner.compensate("redo");
            const descendant = await h.ports.getPage({
              environmentId,
              pageId: h.descendant.page.id,
            });
            assert.equal(descendant.page.spaceId, h.other);
            assert.deepEqual(
              (
                await h.run(
                  service.readBlocks({
                    environmentId,
                    pageId: descendant.page.id,
                    revision: descendant.page.revision,
                  }),
                )
              ).blocks,
              [opaque],
            );
            assert.equal(new Set(h.requests.map((r) => r.mutationId)).size, 3);
            assert.equal(h.requests[0]!.guards.roots.length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "moves child ownership between pages and known lists with the same marker and guarded inverse order",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const parent = yield* service.getPage({ environmentId, pageId: h.otherRoot });
          const list = { ...savedParagraph("placement-list", "List"), type: "bulleted_item" };
          yield* service.applyBlockBatch({
            environmentId,
            pageId: parent.page.id,
            mutationId: "seed-placement-list",
            receiptEpoch: parent.mutationAdmission.epoch,
            baseRevision: parent.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: list }],
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(parent.page.id);
            await owner.moveTo(h.a.page.id, {
              kind: "child",
              placement: { pageId: parent.page.id, parentId: list.id, beforeBlockId: null },
            });
            const moved = (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page;
            assert.deepEqual(moved.location, {
              kind: "child",
              spaceId: h.other,
              parentPageId: parent.page.id,
              ownerBlockId: h.a.ownerBlockId,
            });
            const body = await h.run(
              service.readBlocks({
                environmentId,
                pageId: parent.page.id,
                revision: (await h.ports.getPage({ environmentId, pageId: parent.page.id })).page
                  .revision,
              }),
            );
            assert.equal(body.blocks.find((b) => b.id === h.a.ownerBlockId)?.parentId, list.id);
            await owner.compensate("undo");
            assert.deepEqual(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location,
              h.a.page.location,
            );
            await owner.compensate("redo");
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "child",
            );
            assert.isTrue(h.requests.every((r) => r.destination.kind === "child"));
            assert.isTrue(h.requests.every((r) => r.guards.roots.length === 0));
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "promotes and renests a child with guarded logical undo and a fresh marker rather than resurrecting its retired ID",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            let owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.browse(h.other, h.a.page.id);
            h.network.lose = "after";
            await expect(owner.move(h.a.page.id, h.other, null)).rejects.toThrow(
              "Lost committed response",
            );
            const retained = owner.getSnapshot().journal.pending!;
            owner = h.reload();
            await owner.recover();
            assert.deepEqual(h.lookups[0], { request: retained.request });
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "root",
            );
            assert.include(owner.getSnapshot().notice!, "not retired owner-marker");
            await owner.compensate("undo");
            const restored = (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page
              .location;
            assert.equal(restored?.kind, "child");
            if (restored?.kind !== "child") throw new Error("Expected child ownership");
            assert.notEqual(restored.ownerBlockId, h.a.ownerBlockId);
            assert.equal(restored.parentPageId, h.pages[0]);
            assert.equal(restored.spaceId, h.spaceId);
            const retired = await h.run(
              service
                .applyBlockBatch({
                  environmentId,
                  pageId: h.pages[0]!,
                  mutationId: "retired-owner-resurrection",
                  receiptEpoch: (await h.ports.getPage(h.key)).mutationAdmission.epoch,
                  baseRevision: (await h.ports.getPage(h.key)).page.revision,
                  generation: 1,
                  mutations: [
                    {
                      kind: "insert",
                      block: savedParagraph(h.a.ownerBlockId, "illegal resurrection"),
                    },
                  ],
                })
                .pipe(Effect.flip),
            );
            assert.equal(retired._tag, "SpaceValidationError");
            await owner.compensate("redo");
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "root",
            );
            assert.equal(h.requests.length, 3);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "nests a root across spaces, preserves stable document ownership, and compensates parent order with exact pending identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            try {
              const owner = h.make();
              await owner.browse(h.spaceId, h.pages[0]!);
              await owner.loadBody(h.otherRoot);
              h.disk.fail = true;
              const destination = {
                kind: "child" as const,
                placement: { pageId: h.otherRoot, parentId: null, beforeBlockId: null },
              };
              await expect(owner.moveTo(h.pages[0]!, destination)).rejects.toThrow("abort");
              const pending = owner.getSnapshot().journal.pending!;
              assert.equal(pending.request.operation, "movePage");
              if (pending.request.operation !== "movePage") throw new Error("Expected page move");
              assert.deepEqual(pending.request.input.destination, destination);
              assert.equal(h.requests.length, 0);
              assert.isTrue(doc.structureBlocked());
              h.disk.fail = false;
              h.network.lose = "after";
              await expect(owner.recover()).rejects.toThrow("Lost committed response");
              await owner.recover();
              assert.deepEqual(h.requests[0], pending.request.input);
              assert.deepEqual(h.lookups[0], { request: pending.request });
              assert.equal(h.requests.length, 1);
              assert.isFalse(doc.structureBlocked());
              assert.equal(doc.session.key.pageId, h.pages[0]);
              assert.equal(doc.getSnapshot().metadata?.page.spaceId, h.other);
              assert.equal(doc.getSnapshot().metadata?.page.location?.kind, "child");
              const live = await h.run(
                readSpacePageLocation({ pageId: h.pages[0]!, version: 2 }, (pageId) =>
                  service.getPage({ environmentId, pageId }),
                ),
              );
              assert.deepEqual(
                live.ancestors.map((p) => p.id),
                [h.otherRoot],
              );
              assert.equal(live.page.spaceId, h.other);
              const peer = h.documents.open(h.key);
              assert.equal(await peer.ready, doc);
              peer.release();
              await owner.compensate("undo");
              assert.deepEqual(await h.order(), h.pages);
              await owner.compensate("redo");
              const location = (await h.ports.getPage(h.key)).page.location;
              assert.equal(location?.kind, "child");
              const first = pending.sourceLocation;
              assert.equal(first?.kind, "root");
              assert.equal(h.requests.length, 3);
            } finally {
              route.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "blocks a hidden child-parent draft and retains a stale child-neighbor inverse conflict without moving or renewing it",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const parentKey = { environmentId, pageId: h.pages[1]! };
            const view = h.documents.open(parentKey),
              parent = await view.ready;
            parent.session.apply([
              { kind: "insert", block: savedParagraph("hidden-parent-draft", "unsaved") },
            ]);
            await parent.session.persistDraft();
            view.release();
            const owner = h.reload();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(parentKey.pageId);
            const destination = {
              kind: "child" as const,
              placement: {
                pageId: parentKey.pageId,
                parentId: null,
                beforeBlockId: h.b.ownerBlockId,
              },
            };
            await expect(owner.moveTo(h.a.page.id, destination)).rejects.toThrow("retained draft");
            assert.equal(h.requests.length, 0);
            await parent.discard();
            await owner.moveTo(h.a.page.id, destination);
            const expected = owner.getSnapshot().journal.history!.guards;
            const oldParent = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                environmentId,
                pageId: oldParent.page.id,
                mutationId: "stale-child-inverse-parent",
                receiptEpoch: oldParent.mutationAdmission.epoch,
                baseRevision: oldParent.page.revision,
                title: "Changed original parent",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.requests[1]!.guards, expected);
            const current = (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page
              .location;
            assert.equal(current?.kind === "child" ? current.parentPageId : null, parentKey.pageId);
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses partial source and destination bodies instead of inferring complete parent lists",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const metadata = yield* service.getPage(h.key);
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "partial-parent-body",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: metadata.page.revision,
            generation: 1,
            mutations: Array.from({ length: 100 }, (_, i) => ({
              kind: "insert" as const,
              block: savedParagraph(
                `partial-${i}`,
                "row",
                (BigInt(i + 1) * ((1n << 128n) / 200n)).toString(16).padStart(32, "0"),
              ),
            })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await expect(owner.loadSource(h.a.page.id)).rejects.toThrow(
              "source parent body is partial",
            );
            assert.isNull(owner.getSnapshot().position);
            await owner.loadSource(h.b.page.id);
            await owner.loadBody(h.pages[0]!);
            assert.isNotNull(owner.getSnapshot().body?.nextCursor);
            await expect(
              owner.moveTo(h.b.page.id, {
                kind: "child",
                placement: { pageId: h.pages[0]!, parentId: null, beforeBlockId: null },
              }),
            ).rejects.toThrow("complete bounded destination body");
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses cycles and excessive depth through real inspection before journaling a page move",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[0]!);
            await owner.loadBody(h.descendant.page.id);
            await expect(
              owner.moveTo(h.pages[0]!, {
                kind: "child",
                placement: { pageId: h.descendant.page.id, parentId: null, beforeBlockId: null },
              }),
            ).rejects.toMatchObject({ _tag: "SpaceValidationError", reason: "cycle" });
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
          let parent = h.descendant.page.id;
          for (let i = 3; i < 16; i++) parent = (yield* h.child(parent)).page.id;
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.browse(h.spaceId, h.pages[2]!);
            await owner.loadBody(parent);
            await expect(
              owner.moveTo(h.pages[2]!, {
                kind: "child",
                placement: { pageId: parent, parentId: null, beforeBlockId: null },
              }),
            ).rejects.toThrow("maxDepth");
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a retired child inverse anchor explicitly without renewing guards or creating an unreplayable compensating intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const parent = yield* service.getPage(h.key);
          const anchor = savedParagraph(
            "retained-inverse-anchor",
            "After child",
            "fffffffffffffffffffffffffffffffe",
          );
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "add-inverse-anchor",
            receiptEpoch: parent.mutationAdmission.epoch,
            baseRevision: parent.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: anchor }],
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(h.pages[1]!);
            await owner.moveTo(h.a.page.id, {
              kind: "child",
              placement: { pageId: h.pages[1]!, parentId: null, beforeBlockId: null },
            });
            const retained = owner.getSnapshot().journal.history;
            const current = await h.ports.getPage(h.key);
            await h.run(
              service.applyBlockBatch({
                ...h.key,
                mutationId: "retire-inverse-anchor",
                receiptEpoch: current.mutationAdmission.epoch,
                baseRevision: current.page.revision,
                generation: 2,
                mutations: [{ kind: "delete", blockId: anchor.id }],
              }),
            );
            await expect(owner.compensate("undo")).rejects.toThrow(
              "inverse placement is unavailable",
            );
            assert.deepEqual(owner.getSnapshot().journal.history, retained);
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.equal(h.requests.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses non-container and stale child destination proofs before capturing a mutation identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const target = { environmentId, pageId: h.pages[1]! };
          const parent = yield* service.getPage(target);
          const leaf = savedParagraph("not-a-list-parent", "Leaf");
          yield* service.applyBlockBatch({
            ...target,
            mutationId: "seed-leaf-destination",
            receiptEpoch: parent.mutationAdmission.epoch,
            baseRevision: parent.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: leaf }],
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadSource(h.a.page.id);
            await owner.loadBody(target.pageId);
            await expect(
              owner.moveTo(h.a.page.id, {
                kind: "child",
                placement: { pageId: target.pageId, parentId: leaf.id, beforeBlockId: null },
              }),
            ).rejects.toThrow("known list placement");
            const latest = await h.ports.getPage(target);
            await h.run(
              service.applyBlockBatch({
                ...target,
                mutationId: "change-destination-after-window",
                receiptEpoch: latest.mutationAdmission.epoch,
                baseRevision: latest.page.revision,
                generation: 2,
                mutations: [
                  { kind: "replace", block: savedParagraph(leaf.id, "Changed after read") },
                ],
              }),
            );
            await expect(
              owner.moveTo(h.a.page.id, {
                kind: "child",
                placement: {
                  pageId: target.pageId,
                  parentId: null,
                  beforeBlockId: h.b.ownerBlockId,
                },
              }),
            ).rejects.toThrow("placement changed");
            assert.equal(h.requests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const blockMoveFixture = Effect.fn("SpaceEditorServiceTest.blockMoves")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* rootReorderFixture(service);
  const page = yield* service.getPage(h.key);
  const blocks = [
    {
      ...savedParagraph("block-list", "Container", "20000000000000000000000000000000"),
      type: "bulleted_item",
    },
    {
      ...savedParagraph("nested-text", "MoveUniqueNeedle", "40000000000000000000000000000000"),
      parentId: C.SpaceBlockId.make("block-list"),
    },
    savedParagraph("block-b", "Second", "80000000000000000000000000000000"),
    savedParagraph("block-c", "Third", "c0000000000000000000000000000000"),
  ];
  yield* service.applyBlockBatch({
    ...h.key,
    mutationId: "seed-block-moves",
    receiptEpoch: page.mutationAdmission.epoch,
    baseRevision: page.page.revision,
    generation: 1,
    mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
  });
  return {
    ...h,
    blocks,
    read: (pageId: C.SpacePageId) =>
      h.run(
        Effect.gen(function* () {
          const metadata = yield* service.getPage({ environmentId, pageId });
          return yield* service.readBlocks({
            environmentId,
            pageId,
            revision: metadata.page.revision,
          });
        }),
      ),
  };
});

it.effect(
  "moves actual PM-selected roots with nested content across pages and guards inverse/redo order and current search ownership",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          const building = yield* service
            .search({ environmentId, query: "MoveUniqueNeedle" })
            .pipe(Effect.flip);
          assert.equal(building._tag, "SpaceSearchUnavailableError");
          if (building._tag === "SpaceSearchUnavailableError")
            assert.equal(building.reason, "building");
          const initial = yield* service.search({ environmentId, query: "MoveUniqueNeedle" });
          assert.isTrue(
            initial.items.some(
              (item) => item.blockId === h.blocks[1]!.id && item.page.id === h.key.pageId,
            ),
          );

          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            const view = savedView(doc);
            try {
              const state = view.state.apply(
                view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)),
              );
              const selected = view.bridge.blockMoveSelection(state);
              assert.deepEqual(selected.blockIds, [h.blocks[0]!.id]);
              const owner = h.make(),
                proof = await owner.selectBlocks(
                  h.key.pageId,
                  selected.revision,
                  selected.blockIds,
                );
              assert.deepEqual(proof.selectedIds, [h.blocks[0]!.id, h.blocks[1]!.id]);
              await owner.loadBody(h.pages[1]!);
              await owner.moveSelectedBlocks(proof, {
                pageId: h.pages[1]!,
                parentId: null,
                beforeBlockId: null,
              });
              assert.deepEqual(h.blockRequests[0]!.blockIds, selected.blockIds);
              assert.deepEqual(
                (await h.read(h.key.pageId)).blocks.map((b) => b.id),
                [h.blocks[2]!.id, h.blocks[3]!.id],
              );
              assert.deepEqual(
                (await h.read(h.pages[1]!)).blocks.map((b) => b.id),
                [h.blocks[0]!.id, h.blocks[1]!.id],
              );
              const resolved = await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "block", blockId: h.blocks[1]!.id },
                  pageIdHint: h.key.pageId,
                }),
              );
              assert.equal(resolved.status === "resolved" ? resolved.page.id : null, h.pages[1]);
              const searched = await h.run(
                service.search({ environmentId, query: "MoveUniqueNeedle" }),
              );
              assert.isTrue(
                searched.items.some(
                  (item) => item.blockId === h.blocks[1]!.id && item.page.id === h.pages[1],
                ),
              );
              await owner.compensate("undo");
              assert.deepEqual(
                (await h.read(h.key.pageId)).blocks.map((b) => b.id),
                h.blocks.map((b) => b.id),
              );
              await owner.compensate("redo");
              assert.equal(new Set(h.blockRequests.map((r) => r.mutationId)).size, 3);
              assert.isTrue(
                h.blockRequests.every(
                  (r) => r.blockIds.length === 1 && r.blockIds[0] === h.blocks[0]!.id,
                ),
              );
              assert.equal(h.requests.length, 0);
              assert.isFalse(doc.session.getSnapshot().dirty);
            } finally {
              view.stop();
              route.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "preserves contiguous selected-root order for same-page moves and executes indent/outdent through guarded block service requests",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            let source = await h.read(h.key.pageId);
            const roots = [h.blocks[2]!.id, h.blocks[3]!.id];
            let from = 0,
              to = 0;
            view.state.doc.descendants((node, pos) => {
              if (node.attrs.block?.id === roots[0]) from = pos + 1;
              if (node.attrs.block?.id === roots[1]) to = pos + node.nodeSize - 1;
            });
            const selected = view.bridge.blockMoveSelection(
              view.state.apply(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)),
              ),
            );
            assert.deepEqual(selected.blockIds, roots);
            view.stop();
            opened.release();
            let proof = await owner.selectBlocks(h.key.pageId, source.revision, roots);
            assert.deepEqual(proof.indent, {
              pageId: h.key.pageId,
              parentId: h.blocks[0]!.id,
              beforeBlockId: null,
            });
            await owner.moveSelectedBlocks(proof, proof.indent!);
            let current = await h.read(h.key.pageId);
            assert.isTrue(
              current.blocks
                .filter((b) => roots.includes(b.id))
                .every((b) => b.parentId === h.blocks[0]!.id),
            );
            proof = await owner.selectBlocks(h.key.pageId, current.revision, roots);
            assert.isNotNull(proof.outdent);
            await owner.moveSelectedBlocks(proof, proof.outdent!);
            current = await h.read(h.key.pageId);
            assert.deepEqual(
              current.blocks.map((b) => b.id),
              h.blocks.map((b) => b.id),
            );
            await owner.compensate("undo");
            assert.isTrue(
              (await h.read(h.key.pageId)).blocks
                .filter((b) => roots.includes(b.id))
                .every((b) => b.parentId === h.blocks[0]!.id),
            );
            await owner.compensate("redo");
            source = await h.read(h.key.pageId);
            proof = await owner.selectBlocks(h.key.pageId, source.revision, roots);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: h.blocks[0]!.id,
            });
            assert.deepEqual(
              (await h.read(h.key.pageId)).blocks.map((b) => b.id),
              [h.blocks[2]!.id, h.blocks[3]!.id, h.blocks[0]!.id, h.blocks[1]!.id],
            );
            assert.isTrue(
              h.blockRequests.every((r) => JSON.stringify(r.blockIds) === JSON.stringify(roots)),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "persists block-move intent before sending and recovers an exact committed receipt after reload without renewing identity",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            let owner = h.make();
            const source = await h.read(h.key.pageId);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[2]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            h.disk.fail = true;
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.pages[1]!,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.blockRequests.length, 0);
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            h.disk.fail = false;
            h.network.lose = "after";
            await expect(owner.recover()).rejects.toThrow("Lost committed response");
            assert.deepEqual(h.blockRequests[0], pending.request.input);
            h.setWritable(false);
            owner = h.reload();
            await owner.recover();
            assert.deepEqual(h.lookups[0], { request: pending.request });
            assert.equal(h.blockRequests.length, 1);
            assert.isNull(owner.getSnapshot().journal.pending);
            h.setWritable(true);
            await owner.compensate("undo");
            assert.deepEqual(
              (await h.read(h.key.pageId)).blocks.map((b) => b.id),
              h.blocks.map((b) => b.id),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses missing block feature, dirty PM source, partial windows and subtree cycles without mutation",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId);
            h.setBlockFeature(false);
            await expect(
              owner.selectBlocks(h.key.pageId, source.revision, [h.blocks[0]!.id]),
            ).rejects.toThrow("does not advertise");
            assert.isNull(owner.getSnapshot().blockSelection);
            h.setBlockFeature(true);
            const separate = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[0]!.id,
              h.blocks[3]!.id,
            ]);
            assert.isNull(separate.inverse);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[0]!.id,
            ]);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.key.pageId,
                parentId: h.blocks[0]!.id,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("selected subtree");
            h.setWritable(false);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.key.pageId,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("Operate revoked");
            h.setWritable(true);
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            try {
              doc.session.apply([
                { kind: "replace", block: savedParagraph(h.blocks[2]!.id, "unsaved") },
              ]);
              await doc.session.persistDraft();
              assert.throws(
                () => view.bridge.blockMoveSelection(view.state),
                "clean, current and complete",
              );
              await owner.loadBody(h.pages[1]!);
              await expect(
                owner.moveSelectedBlocks(proof, {
                  pageId: h.pages[1]!,
                  parentId: null,
                  beforeBlockId: null,
                }),
              ).rejects.toThrow("affected document");
              const reload = h.reload();
              const restoredProof = await reload.selectBlocks(h.key.pageId, source.revision, [
                h.blocks[0]!.id,
              ]);
              await reload.loadBody(h.pages[1]!);
              await expect(
                reload.moveSelectedBlocks(restoredProof, {
                  pageId: h.pages[1]!,
                  parentId: null,
                  beforeBlockId: null,
                }),
              ).rejects.toThrow("retained draft");
            } finally {
              view.stop();
              opened.release();
            }
            assert.equal(h.blockRequests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
          const current = yield* service.getPage(h.key);
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "partial-block-window",
            receiptEpoch: current.mutationAdmission.epoch,
            baseRevision: current.page.revision,
            generation: 3,
            mutations: Array.from({ length: 97 }, (_, i) => ({
              kind: "insert" as const,
              block: savedParagraph(
                `partial-move-${i}`,
                "row",
                (BigInt(i + 1) * 1000n).toString(16).padStart(32, "0"),
              ),
            })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            const page = await h.ports.getPage(h.key);
            await expect(
              owner.selectBlocks(h.key.pageId, page.page.revision, [h.blocks[0]!.id]),
            ).rejects.toThrow("complete source window");
            assert.equal(h.blockRequests.length, 0);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "moves an opaque/media/owned-page subtree without changing payloads, marker IDs or current asset pins",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          const source = yield* service.getPage(h.key);
          const list = {
            ...savedParagraph(
              "opaque-move-list",
              "Opaque container",
              "10000000000000000000000000000000",
            ),
            type: "bulleted_item",
          };
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "seed-opaque-move-list",
            receiptEpoch: source.mutationAdmission.epoch,
            baseRevision: source.page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block: list }],
          });
          const opaque: C.SpaceBlock = {
            id: C.SpaceBlockId.make("moving-future"),
            parentId: list.id,
            order: "90000000000000000000000000000000",
            type: "future_widget",
            version: 9,
            content: { nested: [{ exact: true }] },
            future: ["opaque", 23],
          };
          const media: C.SpaceBlock = {
            id: C.SpaceBlockId.make("moving-existing-image"),
            parentId: list.id,
            order: "a0000000000000000000000000000000",
            type: "image",
            version: 1,
            content: {
              assetId: "existing-asset",
              caption: [{ text: "existing caption", marks: [] }],
            },
          };
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            const row = sql
              .prepare("SELECT payload,logical_bytes FROM spaces_blocks WHERE block_id=?")
              .get(h.a.ownerBlockId)!;
            const owner = { ...JSON.parse(String(row.payload)), parentId: list.id };
            const payload = JSON.stringify(owner),
              bytes = Buffer.byteLength(payload);
            sql
              .prepare(
                "UPDATE spaces_blocks SET parent_id=?,payload=?,logical_bytes=? WHERE block_id=?",
              )
              .run(list.id, payload, bytes, h.a.ownerBlockId);
            sql
              .prepare("UPDATE spaces_pages SET block_bytes=block_bytes+? WHERE page_id=?")
              .run(bytes - Number(row.logical_bytes), h.key.pageId);
            for (const block of [opaque, media]) {
              const json = JSON.stringify(block),
                size = Buffer.byteLength(json);
              sql.prepare("INSERT INTO spaces_ids(id,kind) VALUES (?,'block')").run(block.id);
              sql
                .prepare(
                  "INSERT INTO spaces_blocks(block_id,page_id,parent_id,rank,payload,logical_bytes,deleted) VALUES (?,?,?,?,?,?,0)",
                )
                .run(block.id, h.key.pageId, block.parentId, block.order, json, size);
              sql
                .prepare(
                  "UPDATE spaces_pages SET block_count=block_count+1,block_bytes=block_bytes+? WHERE page_id=?",
                )
                .run(size, h.key.pageId);
            }
            sql
              .prepare("INSERT INTO spaces_block_asset_refs(block_id,asset_id) VALUES (?,?)")
              .run(media.id, "existing-asset");
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            try {
              for (const id of [opaque.id, media.id]) {
                let position = -1;
                view.state.doc.descendants((node, pos) => {
                  if (node.attrs.block?.id === id) position = pos;
                });
                const atom = view.state.apply(
                  view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)),
                );
                assert.deepEqual(view.bridge.blockMoveSelection(atom).blockIds, [id]);
              }
              const state = view.state.apply(
                view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)),
              );
              const selected = view.bridge.blockMoveSelection(state);
              assert.deepEqual(selected.blockIds, [list.id]);
              const owner = h.make(),
                proof = await owner.selectBlocks(
                  h.key.pageId,
                  selected.revision,
                  selected.blockIds,
                );
              assert.isTrue(
                proof.selectedIds.includes(opaque.id) &&
                  proof.selectedIds.includes(media.id) &&
                  proof.selectedIds.includes(h.a.ownerBlockId),
              );
              await owner.loadBody(h.otherRoot);
              await owner.moveSelectedBlocks(proof, {
                pageId: h.otherRoot,
                parentId: null,
                beforeBlockId: null,
              });
              const parent = await h.ports.getPage({ environmentId, pageId: h.otherRoot });
              const body = await h.run(
                service.readBlocks({
                  environmentId,
                  pageId: h.otherRoot,
                  revision: parent.page.revision,
                }),
              );
              assert.deepEqual(
                body.blocks.find((b) => b.id === opaque.id),
                opaque,
              );
              assert.deepEqual(
                body.blocks.find((b) => b.id === media.id),
                media,
              );
              const child = await h.ports.getPage({ environmentId, pageId: h.a.page.id });
              assert.deepEqual(child.page.location, {
                kind: "child",
                spaceId: h.other,
                parentPageId: h.otherRoot,
                ownerBlockId: h.a.ownerBlockId,
              });
              assert.equal(
                (await h.ports.getPage({ environmentId, pageId: h.descendant.page.id })).page
                  .spaceId,
                h.other,
              );
              const pins = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.deepEqual(
                  pins
                    .prepare("SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=?")
                    .all(media.id)
                    .map((r) => r.asset_id),
                  ["existing-asset"],
                );
              } finally {
                pins.close();
              }
              await owner.compensate("undo");
              const restored = await h.ports.getPage({ environmentId, pageId: h.a.page.id });
              assert.deepEqual(restored.page.location, h.a.page.location);
              let position = -1;
              view.state.doc.descendants((node, pos) => {
                if (node.attrs.block?.id === media.id) position = pos;
              });
              const atom = view.state.apply(
                view.state.tr.setSelection(NodeSelection.create(view.state.doc, position)),
              );
              const selectedAtom = view.bridge.blockMoveSelection(atom);
              const mediaProof = await owner.selectBlocks(
                h.key.pageId,
                selectedAtom.revision,
                selectedAtom.blockIds,
              );
              await owner.loadBody(h.otherRoot);
              await owner.moveSelectedBlocks(mediaProof, {
                pageId: h.otherRoot,
                parentId: null,
                beforeBlockId: null,
              });
              const dest = await h.ports.getPage({ environmentId, pageId: h.otherRoot });
              const movedMedia = (
                await h.run(
                  service.readBlocks({
                    environmentId,
                    pageId: h.otherRoot,
                    revision: dest.page.revision,
                  }),
                )
              ).blocks[0]!;
              assert.equal(movedMedia.id, media.id);
              assert.deepEqual(movedMedia.content, media.content);
              await owner.compensate("undo");
              assert.equal(h.blockRequests.length, 4);
            } finally {
              view.stop();
              opened.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps attempted block inverse on a revision conflict and refuses obsolete sibling anchors without guard renewal",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[2]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            const frozen = owner.getSnapshot().journal.history!.guards;
            const parent = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                ...h.key,
                mutationId: "concurrent-block-inverse-parent",
                receiptEpoch: parent.mutationAdmission.epoch,
                baseRevision: parent.page.revision,
                title: "Newer parent",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(h.blockRequests[1]!.guards, frozen);
            assert.equal(owner.getSnapshot().journal.history?.direction, "undo");
            await owner.reinspect();
            const current = await h.read(h.pages[1]!);
            const back = await owner.selectBlocks(h.pages[1]!, current.revision, [h.blocks[2]!.id]);
            await owner.loadBody(h.key.pageId);
            await owner.moveSelectedBlocks(back, {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: h.blocks[3]!.id,
            });
            const restored = await h.read(h.key.pageId);
            const forward = await owner.selectBlocks(h.key.pageId, restored.revision, [
              h.blocks[2]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(forward, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            const history = owner.getSnapshot().journal.history;
            const target = await h.ports.getPage(h.key);
            await h.run(
              service.applyBlockBatch({
                ...h.key,
                mutationId: "retire-block-inverse-anchor",
                receiptEpoch: target.mutationAdmission.epoch,
                baseRevision: target.page.revision,
                generation: 3,
                mutations: [{ kind: "delete", blockId: h.blocks[3]!.id }],
              }),
            );
            await expect(owner.compensate("undo")).rejects.toThrow(
              "inverse placement is unavailable",
            );
            assert.deepEqual(owner.getSnapshot().journal.history, history);
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a complete selection whose actual inspection work exceeds the server node bound without chunking or persisting intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const source = yield* service.getPage(h.key);
          const blocks = Array.from({ length: 100 }, (_, i) =>
            savedParagraph(
              `node-budget-${i}`,
              "row",
              (BigInt(i + 1) * 10000n).toString(16).padStart(32, "0"),
            ),
          );
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "seed-node-budget",
            receiptEpoch: source.mutationAdmission.epoch,
            baseRevision: source.page.revision,
            generation: 1,
            mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make(),
              page = await h.ports.getPage(h.key);
            const proof = await owner.selectBlocks(
              h.key.pageId,
              page.page.revision,
              blocks.slice(0, 99).map((b) => b.id),
            );
            await owner.loadBody(h.pages[1]!);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.pages[1]!,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("maxMutationNodes");
            assert.isNull(owner.getSnapshot().journal.pending);
            assert.equal(h.blockRequests.length, 0);
            assert.equal((await h.ports.getPage(h.key)).page.revision, page.page.revision);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses block list depth17 whole but permits a revision-guarded move at16 and its inverse",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          const page = yield* service.getPage(h.key);
          const chain = Array.from({ length: 16 }, (_, i) => ({
            ...savedParagraph(
              `block-depth-${i}`,
              "List",
              (BigInt(i + 1) * 1000n).toString(16).padStart(32, "0"),
            ),
            type: "bulleted_item",
            parentId: i === 0 ? null : C.SpaceBlockId.make(`block-depth-${i - 1}`),
          }));
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "seed-block-depth",
            receiptEpoch: page.mutationAdmission.epoch,
            baseRevision: page.page.revision,
            generation: 2,
            mutations: chain.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId);
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, [
              h.blocks[2]!.id,
            ]);
            await expect(
              owner.moveSelectedBlocks(proof, {
                pageId: h.key.pageId,
                parentId: chain[15]!.id,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("maxDepth");
            assert.equal(h.blockRequests.length, 0);
            assert.isNull(owner.getSnapshot().journal.pending);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.key.pageId,
              parentId: chain[14]!.id,
              beforeBlockId: null,
            });
            assert.equal(
              (await h.read(h.key.pageId)).blocks.find((b) => b.id === h.blocks[2]!.id)?.parentId,
              chain[14]!.id,
            );
            await owner.compensate("undo");
            assert.isNull(
              (await h.read(h.key.pageId)).blocks.find((b) => b.id === h.blocks[2]!.id)?.parentId,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "moves complete roots from separate original placements in source order while honestly refusing an unsupported inverse",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make(),
              source = await h.read(h.key.pageId),
              roots = [h.blocks[0]!.id, h.blocks[3]!.id];
            const proof = await owner.selectBlocks(h.key.pageId, source.revision, roots);
            assert.isNull(proof.inverse);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            assert.deepEqual(h.blockRequests[0]!.blockIds, roots);
            assert.deepEqual(
              (await h.read(h.pages[1]!)).blocks.map((b) => b.id),
              [h.blocks[0]!.id, h.blocks[1]!.id, h.blocks[3]!.id],
            );
            assert.isNull(owner.getSnapshot().journal.history);
            assert.include(owner.getSnapshot().notice!, "Undo is unavailable");
            await expect(owner.compensate("undo")).rejects.toThrow("No guarded placement");
            assert.equal(h.blockRequests.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates a child once across a lost reply and reload through the durable journal", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        const owner = h.make();
        yield* Effect.promise(async () => {
          await owner.loadBody(h.pages[0]!);
          h.network.lose = "after";
          await expect(
            owner.createChild("New child", {
              pageId: h.pages[0]!,
              parentId: null,
              beforeBlockId: null,
            }),
          ).rejects.toThrow(/Lost committed/);
          const pending = owner.getSnapshot().journal.pending!;
          assert.equal(pending.request.operation, "createChildPage");
          const recovered = h.reload();
          h.setWritable(false);
          await recovered.recover();
          assert.equal(recovered.getSnapshot().journal.pending, null);
          assert.equal(h.childRequests.length, 1);
          assert.deepEqual(h.lookups[0]!.request, pending.request);
          const children = await h.run(
            service.listPages({ environmentId, spaceId: h.spaceId, parentPageId: h.pages[0]! }),
          );
          assert.equal(children.items.length, 1);
          const child = children.items[0]!;
          assert.equal(child.title, "New child");
          assert.equal(child.location?.kind, "child");
          const body = await h.run(
            service.readBlocks({
              environmentId,
              pageId: h.pages[0]!,
              revision: (await h.run(service.getPage({ environmentId, pageId: h.pages[0]! }))).page
                .revision,
            }),
          );
          assert.equal(body.blocks.filter((b) => b.type === "child_page").length, 1);
          assert.include(recovered.getSnapshot().notice!, "guarded recovery");
        });
      }),
    ),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "previews and recovers the exact trash/restore closure without reading trashed bodies",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const owner = h.make();
          yield* Effect.promise(async () => {
            await owner.loadBody(h.pages[0]!);
            await owner.createChild("Nested", {
              pageId: h.pages[0]!,
              parentId: null,
              beforeBlockId: null,
            });
            const child = (
              await h.run(
                service.listPages({ environmentId, spaceId: h.spaceId, parentPageId: h.pages[0]! }),
              )
            ).items[0]!;
            await owner.previewRecovery(h.pages[0]!, "trash");
            assert.deepEqual(
              new Set(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds),
              new Set([h.pages[0], child.id]),
            );
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.browseTrash();
            assert.deepEqual(
              owner.getSnapshot().trash!.items.map((p) => p.pageId),
              [h.pages[0]],
            );
            await owner.previewRecovery(h.pages[0]!, "restore");
            h.network.lose = "after";
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!),
            ).rejects.toThrow(/Lost committed/);
            const pending = owner.getSnapshot().journal.pending!;
            const recovered = h.reload();
            h.setWritable(false);
            h.setBlockFeature(false);
            await recovered.recover();
            assert.equal(recovered.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 2);
            assert.equal(
              (await h.run(service.getPage({ environmentId, pageId: child.id }))).page.trash,
              undefined,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("persists child intent before send and preserves exact identity on an unsent retry", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* blockMoveFixture(service);
        yield* Effect.promise(async () => {
          const route = h.documents.open(h.key),
            panel = h.documents.open(h.key);
          const doc = await route.ready;
          assert.equal(await panel.ready, doc);
          const owner = h.make();
          try {
            await owner.loadBody(h.key.pageId);
            await expect(
              owner.createChild("x".repeat(h.capability.limits.maxTitleBytes), {
                pageId: h.key.pageId,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow();
            assert.equal(h.childRequests.length, 0);
            assert.equal(owner.getSnapshot().journal.pending, null);
            h.disk.fail = true;
            await expect(
              owner.createChild("In list", {
                pageId: h.key.pageId,
                parentId: h.blocks[0]!.id,
                beforeBlockId: h.blocks[1]!.id,
              }),
            ).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.childRequests.length, 0);
            assert.isTrue(doc.structureBlocked());
            assert.throws(
              () =>
                doc.session.apply([
                  { kind: "insert", block: savedParagraph("blocked-create", "not applied") },
                ]),
              "reserved",
            );
            assert.throws(() =>
              decodeSpaceStructureJournal(
                {
                  ...owner.getSnapshot().journal,
                  pending: { ...pending, knownBlockIds: undefined },
                },
                environmentId,
              ),
            );
            h.disk.fail = false;
            await owner.recover();
            assert.deepEqual(h.childRequests[0], pending.request.input);
            assert.isFalse(doc.structureBlocked());
            assert.equal(
              doc.session.getSnapshot().baseRevision,
              (await h.ports.getPage(h.key)).page.revision,
            );
            const body = await h.read(h.key.pageId);
            const marker = body.blocks.find((b) => b.type === "child_page")!;
            assert.equal(marker.parentId, h.blocks[0]!.id);
            const siblings = body.blocks.filter((b) => b.parentId === h.blocks[0]!.id);
            assert.equal(siblings[0]!.id, marker.id);
            assert.equal(siblings[1]!.id, h.blocks[1]!.id);
            assert.deepEqual(
              body.blocks.filter((b) => b.type !== "child_page"),
              h.blocks,
            );
          } finally {
            route.release();
            panel.release();
          }
        });
      }),
    ),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a frozen recovery conflict and refuses hidden drafts, read-only writes and missing recovery support",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            const preview = owner.getSnapshot().recoveryPreview!;
            const hidden = h.documents.open({ environmentId, pageId: h.a.page.id });
            const doc = await hidden.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("hidden-before-trash", "retained") },
            ]);
            await doc.session.persistDraft();
            hidden.release();
            await expect(owner.confirmRecovery(preview)).rejects.toThrow(/Resolve|draft/);
            assert.equal(h.recoveryRequests.length, 0);
            await doc.discard();
            h.setWritable(false);
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("Operate revoked");
            h.setWritable(true);
            h.setBlockFeature(false);
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("unsupported");
            h.setBlockFeature(true);
            const current = await h.ports.getPage({ environmentId, pageId: h.descendant.page.id });
            await h.run(
              service.updatePage({
                environmentId,
                pageId: current.page.id,
                mutationId: "concurrent-recovery-title",
                receiptEpoch: current.mutationAdmission.epoch,
                baseRevision: current.page.revision,
                title: "Concurrent title",
              }),
            );
            await owner.confirmRecovery(preview);
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            if (pending.request.operation !== "trashPage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(pending.request.input.guards, preview.inspection.guards);
            assert.equal(h.recoveryRequests.length, 1);
            assert.equal((await h.ports.getPage(h.key)).page.trash, undefined);
            await expect(owner.recover()).rejects.toThrow("No uncertain");
            await owner.reinspect();
            assert.equal(owner.getSnapshot().journal.pending, null);
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("Inspect");
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps trash receipts exact through storage failure, reload and read-only recovery, gating both resident consumers",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            await owner.previewRecovery(h.key.pageId, "trash");
            h.disk.fail = true;
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!),
            ).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.recoveryRequests.length, 0);
            assert.isTrue(doc.structureBlocked());
            h.disk.fail = false;
            h.network.lose = "after";
            await expect(owner.recover()).rejects.toThrow("Lost committed response");
            h.setWritable(false);
            // The definite receipt is persisted before every resident refresh is attempted.
            await expect(owner.recover()).rejects.toThrow("could not refresh");
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 1);
            assert.isNotNull(doc.getSnapshot().error);
            assert.isFalse(doc.structureBlocked());
            h.setWritable(true);
            await owner.previewRecovery(h.key.pageId, "restore");
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!),
            ).rejects.toThrow("Resolve");
            route.release();
            panel.release();
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            assert.equal((await h.ports.getPage(h.key)).page.trash, undefined);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "previews fallback restore while retaining independent batches and current moved-out ownership",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.descendant.page.id, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "trash");
            assert.deepEqual(
              new Set(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds),
              new Set([h.pages[0], h.a.page.id]),
            );
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const placement = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.a.page.id },
                destination: placement,
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.movePage({
                environmentId,
                pageId: h.a.page.id,
                destination: placement,
                guards: inspected.guards,
                mutationId: "detach-hidden-child",
                receiptEpoch: admission.mutationAdmission.epoch,
              }),
            );
            await owner.previewRecovery(h.pages[0]!, "restore");
            assert.deepEqual(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds, [
              h.pages[0]!,
            ]);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.browseTrash();
            const moved = owner.getSnapshot().trash!.items.find((p) => p.pageId === h.a.page.id)!;
            assert.equal(moved.trash.originalRootPageId, h.pages[0]);
            await owner.previewRecovery(h.a.page.id, "restore");
            assert.deepEqual(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds, [
              h.a.page.id,
            ]);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location?.kind,
              "root",
            );
            await owner.previewRecovery(h.pages[1]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.b.page.id, "restore");
            assert.match(
              owner.getSnapshot().recoveryPreview!.placement,
              /original surviving space root/,
            );
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const restored = await h.ports.getPage({ environmentId, pageId: h.b.page.id });
            assert.equal(restored.page.location?.kind, "root");
            assert.equal(restored.page.id, h.b.page.id);
            const ref = await h.run(
              service.resolveReference({
                environmentId,
                target: { kind: "block", blockId: h.b.ownerBlockId },
              }),
            );
            assert.equal(ref.status, "deleted");
            await owner.browseTrash();
            assert.isTrue(
              owner.getSnapshot().trash!.items.some((p) => p.pageId === h.descendant.page.id),
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps empty continuing trash windows pageable and never reads their content bodies",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            h.setRows(1);
            await owner.browseTrash();
            const windows = [owner.getSnapshot().trash!];
            await owner.browseTrash(true);
            windows.push(owner.getSnapshot().trash!);
            await owner.browseTrash(true);
            windows.push(owner.getSnapshot().trash!);
            assert.isTrue(windows.some((w) => w.items.length === 0 && w.nextCursor !== null));
            assert.equal(windows[2]!.nextCursor, null);
            assert.deepEqual(
              windows.flatMap((w) => w.items.map((p) => p.pageId)),
              [h.pages[0]],
            );
            assert.deepEqual(h.documentReads.attempted, []);
            assert.deepEqual(h.structureBodyReads, []);
            await expect(owner.browseTrash(true)).rejects.toThrow("No next");
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a partial creation parent and over-eight-page recovery closure before journaling or sending",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          for (const _ of [1, 2, 3, 4, 5]) yield* h.child(h.pages[0]!);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            assert.equal(owner.getSnapshot().recoveryPreview!.inspection.guards.pages.length, 8);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "restore");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await h.run(h.child(h.pages[0]!));
            await expect(owner.previewRecovery(h.pages[0]!, "trash")).rejects.toThrow("eight-page");
            assert.equal(h.recoveryRequests.length, 2);
            assert.equal(owner.getSnapshot().journal.pending, null);
            const current = await h.ports.getPage({ environmentId, pageId: h.pages[2]! });
            await h.run(
              service.applyBlockBatch({
                environmentId,
                pageId: current.page.id,
                baseRevision: current.page.revision,
                generation: 1,
                mutationId: "creation-window-100",
                receiptEpoch: current.mutationAdmission.epoch,
                mutations: Array.from({ length: 100 }, (_, i) => ({
                  kind: "insert" as const,
                  block: savedParagraph(
                    `creation-${i}`,
                    "text",
                    BigInt(i + 1)
                      .toString(16)
                      .padStart(32, "0"),
                  ),
                })),
              }),
            );
            const more = await h.ports.getPage({ environmentId, pageId: h.pages[2]! });
            await h.run(
              service.applyBlockBatch({
                environmentId,
                pageId: more.page.id,
                baseRevision: more.page.revision,
                generation: 2,
                mutationId: "creation-window-101",
                receiptEpoch: more.mutationAdmission.epoch,
                mutations: [
                  {
                    kind: "insert",
                    block: savedParagraph(
                      "creation-100",
                      "text",
                      "80000000000000000000000000000000",
                    ),
                  },
                ],
              }),
            );
            await owner.loadBody(more.page.id);
            assert.isNotNull(owner.getSnapshot().body!.nextCursor);
            await expect(
              owner.createChild("Refused", {
                pageId: more.page.id,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow("complete parent");
            assert.equal(h.childRequests.length, 0);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["id", "epoch", "new-page-revision", "existing-owner", "missing-parent"] as const)(
  "retains a real committed child intent when its wire acknowledgement has corrupt %s, then recovers the original receipt",
  (kind) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* blockMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            h.network.rewriteChildReply = (reply) => {
              if (reply.status !== "saved") throw new Error("Expected a real child commit");
              switch (kind) {
                case "id":
                  return { ...reply, mutationId: C.SpaceMutationId.make("wrong-id") };
                case "epoch":
                  return { ...reply, receiptEpoch: C.SpaceReceiptEpoch.make("wrong-epoch") };
                case "new-page-revision":
                  return { ...reply, page: { ...reply.page, revision: 1 } };
                case "existing-owner":
                  return {
                    ...reply,
                    ownerBlockId: h.blocks[0]!.id,
                    page: {
                      ...reply.page,
                      location: {
                        kind: "child",
                        spaceId: h.spaceId,
                        parentPageId: h.key.pageId,
                        ownerBlockId: h.blocks[0]!.id,
                      },
                    },
                  };
                case "missing-parent":
                  return {
                    ...reply,
                    changed: {
                      ...reply.changed,
                      pages: reply.changed.pages.filter((p) => p.pageId !== h.key.pageId),
                    },
                  };
              }
            };
            await expect(
              owner.createChild("Verified child", {
                pageId: h.key.pageId,
                parentId: null,
                beforeBlockId: null,
              }),
            ).rejects.toThrow(/Mismatched/);
            const pending = owner.getSnapshot().journal.pending!;
            assert.isNotNull(pending);
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            await owner.recover();
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups[0]!.request, pending.request);
            assert.equal(h.childRequests.length, 1);
            const children = await h.run(
              service.listPages({ environmentId, spaceId: h.spaceId, parentPageId: h.key.pageId }),
            );
            assert.equal(children.items.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains the exact attempted child creation on a real parent-revision conflict without generating another child",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            h.disk.hold = true;
            const creating = owner.createChild("Conflicted child", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            await h.disk.started.promise;
            const pending = owner.getSnapshot().journal.pending!;
            const current = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                ...h.key,
                mutationId: "child-race",
                receiptEpoch: current.mutationAdmission.epoch,
                baseRevision: current.page.revision,
                title: "Peer title",
              }),
            );
            h.disk.release.resolve();
            await creating;
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.deepEqual(owner.getSnapshot().journal.pending!.request, pending.request);
            assert.equal(h.childRequests.length, 1);
            assert.equal(
              (
                await h.run(
                  service.listPages({
                    environmentId,
                    spaceId: h.spaceId,
                    parentPageId: h.key.pageId,
                  }),
                )
              ).items.length,
              0,
            );
            await owner.reinspect();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Explicit new intent", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            assert.notEqual(h.childRequests[1]!.mutationId, h.childRequests[0]!.mutationId);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "compensates an acknowledged child creation with guarded trash and restore redo preserving its allocated marker",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Undo created child", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            const child = (
              await h.run(
                service.listPages({
                  environmentId,
                  spaceId: h.spaceId,
                  parentPageId: h.key.pageId,
                }),
              )
            ).items[0]!;
            await owner.compensate("undo");
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: child.id },
                }),
              ),
              { status: "trashed", pageId: child.id },
            );
            await owner.compensate("redo");
            const restored = (await h.ports.getPage({ environmentId, pageId: child.id })).page;
            assert.deepEqual(restored.location, child.location);
            assert.equal(h.childRequests.length, 1);
            assert.deepEqual(
              h.recoveryRequests.map((r) => r.operation),
              ["trashPage", "restorePage"],
            );
            assert.equal(new Set(h.recoveryRequests.map((r) => r.input.mutationId)).size, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "requires explicit bounded purge confirmation and retires the inspected current trash root",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            const preview = owner.getSnapshot().recoveryPreview!;
            await expect(owner.confirmRecovery(preview)).rejects.toThrow("confirmation");
            const root = await h.ports.getPage({ environmentId, pageId: h.pages[2]! });
            await h.run(
              service.createPage({
                environmentId,
                spaceId: h.spaceId,
                title: "Concurrent root",
                mutationId: "purge-root-race",
                receiptEpoch: root.mutationAdmission.epoch,
                baseRootOrderRevision: root.space.rootOrderRevision,
              }),
            );
            await owner.confirmRecovery(preview, true);
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.equal(owner.getSnapshot().journal.pending!.rejection, undefined);
            const retainedPurge = owner.getSnapshot().journal.pending!.request;
            if (retainedPurge.operation !== "permanentlyDeletePage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(retainedPurge.input.guards, preview.inspection.guards);
            await owner.reinspect();
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true);
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.pages[0]! },
                }),
              ),
              { status: "deleted" },
            );
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.descendant.page.id },
                }),
              ),
              { status: "deleted" },
            );
            assert.equal(owner.getSnapshot().journal.history, null);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "undoes and redoes only the selected recovery batch while independently trashed descendants remain hidden",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.descendant.page.id, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "trash");
            const independent = owner
              .getSnapshot()
              .recoveryPreview!.inspection.pages.find((p) => p.id === h.descendant.page.id)!.trash!;
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.compensate("undo");
            assert.equal((await h.ports.getPage(h.key)).page.trash, undefined);
            const hidden = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.descendant.page.id },
                recovery: "restore",
              }),
            );
            assert.deepEqual(
              hidden.pages.find((p) => p.id === h.descendant.page.id)!.trash,
              independent,
            );
            await owner.compensate("redo");
            const root = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.pages[0]! },
                recovery: "restore",
              }),
            );
            assert.deepEqual(new Set(root.recovery!.pageIds), new Set([h.pages[0]!, h.a.page.id]));
            assert.deepEqual(
              root.pages.find((p) => p.id === h.descendant.page.id)!.trash,
              independent,
            );
            await owner.compensate("undo");
            assert.deepEqual(
              (await h.ports.getPage({ environmentId, pageId: h.a.page.id })).page.location,
              h.a.page.location,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses moved-out recovery closure and fallback-restore inverse without resurrecting owner markers",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const history = owner.getSnapshot().journal.history;
            const destination = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspect = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.a.page.id },
                destination,
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.movePage({
                environmentId,
                pageId: h.a.page.id,
                mutationId: "move-out-before-undo",
                receiptEpoch: admission.mutationAdmission.epoch,
                destination,
                guards: inspect.guards,
              }),
            );
            await expect(owner.compensate("undo")).rejects.toThrow(/closure|unavailable/);
            assert.deepEqual(owner.getSnapshot().journal.history, history);
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.equal(h.recoveryRequests.length, 1);
            await owner.previewRecovery(h.pages[1]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.b.page.id, "restore");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            assert.equal(
              (await h.ports.getPage({ environmentId, pageId: h.b.page.id })).page.location?.kind,
              "root",
            );
            assert.equal(owner.getSnapshot().journal.history, null);
            assert.include(owner.getSnapshot().notice!, "changed placement");
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "block", blockId: h.b.ownerBlockId },
                }),
              ),
              { status: "deleted" },
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps a conflicting recovery undo draft with frozen guards instead of renewing them",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.a.page.id, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const history = owner.getSnapshot().journal.history!;
            const parent = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                ...h.key,
                mutationId: "parent-after-trash",
                receiptEpoch: parent.mutationAdmission.epoch,
                baseRevision: parent.page.revision,
                title: "Do not overwrite",
              }),
            );
            await owner.compensate("undo");
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            const retainedRestore = owner.getSnapshot().journal.pending!.request;
            if (retainedRestore.operation !== "restorePage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(retainedRestore.input.guards, history.guards);
            assert.deepEqual(owner.getSnapshot().journal.history, history);
            assert.equal(owner.getSnapshot().journal.pending!.direction, "undo");
            assert.equal((await h.ports.getPage(h.key)).page.title, "Do not overwrite");
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses create undo history if the allocated child changes before its acknowledgement is processed",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            h.network.after = async () => {
              const child = (
                await h.run(
                  service.listPages({
                    environmentId,
                    spaceId: h.spaceId,
                    parentPageId: h.key.pageId,
                  }),
                )
              ).items[0]!;
              const admission = await h.ports.getPage({ environmentId, pageId: child.id });
              await h.run(
                service.applyBlockBatch({
                  environmentId,
                  pageId: child.id,
                  mutationId: "newer-created-child",
                  receiptEpoch: admission.mutationAdmission.epoch,
                  baseRevision: child.revision,
                  generation: 1,
                  mutations: [
                    {
                      kind: "insert",
                      block: savedParagraph("newer-child-body", "Keep newer child"),
                    },
                  ],
                }),
              );
            };
            await owner.createChild("Already changed", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            assert.equal(owner.getSnapshot().journal.history, null);
            assert.include(owner.getSnapshot().notice!, "inverse guards");
            await expect(owner.compensate("undo")).rejects.toThrow("No guarded");
            assert.equal(h.recoveryRequests.length, 0);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers a lost purge reply after reload with the original request and no restoration or Undo",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            h.network.lose = "after";
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true),
            ).rejects.toThrow("Lost committed response");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(pending.request.operation, "permanentlyDeletePage");
            const recovered = h.reload();
            h.setWritable(false);
            h.setBlockFeature(false);
            await recovered.recover();
            assert.equal(recovered.getSnapshot().journal.pending, null);
            assert.equal(recovered.getSnapshot().journal.history, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 2);
            for (const id of [h.pages[0]!, h.a.page.id, h.descendant.page.id])
              assert.deepEqual(
                await h.run(
                  service.resolveReference({ environmentId, target: { kind: "page", pageId: id } }),
                ),
                { status: "deleted" },
              );
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "block", blockId: h.a.ownerBlockId },
                }),
              ),
              { status: "deleted" },
            );
            await expect(recovered.compensate("undo")).rejects.toThrow();
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "never deletes a changed purge selection and refuses non-root trash before creating an intent",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            let owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await expect(owner.previewRecovery(h.a.page.id, "permanentlyDelete")).rejects.toThrow();
            assert.equal(owner.getSnapshot().journal.pending, null);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            const preview = owner.getSnapshot().recoveryPreview!;
            const destination = { kind: "root" as const, spaceId: h.spaceId, beforePageId: null };
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.a.page.id },
                destination,
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.movePage({
                environmentId,
                pageId: h.a.page.id,
                mutationId: "move-after-purge-preview",
                receiptEpoch: admission.mutationAdmission.epoch,
                destination,
                guards: inspected.guards,
              }),
            );
            await owner.confirmRecovery(preview, true);
            assert.isTrue(owner.getSnapshot().journal.pending?.conflict);
            assert.equal(owner.getSnapshot().journal.pending!.rejection, "invalid_input");
            assert.deepEqual(
              owner.getSnapshot().journal.pending!.recoveryPageIds,
              preview.inspection.recovery!.pageIds,
            );
            const retainedRejectedPurge = owner.getSnapshot().journal.pending!.request;
            if (retainedRejectedPurge.operation !== "permanentlyDeletePage")
              throw new Error("Wrong retained recovery operation");
            assert.deepEqual(retainedRejectedPurge.input.guards, preview.inspection.guards);
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.pages[0]! },
                }),
              ),
              { status: "trashed", pageId: h.pages[0]! },
            );
            const rejected = owner.getSnapshot().journal.pending!;
            owner = h.reload();
            await owner.hydrate();
            assert.deepEqual(owner.getSnapshot().journal.pending, rejected);
            await owner.reinspect();
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("Inspect");
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            assert.deepEqual(owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds, [
              h.pages[0]!,
            ]);
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true);
            assert.deepEqual(
              await h.run(
                service.resolveReference({
                  environmentId,
                  target: { kind: "page", pageId: h.a.page.id },
                }),
              ),
              { status: "trashed", pageId: h.a.page.id },
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "persists purge before sending, interlocks two actual editors and gates the purged resident even when changed.pages is empty",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const route = h.documents.open(h.key),
              panel = h.documents.open(h.key);
            const doc = await route.ready;
            assert.equal(await panel.ready, doc);
            const view = savedView(doc);
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.key.pageId },
                recovery: "trash",
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.trashPage({
                ...h.key,
                mutationId: "external-trash-before-purge",
                receiptEpoch: admission.mutationAdmission.epoch,
                guards: inspected.guards,
              }),
            );
            const owner = h.make();
            try {
              await owner.previewRecovery(h.key.pageId, "permanentlyDelete");
              h.disk.fail = true;
              await expect(
                owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true),
              ).rejects.toThrow("abort");
              const pending = owner.getSnapshot().journal.pending!;
              assert.equal(h.recoveryRequests.length, 0);
              assert.isTrue(doc.structureBlocked());
              assert.isFalse(view.bridge.adapter.append()(view.state, view.dispatch));
              h.disk.fail = false;
              h.network.lose = "after";
              await expect(owner.recover()).rejects.toThrow("Lost committed response");
              h.setWritable(false);
              await expect(owner.recover()).rejects.toThrow("could not refresh");
              assert.equal(owner.getSnapshot().journal.pending, null);
              assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
              assert.equal(h.recoveryRequests.length, 1);
              assert.isFalse(doc.structureBlocked());
              assert.isNotNull(doc.getSnapshot().error);
              assert.isFalse(view.bridge.adapter.append()(view.state, view.dispatch));
              assert.isFalse(doc.session.getSnapshot().dirty);
            } finally {
              view.stop();
              route.release();
              panel.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses hidden durable drafts and live permission or feature withdrawal before permanent deletion",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const held = h.documents.open({ environmentId, pageId: h.a.page.id });
            const doc = await held.ready;
            doc.session.apply([
              { kind: "insert", block: savedParagraph("keep-hidden-purge-draft", "unsaved") },
            ]);
            await doc.session.persistDraft();
            held.release();
            const inspected = await h.run(
              service.inspectStructure({
                environmentId,
                target: { kind: "page", pageId: h.pages[0]! },
                recovery: "trash",
              }),
            );
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.trashPage({
                environmentId,
                pageId: h.pages[0]!,
                mutationId: "external-hidden-trash",
                receiptEpoch: admission.mutationAdmission.epoch,
                guards: inspected.guards,
              }),
            );
            const owner = h.reload();
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            const preview = owner.getSnapshot().recoveryPreview!;
            h.setWritable(false);
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("Operate revoked");
            h.setWritable(true);
            h.setBlockFeature(false);
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("unsupported");
            h.setBlockFeature(true);
            await expect(owner.confirmRecovery(preview, true)).rejects.toThrow("retained draft");
            assert.equal(h.recoveryRequests.length, 0);
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.isTrue(h.draftRecords.has(h.a.page.id));
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([5, 6])(
  "purges the complete eight-page boundary and refuses a ninth page without chunking (%s extra children)",
  (extra) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          for (const _ of Array.from({ length: extra })) yield* h.child(h.pages[0]!);
          const inspection = yield* service.inspectStructure({
            environmentId,
            target: { kind: "page", pageId: h.pages[0]! },
            recovery: "trash",
          });
          const admission = yield* service.listSpaces({ environmentId, limit: 1 });
          yield* service.trashPage({
            environmentId,
            pageId: h.pages[0]!,
            mutationId: "external-large-trash",
            receiptEpoch: admission.mutationAdmission.epoch,
            guards: inspection.guards,
          });
          yield* Effect.promise(async () => {
            const owner = h.make();
            if (extra === 6) {
              await expect(owner.previewRecovery(h.pages[0]!, "permanentlyDelete")).rejects.toThrow(
                "eight-page",
              );
              assert.equal(owner.getSnapshot().journal.pending, null);
              assert.equal(h.recoveryRequests.length, 0);
            } else {
              await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
              assert.equal(
                owner.getSnapshot().recoveryPreview!.inspection.recovery!.pageIds.length,
                8,
              );
              await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true);
              assert.equal(h.recoveryRequests.length, 1);
              assert.equal(owner.getSnapshot().journal.history, null);
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "preserves the recovery compensation prefix through codec write failure and exact lost-reply reload",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Recover undo", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            const created = (
              await h.run(
                service.listPages({
                  environmentId,
                  spaceId: h.spaceId,
                  parentPageId: h.key.pageId,
                }),
              )
            ).items[0]!;
            h.disk.fail = true;
            await expect(owner.compensate("undo")).rejects.toThrow("abort");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.recoveryRequests.length, 0);
            assert.equal(pending.direction, "undo");
            h.disk.fail = false;
            h.network.lose = "after";
            await expect(owner.recover()).rejects.toThrow("Lost committed response");
            const recovered = h.reload();
            h.setWritable(false);
            await recovered.recover();
            assert.equal(h.recoveryRequests.length, 1);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(recovered.getSnapshot().journal.history?.direction, "redo");
            h.setWritable(true);
            await recovered.compensate("redo");
            assert.deepEqual(
              (await h.ports.getPage({ environmentId, pageId: created.id })).page.location,
              created.location,
            );
            assert.equal(h.recoveryRequests.length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a purge intent on a truncated deleted-ID acknowledgement and recovers only the authoritative receipt",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* nestedMoveFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.previewRecovery(h.pages[0]!, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            await owner.previewRecovery(h.pages[0]!, "permanentlyDelete");
            h.network.rewritePurgeReply = (result) =>
              result.status === "saved"
                ? { ...result, deletedPageIds: result.deletedPageIds.slice(0, 1) }
                : result;
            await expect(
              owner.confirmRecovery(owner.getSnapshot().recoveryPreview!, true),
            ).rejects.toThrow("Mismatched permanent");
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(pending.conflict, false);
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            await owner.recover();
            assert.equal(owner.getSnapshot().journal.pending, null);
            assert.equal(owner.getSnapshot().journal.history, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.recoveryRequests.length, 2);
            assert.deepEqual(h.structureBodyReads, []);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "creates the first root page in an empty actual default space and recovers its lost reply without allocating twice",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.createSpace("New library");
            const created = owner.getSnapshot().libraryResult!.space!;
            const previous = (await h.ports.getPage(h.key)).space;
            await owner.setDefaultSpace(created, previous);
            const empty = await h.run(service.listPages({ environmentId, spaceId: created.id }));
            assert.equal(empty.items.length, 0);
            assert.isTrue(empty.space.isDefault);
            h.network.lose = "after";
            await expect(owner.createRootPage(empty.space, "First page")).rejects.toThrow(
              "Lost committed response",
            );
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(pending.request.operation, "createPage");
            const restored = h.reload();
            h.setWritable(false);
            await restored.recover();
            assert.equal(restored.getSnapshot().journal.pending, null);
            assert.deepEqual(h.lookups.at(-1)!.request, pending.request);
            assert.equal(h.libraryRequests.filter((r) => r.operation === "createPage").length, 1);
            const pages = await h.run(service.listPages({ environmentId, spaceId: created.id }));
            assert.equal(pages.items.length, 1);
            assert.equal(pages.items[0]!.title, "First page");
            assert.equal(restored.getSnapshot().libraryResult!.page!.id, pages.items[0]!.id);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a page-rename conflict against the chosen revision instead of refreshing its guard",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const selected = await h.ports.getPage(h.key);
            await h.run(
              service.updatePage({
                ...h.key,
                mutationId: "peer-title-before-rename",
                receiptEpoch: selected.mutationAdmission.epoch,
                baseRevision: selected.page.revision,
                title: "Peer title",
              }),
            );
            const owner = h.make();
            await owner.renamePage(selected.page, "My attempted title");
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            assert.equal(pending.request.operation, "updatePage");
            assert.equal(
              (pending.request.input as C.SpacePageUpdateInput).baseRevision,
              selected.page.revision,
            );
            assert.equal((await h.ports.getPage(h.key)).page.title, "Peer title");
            assert.equal(h.libraryRequests.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["createSpace", "renameSpace", "setDefaultSpace", "updatePage"] as const)(
  "recovers the original %s receipt after reload with operate withdrawn",
  (operation) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const selected = await h.ports.getPage(h.key);
            let candidate = selected.space;
            if (operation === "setDefaultSpace") {
              await owner.createSpace("Candidate");
              candidate = owner.getSnapshot().libraryResult!.space!;
            }
            const before = h.libraryRequests.length;
            h.network.lose = "after";
            const work =
              operation === "createSpace"
                ? owner.createSpace("Lost new space")
                : operation === "renameSpace"
                  ? owner.renameSpace(candidate, "Lost rename")
                  : operation === "setDefaultSpace"
                    ? owner.setDefaultSpace(candidate, selected.space)
                    : owner.renamePage(selected.page, "Lost page title");
            await expect(work).rejects.toThrow("Lost committed response");
            const original = h.stored()!.pending!;
            h.setWritable(false);
            const restored = h.reload();
            await restored.recover();
            assert.equal(h.libraryRequests.length, before + 1);
            assert.deepEqual(h.lookups.at(-1), { request: original.request });
            assert.isNull(restored.getSnapshot().journal.pending);
            assert.equal(restored.getSnapshot().libraryResult!.operation, operation);
            if (operation === "createSpace") {
              const spaces = await h.run(service.listSpaces({ environmentId }));
              assert.equal(spaces.items.filter((s) => s.title === "Lost new space").length, 1);
            } else if (operation === "renameSpace") {
              assert.equal(
                (await h.run(service.listPages({ environmentId, spaceId: candidate.id }))).space
                  .revision,
                candidate.revision + 1,
              );
            } else if (operation === "setDefaultSpace") {
              const spaces = await h.run(service.listSpaces({ environmentId }));
              assert.equal(spaces.defaultSpaceId, candidate.id);
              assert.isFalse(spaces.items.find((s) => s.id === selected.space.id)!.isDefault);
            } else {
              assert.equal(
                (await h.ports.getPage(h.key)).page.revision,
                selected.page.revision + 1,
              );
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "interlocks two rename consumers before strict-codec persistence and retries the identical unsent intent after storage failure",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const first = h.documents.open(h.key),
              second = h.documents.open(h.key);
            const doc = await first.ready;
            assert.equal(await second.ready, doc);
            const selected = await h.ports.getPage(h.key);
            const owner = h.make();
            h.disk.hold = true;
            h.disk.fail = true;
            const renaming = owner.renamePage(selected.page, "Durable title");
            await h.disk.started.promise;
            const pending = owner.getSnapshot().journal.pending!;
            assert.equal(h.libraryRequests.length, 0);
            assert.throws(
              () =>
                doc.session.apply([
                  { kind: "insert", block: savedParagraph("blocked-rename", "keep") },
                ]),
              "reserved",
            );
            await expect(doc.save()).rejects.toThrow("reserved");
            assert.throws(() => h.documents.acquire(h.key), "reserved");
            await expect(owner.createSpace("Overlapping action")).rejects.toThrow("in progress");
            h.disk.release.resolve();
            await expect(renaming).rejects.toThrow("abort");
            assert.equal(h.libraryRequests.length, 0);
            assert.deepEqual(owner.getSnapshot().journal.pending, pending);
            h.disk.hold = false;
            h.disk.fail = false;
            await owner.recover();
            assert.deepEqual(h.libraryRequests, [pending.request]);
            assert.equal(h.lookups.length, 0);
            assert.isFalse(doc.structureBlocked());
            assert.equal(doc.session.getSnapshot().baseRevision, selected.page.revision + 1);
            assert.equal(h.counts().refreshed, 1);
            first.release();
            second.release();
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses a hidden page draft on rename while library-only metadata preserves it", () =>
  Effect.scoped(
    fixture((service) =>
      Effect.gen(function* () {
        const h = yield* rootReorderFixture(service);
        yield* Effect.promise(async () => {
          const opened = h.documents.open(h.key),
            doc = await opened.ready;
          doc.session.apply([
            { kind: "insert", block: savedParagraph("library-hidden-draft", "Do not replace") },
          ]);
          await doc.session.persistDraft();
          opened.release();
          const draft = h.draftRecords.get(h.key.pageId)!;
          const selected = await h.ports.getPage(h.key);
          const owner = h.reload();
          await expect(owner.renamePage(selected.page, "Blocked title")).rejects.toThrow(
            "retained draft",
          );
          assert.equal(h.libraryRequests.length, 0);
          assert.isNull(owner.getSnapshot().journal.pending);
          await owner.renameSpace(selected.space, "Metadata only");
          assert.deepEqual(h.draftRecords.get(h.key.pageId), draft);
          assert.equal((await h.ports.getPage(h.key)).page.revision, selected.page.revision);
        });
      }),
    ),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a root creation conflict rather than advancing the selected root-order revision",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const selected = await h.ports.getPage(h.key);
            await h.run(
              service.createPage({
                environmentId,
                spaceId: h.spaceId,
                title: "Peer root",
                baseRootOrderRevision: selected.space.rootOrderRevision,
                mutationId: "peer-root-before-create",
                receiptEpoch: selected.mutationAdmission.epoch,
              }),
            );
            const owner = h.make();
            await owner.createRootPage(selected.space, "Attempted root");
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            assert.equal(pending.request.operation, "createPage");
            if (pending.request.operation !== "createPage") throw new Error("Wrong request");
            assert.equal(
              pending.request.input.baseRootOrderRevision,
              selected.space.rootOrderRevision,
            );
            assert.equal((await h.order()).length, 5);
            await expect(owner.createSpace("Blocked by conflict")).rejects.toThrow("Resolve");
            await owner.reinspect();
            assert.isNull(owner.getSnapshot().journal.pending);
            const current = await h.ports.getPage(h.key);
            await owner.createRootPage(current.space, "Explicit new root");
            assert.equal((await h.order()).length, 6);
            assert.notEqual(
              h.libraryRequests[0]!.input.mutationId,
              h.libraryRequests[1]!.input.mutationId,
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps an unsent library intent when operate is withdrawn during durable persistence",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            h.disk.hold = true;
            const work = owner.createSpace("Wait for permission");
            await h.disk.started.promise;
            const original = owner.getSnapshot().journal.pending!;
            h.setWritable(false);
            h.disk.release.resolve();
            await expect(work).rejects.toThrow("revoked");
            assert.equal(h.libraryRequests.length, 0);
            assert.deepEqual(h.stored()!.pending, original);
            h.disk.hold = false;
            h.setWritable(true);
            await owner.recover();
            assert.deepEqual(h.libraryRequests, [original.request]);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["renameSpace", "setDefaultSpace"] as const)(
  "preserves the selected space metadata guards through a %s race",
  (operation) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            const previous = (await h.ports.getPage(h.key)).space;
            await owner.createSpace("Candidate");
            const candidate = owner.getSnapshot().libraryResult!.space!;
            const changed = operation === "renameSpace" ? candidate : previous;
            const admission = await h.run(service.listSpaces({ environmentId, limit: 1 }));
            await h.run(
              service.renameSpace({
                environmentId,
                spaceId: changed.id,
                baseRevision: changed.revision,
                title: "Peer name",
                mutationId: `peer-library-${operation}`,
                receiptEpoch: admission.mutationAdmission.epoch,
              }),
            );
            if (operation === "renameSpace") await owner.renameSpace(candidate, "Attempted name");
            else await owner.setDefaultSpace(candidate, previous);
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            const request = pending.request;
            if (request.operation !== "renameSpace" && request.operation !== "setDefaultSpace")
              throw new Error("Wrong metadata operation");
            assert.equal(request.input.baseRevision, candidate.revision);
            if (request.operation === "setDefaultSpace") {
              assert.equal(request.input.baseDefaultRevision, previous.revision);
              assert.equal(request.input.defaultSpaceId, previous.id);
            }
            const catalog = await h.run(service.listSpaces({ environmentId }));
            assert.equal(catalog.defaultSpaceId, previous.id);
            assert.equal(catalog.items.find((s) => s.id === changed.id)!.title, "Peer name");
            assert.equal(h.libraryRequests.length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a definite server root-rank refusal for explicit inspection without fabricating a receipt or renumbering peers",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* rootReorderFixture(service);
          const sql = new NodeSqlite.DatabaseSync(databasePath);
          try {
            sql
              .prepare("UPDATE spaces_pages SET root_order=? WHERE page_id=?")
              .run("ffffffffffffffffffffffffffffffff", h.pages.at(-1)!);
          } finally {
            sql.close();
          }
          yield* Effect.promise(async () => {
            const owner = h.make(),
              selected = await h.ports.getPage(h.key);
            await owner.createRootPage(selected.space, "No rank available");
            const pending = owner.getSnapshot().journal.pending!;
            assert.isTrue(pending.conflict);
            assert.equal(pending.rejection, "invalid_order");
            assert.equal(h.libraryRequests.length, 1);
            assert.deepEqual(await h.order(), h.pages);
            const lookup = await h.run(service.lookupMutationReceipt({ request: pending.request }));
            assert.equal(lookup.status, "absent");
            await expect(owner.recover()).rejects.toThrow("No uncertain");
            await owner.reinspect();
            assert.isNull(owner.getSnapshot().journal.pending);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "saves current block attributes and rich links as incremental replacements with shared views and exact saved compensation",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const mention = {
            type: "page_mention",
            version: 1,
            target: { environmentId, pageId: C.SpacePageId.make("mentioned-page") },
          };
          const runs = [
            { text: "", marks: [] },
            { text: "head", marks: [{ type: "bold", version: 1 }, mention] },
          ];
          const blocks = [
            {
              ...savedParagraph("format-heading", ""),
              type: "heading",
              content: { level: 1, runs },
            },
            {
              ...savedParagraph("format-callout", "body", "80000000000000000000000000000000"),
              type: "callout",
              content: { icon: "💡", runs: [{ text: "body", marks: [] }] },
            },
            {
              ...savedParagraph("format-code", "", "c0000000000000000000000000000000"),
              type: "code",
              content: { text: "source", language: "original-language" },
            },
          ];
          const h = yield* savedUndoFixture(service, blocks);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            const at = (state: EditorState, id: string, offset = 0) => {
              let found = -1;
              state.doc.descendants((node, pos) => {
                if (node.attrs.block?.id === id) found = pos + 1 + offset;
              });
              return found;
            };
            const select = (id: string, end?: number) =>
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.create(
                    view.state.doc,
                    at(view.state, id),
                    end === undefined ? undefined : at(view.state, id, end),
                  ),
                ),
              );
            const run = (command: Command) => assert.isTrue(command(view.state, view.dispatch));
            try {
              peer.dispatch(
                peer.state.tr.setSelection(
                  TextSelection.create(peer.state.doc, at(peer.state, "format-callout", 2)),
                ),
              );
              select("format-heading");
              run(view.bridge.adapter.setHeadingLevel(3));
              const heading = { ...blocks[0]!, content: { level: 3, runs } };
              select("format-callout");
              run(view.bridge.adapter.setCalloutIcon("📌"));
              const callout = {
                ...blocks[1]!,
                content: { icon: "📌", runs: [{ text: "body", marks: [] }] },
              };
              select("format-code");
              run(view.bridge.adapter.setCodeLanguage("typescript"));
              const code = { ...blocks[2]!, content: { text: "source", language: "typescript" } };
              select("format-heading", 4);
              run(view.bridge.adapter.setLink("https://example.test/kept"));
              const linked = {
                ...heading,
                content: {
                  level: 3,
                  runs: [
                    runs[0]!,
                    {
                      text: "head",
                      marks: [
                        { type: "bold", version: 1 },
                        mention,
                        { type: "link", version: 1, href: "https://example.test/kept" },
                      ],
                    },
                  ],
                },
              };
              const expected = [linked, callout, code];
              assert.deepEqual(spaceDocumentBlocks(peer.state.doc), expected);
              assert.equal(peer.state.selection.head, at(peer.state, "format-callout", 2));
              await controller.save();
              assert.deepEqual(h.requests[0]!.mutations, [
                { kind: "replace", block: linked },
                { kind: "replace", block: callout },
                { kind: "replace", block: code },
              ]);
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 2 }))).blocks,
                expected,
              );
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 3 }))).blocks,
                blocks,
              );
              assert.deepEqual(spaceDocumentBlocks(peer.state.doc), blocks);
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 4 }))).blocks,
                expected,
              );
              select("format-heading");
              run(view.bridge.adapter.setHeadingLevel(2));
              await controller.save();
              assert.equal(h.requests.length, 4);
              assert.deepEqual(h.requests[3]!.mutations, [
                { kind: "replace", block: { ...linked, content: { ...linked.content, level: 2 } } },
              ]);
              assert.notEqual(h.requests[3]!.mutationId, h.requests[0]!.mutationId);
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps a newer heading attribute edit after the exact earlier formatting prefix is acknowledged",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const block = {
            ...savedParagraph("format-late", "title"),
            type: "heading",
            content: { level: 1, runs: [{ text: "title", marks: [] }] },
          };
          const h = yield* savedUndoFixture(service, [block]);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.setHeadingLevel(2)(view.state, view.dispatch));
              h.transport.hold = true;
              const saving = controller.save();
              await h.transport.committed.promise;
              const original = controller.session.getSnapshot().pending!;
              assert.isTrue(view.bridge.adapter.setHeadingLevel(3)(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().pending, original);
              h.transport.reply.resolve();
              await saving;
              assert.isTrue(controller.session.getSnapshot().dirty);
              assert.deepEqual(controller.session.getSnapshot().blocks, [
                { ...block, content: { ...block.content, level: 3 } },
              ]);
              await controller.save();
              assert.equal(h.requests.length, 2);
              assert.deepEqual(h.requests[0]!.mutations, [
                { kind: "replace", block: { ...block, content: { ...block.content, level: 2 } } },
              ]);
              assert.deepEqual(h.requests[1]!.mutations, [
                { kind: "replace", block: { ...block, content: { ...block.content, level: 3 } } },
              ]);
              assert.equal(h.requests[1]!.baseRevision, 2);
              assert.deepEqual(
                (await h.run(service.readBlocks({ ...h.key, revision: 3 }))).blocks,
                controller.session.getSnapshot().blocks,
              );
            } finally {
              h.transport.reply.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const decodeSourceSearch = Schema.decodeUnknownSync(C.SpaceSearchResult);
const decodeSourceResolve = Schema.decodeUnknownSync(C.SpaceReferenceResolveResult);
const sourceFixture = Effect.fn("SpaceEditorServiceTest.sources")(function* (
  service: SpacesService.SpacesService["Service"],
) {
  const h = yield* rootReorderFixture(service);
  const rpc = yield* encodedRootRpc(service);
  const q = yield* queryRuntime(h.ports, (input) => h.run(service.readBlocks(input)));
  const changeAtom = q.queries.changed(environmentId);
  const unmount = q.registry.mount(changeAtom);
  yield* Effect.addFinalizer(() => Effect.sync(unmount));
  const access: SpaceReferenceAccess = {
    session: {},
    sourceVersion: 0,
    canRead: true,
    capability: h.capability,
  };
  const control = {
    access,
    searchGate: null as (ReturnType<typeof signal> & { reply: ReturnType<typeof signal> }) | null,
    resolveGate: null as (ReturnType<typeof signal> & { reply: ReturnType<typeof signal> }) | null,
  };
  const searches: C.SpaceSearchInput[] = [],
    resolves: C.SpaceReferenceResolveInput[] = [];
  const make = () =>
    new SpaceReferenceController({
      environmentId,
      access: () => ({ ...control.access, sourceVersion: q.registry.get(changeAtom) }),
      search: async (input) => {
        searches.push(input);
        const gate = control.searchGate;
        control.searchGate = null;
        const result = decodeSourceSearch(await h.run(rpc(WS_METHODS.spacesSearch, input)));
        if (gate) {
          gate.resolve();
          await gate.reply.promise;
        }
        return result;
      },
      resolve: async (input) => {
        resolves.push(input);
        const gate = control.resolveGate;
        control.resolveGate = null;
        const result = decodeSourceResolve(
          await h.run(rpc(WS_METHODS.spacesReferencesResolve, input)),
        );
        if (gate) {
          gate.resolve();
          await gate.reply.promise;
        }
        return result;
      },
    });
  return {
    ...h,
    control,
    searches,
    resolves,
    sources: make(),
    makeSources: make,
    changed: () => q.registry.update(changeAtom, (value) => value + 1),
  };
});

it.effect(
  "opens current moved and merged search identities through the real resolver instead of stale page hints",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          const metadata = yield* service.getPage(h.key);
          const blocks = [
            savedParagraph("source-a", "SourceNeedle first", "20000000000000000000000000000000"),
            savedParagraph("source-b", "SourceNeedle second", "40000000000000000000000000000000"),
            savedParagraph("source-c", "SourceNeedle last", "80000000000000000000000000000000"),
          ];
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "source-seed",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: metadata.page.revision,
            generation: 1,
            mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("SourceNeedle")).status, "building");
            const window = await h.sources.search("SourceNeedle");
            if (window.status !== "ready") throw Error(window.status);
            const index = window.result.items.findIndex((hit) => hit.blockId === blocks[1]!.id),
              target = window.target(index)!;
            assert.equal(window.result.items[index]!.page.id, h.key.pageId);
            const owner = h.make(),
              page = await h.ports.getPage(h.key);
            const proof = await owner.selectBlocks(h.key.pageId, page.page.revision, [
              blocks[0]!.id,
              blocks[1]!.id,
            ]);
            await owner.loadBody(h.pages[1]!);
            await owner.moveSelectedBlocks(proof, {
              pageId: h.pages[1]!,
              parentId: null,
              beforeBlockId: null,
            });
            const moved = await h.sources.resolve(target);
            assert.deepEqual(moved?.current(), {
              environmentId,
              spaceId: h.spaceId,
              pageId: h.pages[1]!,
              blockId: blocks[1]!.id,
            });
            const opened = h.documents.open({ environmentId, pageId: h.pages[1]! }),
              doc = await opened.ready,
              view = savedView(doc);
            try {
              let pos = -1;
              view.state.doc.descendants((node, p) => {
                if (node.attrs.block?.id === blocks[1]!.id) pos = p + 1;
              });
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
              assert.isTrue(view.bridge.adapter.joinBackward()(view.state, view.dispatch));
              await doc.save();
              const merged = await h.sources.resolve(target);
              assert.equal(merged?.status, "merged");
              assert.deepEqual(merged?.current(), {
                environmentId,
                spaceId: h.spaceId,
                pageId: h.pages[1]!,
                blockId: blocks[0]!.id,
              });
              const now = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
              await owner.renamePage(now.page, "Current renamed destination");
              const renamed = await h.sources.resolve(target);
              assert.equal(renamed?.page.title, "Current renamed destination");
              assert.deepEqual(renamed?.current(), {
                environmentId,
                spaceId: h.spaceId,
                pageId: h.pages[1]!,
                blockId: blocks[0]!.id,
              });
              assert.isNull(moved?.current());
              h.control.access = { ...h.control.access, canRead: false };
              assert.isNull(renamed?.current());
              const reads = h.resolves.length;
              assert.isNull(await h.sources.resolve(target));
              assert.equal(h.resolves.length, reads);
            } finally {
              view.stop();
              opened.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "cancels obsolete queued search work and stale connection replies against actual encoded service reads",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("Second")).status, "building");
            const gate = { ...signal(), reply: signal() };
            h.control.searchGate = gate;
            const old = h.sources.search("Second");
            await gate.promise;
            const skipped = h.sources.search("Third"),
              latest = h.sources.search("Fourth");
            gate.reply.resolve();
            assert.equal((await old).status, "unavailable");
            assert.equal((await skipped).status, "unavailable");
            const result = await latest;
            if (result.status !== "ready") throw Error(result.status);
            assert.equal(result.result.items[0]!.page.title, "Fourth");
            assert.deepEqual(
              h.searches.map((input) => input.query),
              ["Second", "Second", "Fourth"],
            );
            const sourceTarget = result.target(0)!;
            const resolving = { ...signal(), reply: signal() };
            h.control.resolveGate = resolving;
            const pending = h.sources.resolve(sourceTarget);
            await resolving.promise;
            h.control.access = { ...h.control.access, session: {} };
            resolving.reply.resolve();
            assert.isNull(await pending);
            assert.isFalse(result.current());
            assert.isNull(result.target(0));
            assert.equal((await result.next()).status, "unavailable");
            const calls = h.searches.length;
            assert.equal((await h.sources.search("Second")).status, "unsupported");
            assert.equal(h.searches.length, calls);
            const fresh = h.makeSources();
            const again = await fresh.search("Second");
            assert.equal(again.status, "ready");
            const held = { ...signal(), reply: signal() };
            h.control.searchGate = held;
            const withdrawn = fresh.search("Fourth");
            await held.promise;
            h.control.access = {
              ...h.control.access,
              capability: { version: 2, limits: h.capability.limits },
            };
            held.reply.resolve();
            assert.equal((await withdrawn).status, "unavailable");
            const reads = h.resolves.length;
            assert.isNull(await fresh.resolve(sourceTarget));
            assert.equal(h.resolves.length, reads);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["search", "resolve"] as const)(
  "settles superseded %s reads before held transport replies with one active and one latest pending request",
  (method) =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          const deferredSignal = Effect.gen(function* () {
            const done = yield* Deferred.make<void>();
            const observed = signal();
            yield* Deferred.await(done).pipe(
              Effect.tap(() => Effect.sync(observed.resolve)),
              Effect.forkScoped,
            );
            return {
              promise: observed.promise,
              resolve: () => {
                Deferred.doneUnsafe(done, Effect.void);
              },
            };
          });
          const firstGate = { ...(yield* deferredSignal), reply: yield* deferredSignal };
          const latestGate =
            method === "resolve"
              ? { ...(yield* deferredSignal), reply: yield* deferredSignal }
              : null;
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("Second")).status, "building");
            {
              const owner = h.makeSources();
              const gate = firstGate;
              const calls = () => (method === "search" ? h.searches.length : h.resolves.length);
              const start = calls();
              const request = () =>
                method === "search"
                  ? owner.search("Second").then((result) => result.status)
                  : owner.resolve({ kind: "page", pageId: h.pages[1]! });
              if (method === "search") h.control.searchGate = gate;
              else h.control.resolveGate = gate;
              const active = request();
              await gate.promise;
              let settled = 0;
              const replaced = Array.from({ length: 10000 }, () =>
                request().then((result) => {
                  settled++;
                  assert.equal(result, method === "search" ? "unavailable" : null);
                }),
              );
              try {
                // An independent authoritative read completes while the original reply remains held.
                await h.ports.getPage(h.key);
                assert.equal(
                  settled,
                  9999,
                  `${method}: superseded callers settle before transport`,
                );
                assert.equal(calls(), start + 1);
                owner.invalidate();
                await Promise.all(replaced);
                assert.equal(settled, 10000);
                let canceled = false;
                const pending = request().then((result) => {
                  canceled = true;
                  assert.equal(result, method === "search" ? "unavailable" : null);
                });
                owner.dispose();
                await pending;
                assert.isTrue(canceled);
                assert.isFalse(owner.current());
                const after = await request();
                assert.equal(after, method === "search" ? "unsupported" : null);
                assert.equal(calls(), start + 1);
              } finally {
                owner.invalidate();
                gate.reply.resolve();
                await active;
                await Promise.all(replaced);
              }
              await h.ports.getPage(h.key);
              assert.equal(calls(), start + 1, `${method}: no late revival or queued transport`);
            }
            if (!latestGate) return;
            const owner = h.makeSources();
            const gate = latestGate;
            h.control.resolveGate = gate;
            const active = owner.resolve({ kind: "page", pageId: h.pages[1]! });
            await gate.promise;
            const obsolete = owner.resolve({ kind: "page", pageId: h.pages[2]! });
            const latest = owner.resolve({ kind: "page", pageId: h.pages[3]! });
            await h.ports.getPage(h.key);
            assert.isNull(await obsolete);
            gate.reply.resolve();
            assert.isNull(await active);
            assert.equal((await latest)?.current()?.pageId, h.pages[3]!);
            assert.deepEqual(
              h.resolves.slice(-2).map((input) => input.target),
              [
                { kind: "page", pageId: h.pages[1]! },
                { kind: "page", pageId: h.pages[3]! },
              ],
            );
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retires source ownership on actual local catalog changes without replacing a shared dirty document",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            h.control.access = {
              ...h.control.access,
              capability: {
                ...h.capability,
                limits: {
                  ...h.capability.limits,
                  search: {
                    ...h.capability.limits.search!,
                    maxRows: 1,
                  },
                },
              },
            };
            for (const [index, pageId] of h.pages.entries()) {
              const page = await h.ports.getPage({ environmentId, pageId });
              await h.make().renamePage(page.page, `Source ${index}`);
            }
            assert.equal((await h.sources.search("Source")).status, "building");
            const window = await h.sources.search("Source");
            if (window.status !== "ready") throw Error(window.status);
            assert.isNotNull(window.result.nextCursor);
            const beforeCatalog = window.result.catalogRevision;
            const target = { kind: "page" as const, pageId: h.pages[1]! };
            const resolved = await h.sources.resolve(target);
            assert.isNotNull(resolved?.current());
            const acquired = h.documents.open(h.key);
            const doc = await acquired.ready;
            const view = savedView(doc);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.dispatch(view.state.tr.insertText("unsaved local content"));
              const draft = doc.session.getSnapshot();
              const searchGate = { ...signal(), reply: signal() };
              const resolveGate = { ...signal(), reply: signal() };
              const inFlight = h.makeSources();
              h.control.searchGate = searchGate;
              h.control.resolveGate = resolveGate;
              const oldSearch = inFlight.search("Source"),
                oldResolve = inFlight.resolve(target);
              await Promise.all([searchGate.promise, resolveGate.promise]);
              try {
                const page = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
                await h.make(h.changed).renamePage(page.page, "Source renamed current");
                assert.isFalse(window.current());
                assert.isNull(window.target(0));
                assert.isNull(resolved?.current());
                const calls = h.searches.length;
                assert.equal((await window.next()).status, "unavailable");
                assert.equal(h.searches.length, calls);
              } finally {
                searchGate.reply.resolve();
                resolveGate.reply.resolve();
              }
              assert.equal((await oldSearch).status, "unavailable");
              assert.isNull(await oldResolve);
              const fresh = h.makeSources();
              const current = await fresh.search("Renamed");
              if (current.status !== "ready") throw Error(current.status);
              assert.equal(current.result.items[0]!.page.title, "Source renamed current");
              assert.isAbove(current.result.catalogRevision, beforeCatalog);
              const peer = h.documents.open(h.key);
              try {
                assert.strictEqual(await peer.ready, doc);
                assert.strictEqual(doc.session.getSnapshot(), draft);
                assert.isTrue(draft.dirty);
              } finally {
                peer.release();
              }
            } finally {
              view.stop();
              acquired.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps user selection after a saved edit and actual rename replace the source owner for an unchanged linked target",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          const metadata = yield* service.getPage(h.key);
          const a = savedParagraph("navigation-a", "First", "20000000000000000000000000000000"),
            b = savedParagraph("navigation-b", "Second", "80000000000000000000000000000000");
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "navigation-seed",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: 0,
            generation: 1,
            mutations: [a, b].map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const acquired = h.documents.open(h.key),
              doc = await acquired.ready,
              view = savedView(doc);
            const mounted = {},
              target = { ...h.key, blockId: a.id };
            const reveal = (source: SpaceReferenceController) => {
              const result = view.bridge.revealNavigation(
                mounted,
                view.state,
                target,
                source,
                () => true,
              );
              if (result?.transaction) view.dispatch(result.transaction);
              return result;
            };
            try {
              assert.equal(reveal(h.sources)?.status, "loaded");
              assert.equal((view.state.selection as NodeSelection).node.attrs.block.id, a.id);
              let position = -1;
              view.state.doc.descendants((node, pos) => {
                if (node.attrs.block?.id === b.id) position = pos + 1;
              });
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, position)),
              );
              view.edit("local-");
              const dirty = doc.session.getSnapshot(),
                caret = view.state.selection.toJSON();
              const afterEdit = reveal(h.sources);
              assert.deepEqual(view.state.selection.toJSON(), caret);
              assert.isUndefined(afterEdit?.transaction);
              assert.strictEqual(doc.session.getSnapshot(), dirty);
              await doc.save();
              const current = await h.ports.getPage(h.key);
              await h
                .make(h.changed)
                .renamePage(current.page, "Renamed while editing the linked page");
              assert.isFalse(h.sources.current());
              const saved = doc.session.getSnapshot(),
                before = view.state;
              const afterSave = reveal(h.makeSources());
              assert.deepEqual(view.state.selection.toJSON(), caret);
              assert.isUndefined(afterSave?.transaction);
              assert.strictEqual(view.state, before);
              assert.strictEqual(doc.session.getSnapshot(), saved);
              assert.isFalse(saved.dirty);
              assert.equal(
                (await h.run(service.getPage(h.key))).page.title,
                "Renamed while editing the linked page",
              );
              const peer = h.documents.open(h.key);
              try {
                assert.strictEqual(await peer.ready, doc);
              } finally {
                peer.release();
              }
            } finally {
              view.stop();
              acquired.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps actual unloaded targets explicit and preserves a shared dirty draft until a deliberate bounded window advance",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service),
            metadata = yield* service.getPage(h.key);
          const blocks = [
            savedParagraph("reveal-a", "First", "20000000000000000000000000000000"),
            savedParagraph("reveal-b", "Target", "40000000000000000000000000000000"),
            savedParagraph("reveal-c", "Unloaded", "80000000000000000000000000000000"),
          ];
          yield* service.applyBlockBatch({
            ...h.key,
            mutationId: "reveal-seed",
            receiptEpoch: metadata.mutationAdmission.epoch,
            baseRevision: 0,
            generation: 1,
            mutations: blocks.map((block) => ({ kind: "insert" as const, block })),
          });
          yield* Effect.promise(async () => {
            const reads: C.SpaceReadBlocksInput[] = [];
            const doc = new SpaceDocumentController(
              h.key,
              {
                adapter: createSpaceServiceSessionAdapter(h.key, h.ports),
                drafts: h.drafts,
                createMutationId: () => "reveal-save",
                maxLoadedBlocks: 100,
                maxMutations: 100,
              },
              {
                getPage: () => h.ports.getPage(h.key),
                windowLimit: () => 1,
                readBlocks: (input) => {
                  reads.push(input);
                  return h.run(service.readBlocks(input));
                },
              },
            );
            await doc.open();
            const route = savedView(doc),
              panel = savedView(doc);
            try {
              route.edit("dirty-");
              const before = doc.session.getSnapshot(),
                count = reads.length;
              const missing = route.bridge.revealBlock(
                route.state,
                { ...h.key, blockId: blocks[1]!.id },
                () => true,
              );
              assert.equal(missing.status, "not-loaded");
              assert.equal(reads.length, count);
              assert.equal(doc.session.getSnapshot(), before);
              assert.throws(() => doc.next(), "Resolve the draft");
              route.bridge.setWritable(false);
              const loaded = route.bridge.revealBlock(
                route.state,
                { ...h.key, blockId: blocks[0]!.id },
                () => true,
              );
              assert.equal(loaded.status, "loaded");
              if (loaded.transaction) route.dispatch(loaded.transaction);
              assert.equal(doc.session.getSnapshot(), before);
              assert.deepEqual(spaceDocumentBlocks(panel.state.doc), before.blocks);
              route.bridge.setWritable(true);
              await doc.save();
              const afterSave = reads.length;
              await doc.next();
              assert.equal(reads.length, afterSave + 1);
              const revealed = route.bridge.revealBlock(
                route.state,
                { ...h.key, blockId: blocks[1]!.id },
                () => true,
              );
              assert.equal(revealed.status, "loaded");
              if (revealed.transaction) route.dispatch(revealed.transaction);
              assert.equal(
                (route.state.selection as NodeSelection).node.attrs.block.id,
                blocks[1]!.id,
              );
              const all = await h.run(service.readBlocks({ ...h.key, revision: 2 }));
              assert.equal(
                (all.blocks[0]!.content as { runs: { text: string }[] }).runs[0]!.text,
                "dirty-First",
              );
              assert.deepEqual(all.blocks.slice(1), blocks.slice(1));
            } finally {
              route.stop();
              panel.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "resolves actual child marker identity and its current title without editing the marker",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            const owner = h.make();
            await owner.loadBody(h.key.pageId);
            await owner.createChild("Child title", {
              pageId: h.key.pageId,
              parentId: null,
              beforeBlockId: null,
            });
            const actual = await h.ports.getPage(h.key),
              body = await h.run(service.readBlocks({ ...h.key, revision: actual.page.revision }));
            const marker = body.blocks.find((block) => block.type === "child_page")!;
            if (marker.type !== "child_page") throw Error("No actual marker");
            const childId = C.SpacePageId.make(
              String((marker.content as { pageId: string }).pageId),
            );
            const opened = h.documents.open(h.key),
              doc = await opened.ready,
              view = savedView(doc);
            try {
              const before = doc.session.getSnapshot();
              assert.equal(view.bridge.childPageTarget(marker.id), childId);
              const target = { kind: "page" as const, pageId: childId };
              const current = await h.sources.resolve(target);
              assert.equal(current?.page.title, "Child title");
              const child = await h.ports.getPage({ environmentId, pageId: childId });
              await owner.renamePage(child.page, "Renamed child");
              const renamed = await h.sources.resolve(target);
              assert.equal(renamed?.page.title, "Renamed child");
              assert.equal(renamed?.current()?.pageId, childId);
              assert.equal(view.bridge.childPageTarget(marker.id), childId);
              assert.deepEqual(doc.session.getSnapshot().blocks, before.blocks);
              assert.isFalse(
                view.bridge.adapter.convert(marker.id, "paragraph")(view.state, view.dispatch),
              );
            } finally {
              view.stop();
              opened.release();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps a real empty continuing search window until explicit Next without fetching content bodies",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            assert.equal((await h.sources.search("EmptyWindowNeedle")).status, "building");
            assert.equal((await h.sources.search("EmptyWindowNeedle")).status, "ready");
            const admission = await h.ports.getPage(h.key);
            for (let offset = 0; offset < 500; offset += 100) {
              await h.run(
                service.applyBlockBatch({
                  ...h.key,
                  mutationId: C.SpaceMutationId.make(`source-hidden-${offset}`),
                  receiptEpoch: admission.mutationAdmission.epoch,
                  baseRevision: offset / 100,
                  generation: offset / 100 + 1,
                  mutations: Array.from({ length: 100 }, (_, i) => ({
                    kind: "insert" as const,
                    block: savedParagraph(
                      `source-hidden-${offset + i}`,
                      "EmptyWindowNeedle",
                      (BigInt(offset + i) + 1n).toString(16).padStart(32, "0"),
                    ),
                  })),
                }),
              );
            }
            const visible = await h.ports.getPage({ environmentId, pageId: h.pages[1]! });
            await h.run(
              service.applyBlockBatch({
                environmentId,
                pageId: visible.page.id,
                mutationId: "source-visible",
                receiptEpoch: visible.mutationAdmission.epoch,
                baseRevision: 0,
                generation: 1,
                mutations: [
                  {
                    kind: "insert",
                    block: savedParagraph("source-visible-block", "EmptyWindowNeedle"),
                  },
                ],
              }),
            );
            const owner = h.make();
            await owner.previewRecovery(h.key.pageId, "trash");
            await owner.confirmRecovery(owner.getSnapshot().recoveryPreview!);
            const before = h.searches.length,
              bodyReads = h.structureBodyReads.length;
            const first = await h.sources.search("EmptyWindowNeedle");
            if (first.status !== "ready") throw Error(first.status);
            assert.deepEqual(first.result.items, []);
            assert.isNotNull(first.result.nextCursor);
            assert.equal(h.searches.length, before + 1);
            const next = await first.next();
            if (next.status !== "ready") throw Error(next.status);
            assert.deepEqual(
              next.result.items.map((hit) => hit.blockId),
              [C.SpaceBlockId.make("source-visible-block")],
            );
            assert.isFalse(first.current());
            assert.equal(h.searches.length, before + 2);
            assert.equal(h.searches.at(-1)!.cursor, first.result.nextCursor);
            assert.equal(h.structureBodyReads.length, bodyReads);
            assert.isNull(await h.sources.resolve({ kind: "page", pageId: h.key.pageId }));
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "surfaces actual search building, unsupported and storage states and applies client query/feature limits before transport",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* sourceFixture(service);
          yield* Effect.promise(async () => {
            for (const query of ["", "word ".repeat(9), "界".repeat(100)])
              await h.sources.search(query);
            assert.equal(h.searches.length, 0);
            assert.equal((await h.sources.search("Second")).status, "building");
            assert.equal((await h.sources.search("Second")).status, "ready");
            const sql = new NodeSqlite.DatabaseSync(databasePath);
            try {
              sql
                .prepare("UPDATE spaces_search_build SET phase='unsupported' WHERE singleton=1")
                .run();
              assert.equal((await h.sources.search("Second")).status, "unsupported");
              sql
                .prepare("UPDATE spaces_search_build SET phase='invalid-phase' WHERE singleton=1")
                .run();
              assert.equal((await h.sources.search("Second")).status, "error");
            } finally {
              sql.close();
            }
            const calls = h.searches.length;
            for (const capability of [
              { version: 1, limits: h.capability.limits },
              { version: 2, limits: h.capability.limits },
              { ...h.capability, version: 3 },
            ]) {
              h.control.access = { ...h.control.access, capability };
              assert.equal((await h.sources.search("Second")).status, "unsupported");
            }
            assert.equal(h.searches.length, calls);
            h.control.access = { ...h.control.access, capability: h.capability, canRead: false };
            assert.equal((await h.sources.search("Second")).status, "unsupported");
            assert.equal(h.searches.length, calls);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "captures the actual source command session and invalidates it on transport replacement",
  () =>
    Effect.scoped(
      fixture((service) =>
        Effect.gen(function* () {
          const h = yield* boot(service),
            q = yield* queryRuntime(h.ports, (input) => h.run(service.readBlocks(input)));
          const captured = yield* Effect.promise(() =>
            q.queries.captureSession.run(q.registry, { environmentId, input: undefined }),
          );
          if (captured._tag !== "Success") throw Error("Session capture failed");
          assert.isNotNull(captured.value());
          yield* SubscriptionRef.set(q.sessions, Option.some(q.makeSession()));
          assert.isNull(captured.value());
          yield* SubscriptionRef.set(q.sessions, Option.none());
          const missing = yield* Effect.promise(() =>
            q.queries.captureSession.run(q.registry, { environmentId, input: undefined }),
          );
          if (missing._tag !== "Success") throw Error("Session capture failed");
          assert.isNull(missing.value());
          yield* SubscriptionRef.set(q.sessions, Option.some(q.makeSession()));
          const retried = yield* Effect.promise(() =>
            q.queries.captureSession.run(q.registry, { environmentId, input: undefined }),
          );
          if (retried._tag !== "Success") throw Error("Session retry failed");
          assert.isNotNull(retried.value());
          assert.isNull(missing.value());
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const decodeImageBatch = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult);
const decodeImageMetadata = Schema.decodeUnknownSync(C.SpaceAssetMetadata);
const decodeImageGrant = Schema.decodeUnknownSync(C.SpaceAssetUploadCreateResult);
const decodeImageStatus = Schema.decodeUnknownSync(C.SpaceAssetUploadStatus);
const pdfBytes = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n");
const videoBytes = new Uint8Array([
  0,
  0,
  0,
  24,
  ...new TextEncoder().encode("ftypisom"),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode("isommp42"),
  0,
  0,
  0,
  8,
  ...new TextEncoder().encode("mdat"),
]);
const imageBytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239,
  191, 151, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
const imageWorkflowFixture = Effect.fn("SpaceImageWorkflowTest.fixture")(function* (
  service: SpacesService.SpacesService["Service"],
  databasePath: string,
) {
  const h = yield* boot(service);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "editor-image-originals-" });
  const rpcA = yield* encodedRootRpc(service, "image-caller-a"),
    rpcB = yield* encodedRootRpc(service, "image-caller-b");
  const context = yield* Effect.context<
    | SpacesService.SpacesService
    | import("../../server/src/auth/ServerSecretStore.ts").ServerSecretStore
  >();
  const clock = yield* Clock.Clock;
  const http = HttpRouter.toWebHandler(
    ServerHttp.layerSpacesUploadRoute.pipe(
      Layer.provideMerge(
        Layer.mergeAll(Layer.succeedContext(context), Layer.succeed(Clock.Clock, clock)),
      ),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(http.dispose));
  const control = {
    session: {},
    caller: "a",
    read: true,
    operate: true,
    loseMint: false,
    losePost: false,
    loseFinalize: false,
    failPhase: "",
    failDraft: false,
    holdDocument: false,
    holdMetadata: false,
    metadataEntered: signal(),
    metadataReply: signal(),
    loseDocument: false,
    committed: signal(),
    documentReply: signal(),
    holdPhase: "",
    entered: signal(),
    release: signal(),
  };
  let mintCalls = 0,
    posts = 0,
    ids = 0;
  const documentRequests: C.SpaceApplyBlockBatchInput[] = [];
  const location = (slot: number) => path.join(directory, `original-${slot}`);
  async function load(): Promise<readonly SpaceImageRecord[]> {
    const records: SpaceImageRecord[] = [];
    for (const slot of [0, 1]) {
      if (!(await h.run(fs.exists(location(slot))))) continue;
      const bytes = await h.run(fs.readFile(location(slot)));
      const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Omit<
        SpaceImageRecord,
        "original"
      >;
      records.push(
        decodeSpaceImageRecord({
          ...metadata,
          original: new Blob([bytes.slice(4 + length)], { type: metadata.intent.mimeType }),
        }),
      );
    }
    return records;
  }
  const originals: SpaceImageStore = {
    load,
    put: async (input, expected) => {
      const record = decodeSpaceImageRecord(input),
        all = await load();
      const previous = all.find((r) => r.slot === record.slot);
      if (
        expected === null ? previous : previous?.id !== record.id || previous.sequence !== expected
      )
        throw new Error("Changed original");
      if (control.holdPhase === record.phase) {
        control.holdPhase = "";
        control.entered.resolve();
        await control.release.promise;
      }
      if (control.failPhase === record.phase) {
        control.failPhase = "";
        throw new Error("Original persistence failed");
      }
      const { original, ...metadata } = record;
      const json = new TextEncoder().encode(JSON.stringify(metadata)),
        blob = new Uint8Array(await original.arrayBuffer());
      const bytes = new Uint8Array(4 + json.length + blob.length);
      new DataView(bytes.buffer).setUint32(0, json.length);
      bytes.set(json, 4);
      bytes.set(blob, 4 + json.length);
      await h.run(fs.writeFile(`${location(record.slot)}.tmp`, bytes));
      await h.run(fs.rename(`${location(record.slot)}.tmp`, location(record.slot)));
    },
    remove: async (record) => {
      if (control.holdPhase === "release") {
        control.holdPhase = "";
        control.entered.resolve();
        await control.release.promise;
      }
      const previous = (await load()).find((r) => r.slot === record.slot);
      if (previous?.id !== record.id || previous.sequence !== record.sequence)
        throw new Error("Changed original");
      await h.run(fs.remove(location(record.slot)));
    },
  };
  const draftPath = path.join(directory, "page-draft.json");
  const drafts = {
    load: async (key: C.SpacePageTarget) =>
      (await h.run(fs.exists(draftPath)))
        ? decodeSpaceDocumentDraft(JSON.parse(await h.run(fs.readFileString(draftPath))), key)
        : null,
    write: async (key: C.SpacePageTarget, value: SpaceDocumentDraft | null) => {
      const decoded = value === null ? null : decodeSpaceDocumentDraft(value, key);
      if (control.failDraft && decoded?.blocks.some((b) => mediaAssetId(b)))
        throw new Error("Page draft persistence failed");
      if (decoded === null) {
        if (await h.run(fs.exists(draftPath))) await h.run(fs.remove(draftPath));
      } else {
        await h.run(fs.writeFileString(`${draftPath}.tmp`, JSON.stringify(decoded)));
        await h.run(fs.rename(`${draftPath}.tmp`, draftPath));
      }
    },
  };
  const rpc = (tag: string, input: unknown) =>
    h.run((control.caller === "a" ? rpcA : rpcB)(tag, input));
  const metadata = async (input: C.SpaceAssetGetInput) => {
    const result = decodeImageMetadata(await rpc(WS_METHODS.spacesAssetsGet, input));
    if (control.holdMetadata) {
      control.holdMetadata = false;
      control.metadataEntered.resolve();
      await control.metadataReply.promise;
    }
    return result;
  };
  const make = () =>
    new SpaceImageUploads({
      store: originals,
      draft: drafts.load,
      newId: () => `image-original-${++ids}`,
      changed: () => {},
      access: (_environmentId, write) => {
        if (!control.read || (write && !control.operate))
          throw new Error("Image permission withdrawn");
        return { session: control.session, limits: h.capability.limits.assets! };
      },
      metadata,
      mint: async (input) => {
        mintCalls++;
        const value = decodeImageGrant(await rpc(WS_METHODS.spacesAssetsUploadCreate, input));
        if (control.loseMint) {
          control.loseMint = false;
          throw new Error("Lost mint reply");
        }
        return value;
      },
      status: async (input) =>
        decodeImageStatus(await rpc(WS_METHODS.spacesAssetsUploadGet, input)),
      finalize: async (input) => {
        const result = decodeImageMetadata(await rpc(WS_METHODS.spacesAssetsUploadFinalize, input));
        if (control.loseFinalize) {
          control.loseFinalize = false;
          throw new Error("Lost finalize reply");
        }
        return result;
      },
      post: (_environmentId, relativeUrl, original) => {
        posts++;
        const abort = new AbortController();
        return {
          abort: () => abort.abort(),
          done: h.run(
            Effect.promise(async () => {
              const response = await http.handler(
                new Request(`http://images.test${relativeUrl}`, {
                  method: "POST",
                  headers: {
                    "Content-Length": String(original.size),
                    "Content-Type": original.type,
                  },
                  body: original,
                  signal: abort.signal,
                }),
              );
              if (response.status !== 204)
                throw new Error(`Image HTTP rejected: ${response.status} ${await response.text()}`);
              if (control.losePost) {
                control.losePost = false;
                throw new Error("Lost byte POST reply");
              }
            }),
          ),
        };
      },
      saved: async (key, blockId, assetId) => {
        const page = await h.ports.getPage(key);
        const window = await h.run(
          service.readBlocks({ ...key, revision: page.page.revision, limit: 100 }),
        );
        return window.blocks.some((b) => b.id === blockId && mediaAssetId(b) === assetId);
      },
    });
  let images = make();
  const createController = (windowLimit = 100) =>
    new SpaceDocumentController(
      h.key,
      {
        adapter: createSpaceServiceSessionAdapter(h.key, {
          ...h.ports,
          applyBlockBatch: async (input) => {
            documentRequests.push(input);
            const result = decodeImageBatch(await rpc(WS_METHODS.spacesBlocksApply, input));
            if (control.holdDocument) {
              control.holdDocument = false;
              control.committed.resolve();
              await control.documentReply.promise;
            }
            if (control.loseDocument) {
              control.loseDocument = false;
              throw new Error("Lost image document acknowledgement");
            }
            return result;
          },
          validateNewRequest: (request) =>
            request.mutations.some((m) => m.kind !== "delete" && mediaAssetId(m.block))
              ? images.validateNewRequest(request)
              : undefined,
        }),
        assertMutable: () => images.assertMutable(h.key),
        drafts,
        createMutationId: () => `image-document-${++ids}`,
        maxLoadedBlocks: 100,
        maxMutations: 100,
      },
      {
        beforeRead: () => images.hydrate(),
        getPage: () => h.ports.getPage(h.key),
        mediaBlocked: () => images.isBlocked(h.key),
        readBlocks: (input) => h.run(service.readBlocks(input)),
        windowLimit: () => windowLimit,
      },
    );
  return {
    ...h,
    originals,
    drafts,
    control,
    metadata,
    createController,
    databasePath,
    get images() {
      return images;
    },
    reload: () => {
      images = make();
      return images;
    },
    counts: () => ({ mintCalls, posts }),
    documentRequests,
    file: (kind: "image" | "pdf" | "video" = "image") =>
      new Blob([kind === "image" ? imageBytes : kind === "pdf" ? pdfBytes : videoBytes], {
        type: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "video/mp4",
      }),
  };
});

it.effect(
  "streams an actual image, binds one durable insertion across two PM views, saves pins and retains newer drafts before releasing its original",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            try {
              const record = await h.images.add(h.key, h.file(), "image.png");
              assert.equal(h.counts().mintCalls, 0);
              await h.images.upload(record.id);
              const ready = h.images.getSnapshot().records[0]!;
              assert.equal(ready.phase, "ready");
              assert.deepEqual(ready.ready?.imageDimensions, { width: 1, height: 1 });
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              const binding = h.images.getSnapshot().records[0]!;
              assert.equal(binding.phase, "drafted");
              assert.deepEqual(
                spaceDocumentBlocks(peer.state.doc),
                controller.session.getSnapshot().blocks,
              );
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.equal(
                controller.session.getSnapshot().blocks[0]!.id,
                binding.placement!.block.id,
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.deepEqual(h.documentRequests[0]!.mutations, [
                { kind: "insert", block: binding.placement!.block },
              ]);
              assert.deepEqual(binding.placement!.block.content, {
                assetId: ready.handle!.assetId,
              });
              assert.isFalse(
                peer.bridge.adapter.remove(binding.placement!.block.id)(peer.state, peer.dispatch),
              );
              assert.isFalse(controller.session.getSnapshot().dirty);
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.deepEqual(
                  sql
                    .prepare("SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=?")
                    .all(binding.placement!.block.id)
                    .map((r) => r.asset_id),
                  [ready.handle!.assetId],
                );
              } finally {
                sql.close();
              }
              await expect(h.images.insert(record.id, port)).rejects.toThrow("already bound");
              h.control.holdPhase = "release";
              const releasing = h.images.release(record.id, port);
              await h.control.entered.promise;
              try {
                assert.isFalse(peer.bridge.adapter.append()(peer.state, peer.dispatch));
                await expect(controller.save()).rejects.toThrow("retained image");
              } finally {
                h.control.release.resolve();
              }
              await releasing;
              assert.isTrue(peer.bridge.adapter.append()(peer.state));
              assert.equal((await h.originals.load()).length, 0);
              assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["original", "minting", "upload"] as const)(
  "persists image %s before the next network boundary and retains exact replay identity after a failed write",
  (phase) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            h.control.failPhase = phase;
            if (phase === "original") {
              await expect(h.images.add(h.key, h.file(), "image.png")).rejects.toThrow(
                "persistence failed",
              );
              assert.equal((await h.originals.load()).length, 0);
              assert.deepEqual(h.counts(), { mintCalls: 0, posts: 0 });
            } else {
              const record = await h.images.add(h.key, h.file(), "image.png");
              await expect(h.images.upload(record.id)).rejects.toThrow("persistence failed");
              assert.equal(h.counts().posts, 0);
              assert.equal(h.counts().mintCalls, phase === "minting" ? 0 : 1);
              const retained = (await h.originals.load())[0]!;
              assert.equal(retained.id, record.id);
              assert.deepEqual(new Uint8Array(await retained.original.arrayBuffer()), imageBytes);
              await h.images.upload(record.id);
              const ready = h.images.getSnapshot().records[0]!;
              assert.equal(ready.phase, "ready");
              assert.equal(ready.intent.requestId, record.id);
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare(
                      "SELECT COUNT(*) AS count FROM spaces_asset_uploads WHERE request_id=?",
                    )
                    .get(record.id)!.count,
                  1,
                );
              } finally {
                sql.close();
              }
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers lost POST replies with the same ready handle and refuses a lost mint after caller replacement/reload",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const first = await h.images.add(h.key, h.file(), "image.png");
            h.control.losePost = true;
            await expect(h.images.upload(first.id)).rejects.toThrow("Lost byte POST");
            const handle = (await h.originals.load())[0]!.handle;
            h.control.session = {};
            h.control.caller = "b";
            await h.images.upload(first.id);
            assert.deepEqual(h.images.getSnapshot().records[0]!.handle, handle);
            assert.equal(h.counts().posts, 1);
            const second = await h.images.add(h.key, h.file(), "again.png");
            h.control.loseMint = true;
            await expect(h.images.upload(second.id)).rejects.toThrow("Lost mint");
            const calls = h.counts().mintCalls;
            h.control.session = {};
            h.control.caller = "a";
            h.reload();
            await expect(h.images.upload(second.id)).rejects.toThrow("Mint outcome unresolved");
            assert.equal(h.counts().mintCalls, calls);
            assert.equal((await h.originals.load()).length, 2);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["page-draft", "binding"] as const)(
  "recovers the %s insertion crash interval from actual encoded draft/original files without duplicate image IDs",
  (failure) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            let controller = h.createController();
            await controller.open();
            let view = savedView(controller);
            try {
              const original = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(original.id);
              if (failure === "page-draft") h.control.failDraft = true;
              else h.control.failPhase = "drafted";
              await expect(
                h.images.insert(
                  original.id,
                  view.bridge.imageInsertion(() => view.state, view.dispatch),
                ),
              ).rejects.toThrow();
              const pending = (await h.originals.load())[0]!;
              assert.equal(pending.phase, "preparing");
              await expect(controller.save()).rejects.toThrow("retained image");
              view.stop();
              h.control.failDraft = false;
              h.reload();
              controller = h.createController();
              await controller.open();
              view = savedView(controller);
              await h.images.insert(
                original.id,
                view.bridge.imageInsertion(() => view.state, view.dispatch),
              );
              assert.equal(controller.session.getSnapshot().blocks.length, 1);
              assert.equal(
                controller.session.getSnapshot().blocks[0]!.id,
                pending.placement!.block.id,
              );
              await controller.save();
              const now = await h.ports.getPage(h.key);
              const blocks = (
                await h.run(service.readBlocks({ ...h.key, revision: now.page.revision }))
              ).blocks;
              assert.equal(blocks.length, 1);
              assert.equal(blocks[0]!.id, pending.placement!.block.id);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "refuses a GC-retired ready asset before a NEW page intent without silently replacing its original (already drafted: %s)",
  (alreadyDrafted) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          const record = yield* Effect.promise(async () => {
            const value = await h.images.add(h.key, h.file(), "image.png");
            await h.images.upload(value.id);
            return h.images.getSnapshot().records[0]!;
          });
          let opened: {
            controller: SpaceDocumentController;
            view: ReturnType<typeof savedView>;
          } | null = null;
          if (alreadyDrafted)
            opened = yield* Effect.promise(async () => {
              const controller = h.createController();
              await controller.open();
              const view = savedView(controller);
              await h.images.insert(
                record.id,
                view.bridge.imageInsertion(() => view.state, view.dispatch),
              );
              return { controller, view };
            });
          for (const _step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) yield* service.maintainAssets;
          const observed = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
          try {
            assert.equal(
              observed
                .prepare("SELECT unreferenced_at_ms FROM spaces_asset_blobs WHERE digest=?")
                .get(record.ready!.digest)!.unreferenced_at_ms,
              0,
            );
          } finally {
            observed.close();
          }
          yield* TestClock.adjust("24 hours");
          yield* service.maintainAssets;
          yield* Effect.promise(async () => {
            await expect(
              h.metadata({ environmentId, assetId: record.handle!.assetId }),
            ).rejects.toThrow();
            const controller = opened?.controller ?? h.createController();
            if (!opened) await controller.open();
            const view = opened?.view ?? savedView(controller);
            try {
              if (opened) {
                const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
                await expect(controller.save()).rejects.toThrow(
                  "Image is unavailable for a new save",
                );
                assert.isNull(controller.session.getSnapshot().pending);
                assert.isNull(controller.getSnapshot().error);
                assert.isNotNull(controller.getSnapshot().imageAdmissionError);
                assert.equal(h.documentRequests.length, 0);
                const bound = h.images.getSnapshot().records[0]!;
                const replacement = await h.images.newAttempt(record.id, port);
                assert.isTrue(
                  view.bridge.adapter.remove(bound.placement!.block.id)(view.state, view.dispatch),
                );
                await h.images.release(record.id, port);
                await h.images.upload(replacement.id);
                assert.notEqual(
                  h.images.getSnapshot().records[0]!.handle!.assetId,
                  record.handle!.assetId,
                );
                await h.images.insert(replacement.id, port);
                await controller.save();
                assert.equal(h.documentRequests.length, 1);
                await h.images.release(replacement.id, port);
                assert.equal((await h.originals.load()).length, 0);
                return;
              }
              await expect(
                h.images.insert(
                  record.id,
                  view.bridge.imageInsertion(() => view.state, view.dispatch),
                ),
              ).rejects.toThrow();
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              assert.isNull(controller.session.getSnapshot().pending);
              assert.equal(
                h.images.getSnapshot().records[0]!.handle!.assetId,
                record.handle!.assetId,
              );
              assert.equal(h.counts().mintCalls, 1);
              assert.equal((await h.originals.load()).length, 1);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps an uncertain image request exact through lookup and a newer local suffix, then releases only after the newer save",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("before");
              const original = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(original.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(original.id, port);
              h.control.holdDocument = true;
              h.control.loseDocument = true;
              const saving = controller.save();
              const rejected = expect(saving).rejects.toThrow("Lost image document");
              await h.control.committed.promise;
              const pending = controller.session.getSnapshot().pending!;
              const beforeUndo = view.state.doc;
              assert.isFalse(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.isTrue(view.state.doc.eq(beforeUndo));
              let position = -1;
              view.state.doc.descendants((node, pos) => {
                if (node.isTextblock && node.attrs.block?.type === "paragraph") position = pos + 1;
              });
              view.dispatch(
                view.state.tr.setSelection(TextSelection.create(view.state.doc, position)),
              );
              view.edit("newer-");
              assert.strictEqual(controller.session.getSnapshot().pending, pending);
              h.control.documentReply.resolve();
              await rejected;
              await expect(h.images.newAttempt(original.id, port)).rejects.toThrow(
                "Resolve the original",
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.isTrue(controller.session.getSnapshot().dirty);
              await expect(h.images.release(original.id, port)).rejects.toThrow(
                "newer image drafts",
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 2);
              assert.equal(h.documentRequests[0]!.mutationId, pending.mutationId);
              assert.equal(h.documentRequests[0]!.receiptEpoch, pending.receiptEpoch);
              assert.isTrue(
                h.documentRequests[1]!.mutations.every(
                  (m) => m.kind === "replace" && m.block.type === "paragraph",
                ),
              );
              const image = controller.session.getSnapshot().blocks.find((b) => imageAssetId(b))!;
              assert.isFalse(peer.bridge.adapter.remove(image.id)(peer.state, peer.dispatch));
              await h.images.release(original.id, port);
              assert.equal((await h.originals.load()).length, 0);
            } finally {
              h.control.documentReply.resolve();
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a closed-view preparing intent and only reselects a proven unused placement explicitly",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            let current = true;
            const port = view.bridge.imageInsertion(
              () => view.state,
              view.dispatch,
              () => current,
            );
            try {
              const record = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(record.id);
              h.control.holdPhase = "preparing";
              const inserting = h.images.insert(record.id, port);
              await h.control.entered.promise;
              await expect(controller.save()).rejects.toThrow("retained image insertion");
              assert.isFalse(view.bridge.adapter.append()(view.state, view.dispatch));
              assert.equal(h.documentRequests.length, 0);
              current = false;
              h.control.release.resolve();
              await expect(inserting).rejects.toThrow("no longer current");
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              await expect(h.images.reselectPlacement(record.id, port)).rejects.toThrow(
                "No current",
              );
              current = true;
              const previous = h.images.getSnapshot().records[0]!.placement!.block.id;
              await h.images.reselectPlacement(record.id, port);
              await h.images.insert(record.id, port);
              assert.notEqual(controller.session.getSnapshot().blocks[0]!.id, previous);
              assert.equal(h.counts().posts, 1);
            } finally {
              h.control.release.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "guards hidden retained originals, one active operation, local limits and destination permission without writing the backend",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const record = await h.images.add(h.key, h.file(), "image.png");
            const hidden = h.reload();
            const release = hidden.reserve(environmentId, [h.key.pageId]);
            try {
              await expect(hidden.checkPages(environmentId, [h.key.pageId])).rejects.toThrow(
                "retained image originals",
              );
              await expect(hidden.add(h.key, h.file(), "another.png")).rejects.toThrow(
                "placement is reserved",
              );
            } finally {
              release();
            }
            await hidden.add(h.key, h.file(), "second.png");
            await expect(hidden.add(h.key, h.file(), "third.png")).rejects.toThrow(
              "Two image originals",
            );
            h.control.operate = false;
            await expect(hidden.upload(record.id)).rejects.toThrow("permission withdrawn");
            h.control.operate = true;
            h.control.holdPhase = "minting";
            const upload = hidden.upload(record.id);
            await h.control.entered.promise;
            await expect(hidden.upload(record.id)).rejects.toThrow("already active");
            assert.throws(
              () => hidden.reserve(environmentId, [h.key.pageId]),
              "active image operation",
            );
            h.control.release.resolve();
            await upload;
            assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["edit", "permission", "connection"] as const)(
  "refuses stale asynchronous image admission without trapping the unsent draft (%s)",
  (change) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              const record = await h.images.add(h.key, h.file(), "image.png");
              await h.images.upload(record.id);
              await h.images.insert(
                record.id,
                view.bridge.imageInsertion(() => view.state, view.dispatch),
              );
              h.control.holdMetadata = true;
              const saving = controller.save();
              const rejected = expect(saving).rejects.toThrow();
              await h.control.metadataEntered.promise;
              if (change === "edit") {
                view.dispatch(view.state.tr.insertText("newer", 1));
              } else if (change === "permission") h.control.operate = false;
              else h.control.session = {};
              h.control.metadataReply.resolve();
              await rejected;
              assert.equal(h.documentRequests.length, 0);
              assert.isNull(controller.session.getSnapshot().pending);
              assert.isNull(controller.getSnapshot().error);
              assert.isNotNull(controller.getSnapshot().imageAdmissionError);
              h.control.operate = true;
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.equal(controller.session.getSnapshot().dirty, false);
              if (change === "edit")
                assert.include(JSON.stringify(controller.session.getSnapshot().blocks), "newer");
            } finally {
              h.control.metadataReply.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers a lost finalize reply after reload, then retains the exact image draft and original on a real revision conflict",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const record = await h.images.add(h.key, h.file(), "image.png");
            h.control.loseFinalize = true;
            await expect(h.images.upload(record.id)).rejects.toThrow("Lost finalize");
            const handle = (await h.originals.load())[0]!.handle;
            h.reload();
            await h.images.upload(record.id);
            assert.deepEqual(h.images.getSnapshot().records[0]!.handle, handle);
            assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              await h.images.insert(record.id, port);
              const attempted = controller.session.getSnapshot().blocks;
              const page = await h.ports.getPage(h.key);
              const external = await h.ports.applyBlockBatch({
                ...h.key,
                mutationId: C.SpaceMutationId.make("external-image-conflict"),
                receiptEpoch: page.mutationAdmission.epoch,
                baseRevision: page.page.revision,
                generation: 1,
                mutations: [{ kind: "insert", block: savedParagraph("external", "remote") }],
              });
              assert.equal(external.status, "saved");
              await controller.save();
              assert.equal(controller.session.getSnapshot().status, "conflict");
              assert.deepEqual(controller.session.getSnapshot().blocks, attempted);
              assert.equal(controller.session.getSnapshot().baseRevision, page.page.revision);
              assert.deepEqual((await h.originals.load())[0]!.handle, handle);
              await expect(h.images.release(record.id, port)).rejects.toThrow();
              assert.equal(h.documentRequests.length, 1);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses a real page move with a hidden durable image original before acquiring a write identity",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const pages = yield* rootReorderFixture(service);
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const record = await h.images.add(h.key, h.file(), "image.png");
            const hidden = h.reload();
            const owner = pages.make(() => {}, hidden);
            await owner.browse(pages.spaceId, h.key.pageId);
            await expect(owner.move(h.key.pageId, pages.spaceId, null)).rejects.toThrow(
              "retained image originals",
            );
            assert.equal(pages.requests.length, 0);
            assert.equal(pages.counts().admissions, 0);
            assert.deepEqual(await pages.order(), pages.pages);
            await hidden.release(record.id);
            await owner.move(h.key.pageId, pages.spaceId, null);
            assert.equal(pages.requests.length, 1);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["save-prior-text", "discard-conflict"] as const)(
  "releases a cancelled image after %s advances the authoritative page revision",
  (mode) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("prior-text");
              const record = await h.images.add(h.key, h.file(), "cancelled.png");
              await h.images.upload(record.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              const bound = h.images.getSnapshot().records[0]!;
              if (mode === "save-prior-text") {
                assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
                assert.isFalse(
                  controller.session.getSnapshot().blocks.some((b) => imageAssetId(b)),
                );
                await controller.save();
              } else {
                const page = await h.ports.getPage(h.key);
                const external = await h.ports.applyBlockBatch({
                  ...h.key,
                  mutationId: C.SpaceMutationId.make("cancel-external"),
                  receiptEpoch: page.mutationAdmission.epoch,
                  baseRevision: page.page.revision,
                  generation: 1,
                  mutations: [{ kind: "insert", block: savedParagraph("external", "remote") }],
                });
                assert.equal(external.status, "saved");
                await controller.save();
                assert.equal(controller.session.getSnapshot().status, "conflict");
                await expect(h.images.release(record.id, port)).rejects.toThrow();
                assert.equal((await h.originals.load()).length, 1);
                await controller.discard();
              }
              const state = controller.session.getSnapshot();
              assert.isFalse(state.dirty);
              assert.isNull(state.pending);
              assert.isNull(state.persistenceError);
              assert.isTrue(controller.getSnapshot().completeWindow);
              assert.isAbove(state.baseRevision!, bound.placement!.revision);
              assert.isFalse(state.blocks.some((b) => imageAssetId(b)));
              h.reload();
              if (mode === "save-prior-text") {
                const partial = h.createController(1);
                await partial.open();
                const partialView = savedView(partial);
                try {
                  assert.isFalse(partial.getSnapshot().completeWindow);
                  assert.isFalse(partial.session.getSnapshot().dirty);
                  await expect(
                    h.images.release(
                      record.id,
                      partialView.bridge.imageInsertion(
                        () => partialView.state,
                        partialView.dispatch,
                      ),
                    ),
                  ).rejects.toThrow();
                  assert.equal((await h.originals.load()).length, 1);
                } finally {
                  partialView.stop();
                }
              }
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                let current = false;
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                  () => current,
                );
                await expect(h.images.release(record.id, restoredPort)).rejects.toThrow();
                assert.equal((await h.originals.load()).length, 1);
                current = true;
                restoredView.edit("unsaved-newer-");
                assert.isTrue(restored.session.getSnapshot().dirty);
                await expect(h.images.release(record.id, restoredPort)).rejects.toThrow();
                assert.equal((await h.originals.load()).length, 1);
                await restored.discard();
                await h.images.release(record.id, restoredPort);
                assert.equal((await h.originals.load()).length, 0);
                await h.images.checkPages(environmentId, [h.key.pageId]);
                assert.equal((await h.images.add(h.key, h.file(), "next.png")).slot, record.slot);
              } finally {
                restoredView.stop();
              }
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "retains an original and exact uncertain receipt across release and reload (image cancelled: %s)",
  (cancelled) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("remaining-text");
              const record = await h.images.add(h.key, h.file(), "uncertain.png");
              await h.images.upload(record.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              if (cancelled)
                assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              h.control.loseDocument = true;
              await expect(controller.save()).rejects.toThrow("Lost image document");
              const pending = controller.session.getSnapshot().pending!;
              assert.isNotNull(pending);
              const original = (await h.originals.load())[0]!;
              await expect(h.images.release(record.id, port)).rejects.toThrow(
                "pending document receipt",
              );
              assert.strictEqual(controller.session.getSnapshot().pending, pending);
              assert.deepEqual((await h.originals.load())[0], original);
              h.reload();
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                );
                await expect(h.images.release(record.id, restoredPort)).rejects.toThrow(
                  "pending document receipt",
                );
                assert.deepEqual(restored.session.getSnapshot().pending, pending);
                assert.deepEqual((await h.originals.load())[0], original);
                assert.equal(h.documentRequests.length, 1);
                await restored.save();
                assert.isNull(restored.session.getSnapshot().pending);
                await h.images.release(record.id, restoredPort);
                assert.equal((await h.originals.load()).length, 0);
                assert.equal(h.documentRequests.length, 1);
              } finally {
                restoredView.stop();
              }
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["pdf", "video"] as const)(
  "uploads a durable %s through real HTTP, recovers finalize, inserts once with local Undo and saves current/history pins",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            let controller = h.createController();
            await controller.open();
            let view = savedView(controller);
            let peer = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("prior-text");
              const record = await h.images.add(
                h.key,
                h.file(kind),
                `document.${kind === "pdf" ? "pdf" : "mp4"}`,
              );
              assert.equal(record.version, 2);
              assert.equal(record.intent.mediaKind, kind);
              assert.equal(h.counts().mintCalls, 0);
              h.control.loseFinalize = true;
              await expect(h.images.upload(record.id)).rejects.toThrow("Lost finalize");
              const handle = (await h.originals.load())[0]!.handle;
              h.reload();
              await h.images.upload(record.id);
              assert.deepEqual(h.images.getSnapshot().records[0]!.handle, handle);
              assert.deepEqual(
                new Uint8Array(await h.images.getSnapshot().records[0]!.original.arrayBuffer()),
                kind === "pdf" ? pdfBytes : videoBytes,
              );
              assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
              let port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(record.id, port);
              const binding = h.images.getSnapshot().records[0]!;
              const block = binding.placement!.block;
              assert.equal(block.type, kind);
              assert.deepEqual(
                spaceDocumentBlocks(peer.state.doc),
                controller.session.getSnapshot().blocks,
              );
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks.length, 1);
              assert.include(view.state.doc.textContent, "prior-text");
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks[1]!.id, block.id);
              h.control.holdDocument = true;
              h.control.loseDocument = true;
              const saving = controller.save();
              const lost = expect(saving).rejects.toThrow("Lost image document");
              await h.control.committed.promise;
              const pending = controller.session.getSnapshot().pending!;
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              view.edit("next-");
              assert.strictEqual(controller.session.getSnapshot().pending, pending);
              h.control.documentReply.resolve();
              await lost;
              await controller.session.persistDraft();
              view.stop();
              peer.stop();
              h.reload();
              controller = h.createController();
              await controller.open();
              view = savedView(controller);
              peer = savedView(controller);
              port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              assert.deepEqual(controller.session.getSnapshot().pending, pending);
              await expect(h.images.release(record.id, port)).rejects.toThrow(
                "pending document receipt",
              );
              await controller.save();
              assert.equal(h.documentRequests.length, 1);
              assert.isTrue(controller.session.getSnapshot().dirty);
              assert.include(view.state.doc.textContent, "next-");
              await expect(h.images.release(record.id, port)).rejects.toThrow("newer image drafts");
              assert.isFalse(peer.bridge.adapter.remove(block.id)(peer.state, peer.dispatch));
              await controller.save();
              assert.equal(h.documentRequests.length, 2);
              assert.deepEqual(
                h.documentRequests[0]!.mutations.find(
                  (m) => m.kind === "insert" && m.block.type === kind,
                ),
                { kind: "insert", block },
              );
              assert.isTrue(
                h.documentRequests[1]!.mutations.every(
                  (m) => m.kind === "replace" && m.block.type === "paragraph",
                ),
              );
              const current = await h.ports.getPage(h.key);
              const captioned: C.SpaceBlock = {
                ...block,
                content: {
                  assetId: handle!.assetId,
                  caption: [
                    {
                      text: "retained caption",
                      marks: [
                        { type: "bold", version: 1 },
                        { type: "italic", version: 1 },
                      ],
                    },
                  ],
                },
              };
              const updated = await h.ports.applyBlockBatch({
                ...h.key,
                baseRevision: current.page.revision,
                receiptEpoch: current.mutationAdmission.epoch,
                mutationId: C.SpaceMutationId.make("caption-pin-fixture"),
                generation: 1,
                mutations: [{ kind: "replace", block: captioned }],
              });
              assert.equal(updated.status, "saved");
              await controller.refresh();
              assert.deepEqual(
                controller.session.getSnapshot().blocks.find((b) => b.id === block.id),
                captioned,
              );
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare(
                      "SELECT COUNT(*) AS n FROM spaces_block_asset_refs WHERE block_id=? AND asset_id=?",
                    )
                    .get(block.id, handle!.assetId)!.n,
                  1,
                );
                assert.isAtLeast(
                  Number(
                    sql
                      .prepare(
                        "SELECT COUNT(*) AS n FROM spaces_revision_asset_refs WHERE asset_id=?",
                      )
                      .get(handle!.assetId)!.n,
                  ),
                  1,
                );
              } finally {
                sql.close();
              }
              await h.images.release(record.id, port);
              assert.equal((await h.originals.load()).length, 0);
            } finally {
              h.control.documentReply.resolve();
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "admits two shared originals up to 75 MiB and refuses oversized/new originals without evicting or minting",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const original = await h.images.add(h.key, h.file(), "kept.png");
            for (const [mime, cap] of [
              ["application/pdf", 25],
              ["video/mp4", 50],
            ] as const) {
              await expect(
                h.images.add(
                  h.key,
                  new Blob([new Uint8Array(cap * 1024 * 1024 + 1)], { type: mime }),
                  "too-big",
                ),
              ).rejects.toThrow("byte policy");
              assert.equal((await h.originals.load())[0]!.id, original.id);
              assert.equal((await h.originals.load()).length, 1);
            }
            await h.images.release(original.id);
            const full = await h.images.add(
              h.key,
              new Blob([new Uint8Array(50 * 1024 * 1024)], { type: "video/mp4" }),
              "full.mp4",
            );
            await expect(h.images.add(h.key, full.original, "second.mp4")).rejects.toThrow(
              "75 MiB",
            );
            assert.equal((await h.originals.load()).length, 1);
            await h.images.add(
              h.key,
              new Blob([new Uint8Array(25 * 1024 * 1024)], { type: "application/pdf" }),
              "full.pdf",
            );
            const stored = await h.originals.load();
            assert.equal(stored.length, 2);
            assert.equal(
              stored.reduce((n, r) => n + r.original.size, 0),
              75 * 1024 * 1024,
            );
            await expect(h.images.add(h.key, h.file(), "third.png")).rejects.toThrow();
            assert.deepEqual(h.counts(), { mintCalls: 0, posts: 0 });
            assert.equal((await h.originals.load())[0]!.id, full.id);
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["pdf", "video"] as const)(
  "releases a cancelled %s after saving other text, without replaying its unsent insertion",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            try {
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("keep-text");
              const original = await h.images.add(h.key, h.file(kind), `cancel.${kind}`);
              await h.images.upload(original.id);
              const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
              await h.images.insert(original.id, port);
              const placementRevision = h.images.getSnapshot().records[0]!.placement!.revision;
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              await controller.save();
              assert.isTrue(
                h.documentRequests[0]!.mutations.every(
                  (m) => m.kind === "insert" && m.block.type === "paragraph",
                ),
              );
              assert.isAbove(controller.session.getSnapshot().baseRevision!, placementRevision);
              assert.isTrue(controller.getSnapshot().completeWindow);
              h.reload();
              await h.images.release(original.id, port);
              assert.equal((await h.originals.load()).length, 0);
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["pdf", "video"] as const)(
  "retains the exact %s pending intent and original when GC wins after readiness preflight",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          const controller = h.createController();
          yield* Effect.promise(() => controller.open());
          const view = savedView(controller);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              h.control.metadataReply.resolve();
              view.stop();
            }),
          );
          const original = yield* Effect.promise(async () => {
            const r = await h.images.add(h.key, h.file(kind), `retained.${kind}`);
            await h.images.upload(r.id);
            await h.images.insert(
              r.id,
              view.bridge.imageInsertion(() => view.state, view.dispatch),
            );
            return h.images.getSnapshot().records[0]!;
          });
          h.control.holdMetadata = true;
          const saving = controller.save().then(
            () => null,
            (error) => error,
          );
          yield* Effect.promise(() =>
            Promise.race([
              h.control.metadataEntered.promise,
              saving.then((error) => {
                throw error ?? new Error("Save completed before held metadata");
              }),
            ]),
          );
          for (const _step of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) yield* service.maintainAssets;
          yield* TestClock.adjust("24 hours");
          yield* service.maintainAssets;
          h.control.metadataReply.resolve();
          const error = yield* Effect.promise(() => saving);
          assert.isNotNull(error);
          const pending = controller.session.getSnapshot().pending!;
          assert.isNotNull(pending);
          yield* Effect.promise(async () => {
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            await expect(h.images.newAttempt(original.id, port)).rejects.toThrow(
              "Resolve the original",
            );
            await expect(h.images.release(original.id, port)).rejects.toThrow(
              "pending document receipt",
            );
            await controller.save();
            assert.deepEqual(controller.session.getSnapshot().pending, pending);
            assert.equal(h.documentRequests.length, 1);
            assert.equal(h.documentRequests[0]!.mutationId, pending.mutationId);
            assert.equal(h.documentRequests[0]!.receiptEpoch, pending.receiptEpoch);
            assert.deepEqual((await h.originals.load())[0]!.handle, original.handle);
            assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["image", "pdf", "video"] as const)(
  "edits rich %s captions in the shared PM/session and explicitly removes media with local history",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const original = await h.images.add(h.key, h.file(kind), `caption.${kind}`);
            await h.images.upload(original.id);
            const assetId = h.images.getSnapshot().records[0]!.handle!.assetId;
            const page = await h.ports.getPage(h.key);
            const block: C.SpaceBlock = {
              id: C.SpaceBlockId.make("caption-media"),
              parentId: null,
              order: "8".padEnd(32, "0"),
              type: kind,
              version: 1,
              content: {
                assetId,
                caption: [
                  {
                    text: "A😀B",
                    marks: [
                      { type: "bold", version: 1 },
                      { type: "italic", version: 1 },
                    ],
                  },
                  { text: " page", marks: [{ type: "page_mention", version: 1, target: h.key }] },
                ],
              },
            };
            const seed = await h.ports.applyBlockBatch({
              ...h.key,
              mutationId: C.SpaceMutationId.make("seed-caption"),
              receiptEpoch: page.mutationAdmission.epoch,
              baseRevision: page.page.revision,
              generation: 1,
              mutations: [{ kind: "insert", block }],
            });
            assert.equal(seed.status, "saved");
            await h.images.release(original.id);
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            try {
              assert.isTrue(view.state.doc.firstChild!.isTextblock);
              const before = controller.session.getSnapshot();
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 2)));
              view.bridge.setWritable(true, false);
              assert.isFalse(view.bridge.adapter.mark("bold")(view.state, view.dispatch));
              view.dispatch(view.state.tr.insertText("permission denied", 1));
              assert.strictEqual(controller.session.getSnapshot(), before);
              view.bridge.setWritable(true);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 3)));
              assert.isFalse(
                view.bridge.adapter.setLink("https://example.test")(view.state, view.dispatch),
              );
              assert.strictEqual(controller.session.getSnapshot(), before);
              const captionDoc = view.state.doc;
              view.dispatch(view.state.tr.insertText("broken", 3));
              assert.strictEqual(view.state.doc, captionDoc);
              assert.strictEqual(controller.session.getSnapshot(), before);
              assert.isFalse(view.bridge.adapter.mark("strike")(view.state, view.dispatch));
              assert.strictEqual(controller.session.getSnapshot(), before);
              assert.isFalse(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              view.edit("caption-");
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 9)));
              assert.isTrue(
                view.bridge.adapter.setLink("https://example.test")(view.state, view.dispatch),
              );
              assert.include(
                JSON.stringify(controller.session.getSnapshot().blocks[0]!.content),
                "https://example.test",
              );
              assert.isTrue(view.bridge.adapter.removeLink()(view.state, view.dispatch));
              const changed = controller.session.getSnapshot().blocks[0]!;
              assert.equal(mediaAssetId(changed), assetId);
              assert.include(JSON.stringify(changed.content), "page_mention");
              assert.include(JSON.stringify(changed.content), "italic");
              assert.deepEqual(
                spaceDocumentBlocks(peer.state.doc),
                controller.session.getSnapshot().blocks,
              );
              await controller.save();
              const savedCaption = controller.session.getSnapshot();
              view.bridge.setWritable(true, false);
              assert.isFalse(await view.bridge.compensate("undo"));
              assert.strictEqual(controller.session.getSnapshot(), savedCaption);
              view.bridge.setWritable(true);
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [block]);
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.include(view.state.doc.textContent, "caption-");
              assert.isTrue(view.bridge.adapter.removeMedia(block.id)(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks.length, 0);
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.equal(controller.session.getSnapshot().blocks[0]!.id, block.id);
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              await controller.save();
              assert.isFalse(await view.bridge.compensate("undo"));
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare("SELECT COUNT(*) AS n FROM spaces_block_asset_refs WHERE block_id=?")
                    .get(block.id)!.n,
                  0,
                );
                assert.isAtLeast(
                  Number(
                    sql
                      .prepare(
                        "SELECT COUNT(*) AS n FROM spaces_revision_asset_refs WHERE asset_id=?",
                      )
                      .get(assetId)!.n,
                  ),
                  1,
                );
              } finally {
                sql.close();
              }
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["image", "pdf", "video"] as const)(
  "replaces a committed %s through the durable original authority, preserves identity/caption and server history pins",
  (kind) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(kind), `a.${kind}`);
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
              view.edit("original caption");
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.include(
                JSON.stringify(controller.session.getSnapshot().blocks[0]!.content),
                "original caption",
              );
              view.dispatch(view.state.tr.delete(1, 1 + "original caption".length));
              assert.equal(view.state.doc.textContent, "");
              assert.equal(controller.session.getSnapshot().blocks.length, 1);
              view.edit("original caption");
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              const assetA = mediaAssetId(before)!;
              await h.images.release(a.id, port);
              const b = await h.images.addReplacement(port, before.id, h.file(kind), `b.${kind}`);
              assert.deepEqual(b.replacement!.before, before);
              await h.images.upload(b.id);
              await h.images.insert(b.id, port);
              const after = controller.session.getSnapshot().blocks[0]!;
              assert.equal(after.id, before.id);
              assert.notEqual(mediaAssetId(after), assetA);
              assert.deepEqual(spaceDocumentBlocks(peer.state.doc), [after]);
              assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().blocks, [before]);
              assert.isTrue(view.bridge.adapter.redoLocal()(view.state, view.dispatch));
              assert.deepEqual(controller.session.getSnapshot().blocks, [after]);
              await controller.save();
              const sql = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
              try {
                assert.equal(
                  sql
                    .prepare("SELECT asset_id FROM spaces_block_asset_refs WHERE block_id=?")
                    .get(before.id)!.asset_id,
                  mediaAssetId(after),
                );
                assert.isAtLeast(
                  Number(
                    sql
                      .prepare(
                        "SELECT COUNT(*) AS n FROM spaces_revision_asset_refs WHERE asset_id=?",
                      )
                      .get(assetA)!.n,
                  ),
                  1,
                );
              } finally {
                sql.close();
              }
              assert.isTrue(await view.bridge.compensate("undo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [before]);
              assert.isTrue(await view.bridge.compensate("redo"));
              assert.deepEqual(controller.session.getSnapshot().blocks, [after]);
              await h.images.release(b.id, port);
            } finally {
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["late-caption", "lost-reply-reload"] as const)(
  "retains exact replacement intent and newer captions across %s",
  (mode) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(), "before.png");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              const b = await h.images.addReplacement(port, before.id, h.file("pdf"), "after.pdf");
              await h.images.upload(b.id);
              await h.images.insert(b.id, port);
              const replacement = controller.session.getSnapshot().blocks[0]!;
              if (mode === "late-caption") {
                h.control.holdDocument = true;
                const saving = controller.save();
                try {
                  await h.control.committed.promise;
                  view.dispatch(
                    view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)),
                  );
                  view.edit("later caption");
                  const pending = controller.session.getSnapshot().pending;
                  await expect(h.images.release(b.id, port)).rejects.toThrow(
                    "pending document receipt",
                  );
                  assert.deepEqual(controller.session.getSnapshot().pending, pending);
                } finally {
                  h.control.documentReply.resolve();
                }
                await saving;
                const suffix = controller.session.getSnapshot();
                assert.isTrue(suffix.dirty);
                assert.isNull(suffix.pending);
                assert.equal(mediaAssetId(suffix.blocks[0]!), mediaAssetId(replacement));
                assert.include(JSON.stringify(suffix.blocks[0]!.content), "later caption");
                await controller.save();
                assert.equal(h.documentRequests.length, 3);
                assert.equal(h.documentRequests[2]!.mutations.length, 1);
                assert.equal(h.documentRequests[2]!.mutations[0]!.kind, "replace");
              } else {
                h.control.loseDocument = true;
                await expect(controller.save()).rejects.toThrow(
                  "Lost image document acknowledgement",
                );
                const pending = controller.session.getSnapshot().pending!;
                assert.isNotNull(pending);
                await expect(h.images.release(b.id, port)).rejects.toThrow(
                  "pending document receipt",
                );
                await expect(h.images.newAttempt(b.id, port)).rejects.toThrow(
                  "Resolve the original",
                );
                await h.images.hydrate();
                await h.reload().hydrate();
                const restored = h.createController();
                await restored.open();
                const restoredView = savedView(restored);
                try {
                  assert.deepEqual(restored.session.getSnapshot().pending, pending);
                  await restored.save();
                  assert.isNull(restored.session.getSnapshot().pending);
                  assert.deepEqual(restored.session.getSnapshot().blocks, [replacement]);
                  assert.equal(h.documentRequests.length, 2);
                  assert.deepEqual(h.documentRequests[1]!.mutations, pending.mutations);
                  assert.equal(h.documentRequests[1]!.mutationId, pending.mutationId);
                  assert.equal(h.documentRequests[1]!.receiptEpoch, pending.receiptEpoch);
                  await h.images.release(
                    b.id,
                    restoredView.bridge.imageInsertion(
                      () => restoredView.state,
                      restoredView.dispatch,
                    ),
                  );
                } finally {
                  restoredView.stop();
                }
              }
            } finally {
              h.control.documentReply.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["undo-save", "conflict-discard"] as const)(
  "releases a cancelled replacement after revision advances via %s without changing the original media",
  (mode) =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file("video"), "before.mp4");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              assert.isTrue(view.bridge.adapter.append()(view.state, view.dispatch));
              view.edit("text");
              await controller.save();
              const b = await h.images.addReplacement(port, before.id, h.file(), "after.png");
              await h.images.upload(b.id);
              await h.images.insert(b.id, port);
              if (mode === "undo-save") {
                assert.isTrue(view.bridge.adapter.undoLocal()(view.state, view.dispatch));
                assert.equal(
                  mediaAssetId(controller.session.getSnapshot().blocks[0]!),
                  mediaAssetId(before),
                );
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
                  ),
                );
                view.edit(" remains");
                await controller.save();
              } else {
                const remote = await h.ports.getPage(h.key);
                const text = controller.session.getSnapshot().blocks[1]!;
                const result = await h.ports.applyBlockBatch({
                  ...h.key,
                  mutationId: C.SpaceMutationId.make("replacement-conflict"),
                  receiptEpoch: remote.mutationAdmission.epoch,
                  baseRevision: remote.page.revision,
                  generation: 1,
                  mutations: [
                    {
                      kind: "replace",
                      block: { ...text, content: { runs: [{ text: "remote", marks: [] }] } },
                    },
                  ],
                });
                assert.equal(result.status, "saved");
                await controller.save();
                assert.equal(controller.session.getSnapshot().status, "conflict");
                await expect(h.images.release(b.id, port)).rejects.toThrow("Save or resolve");
                await controller.discard();
              }
              assert.isFalse(controller.session.getSnapshot().dirty);
              assert.deepEqual(controller.session.getSnapshot().blocks[0], before);
              await h.images.release(b.id, port);
              assert.equal((await h.originals.load()).length, 0);
              assert.deepEqual(
                (
                  await h.run(
                    service.readBlocks({
                      ...h.key,
                      revision: (await h.ports.getPage(h.key)).page.revision,
                      limit: 100,
                    }),
                  )
                ).blocks[0],
                before,
              );
            } finally {
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "fails replacement admission before network writes, retains changed targets, and reconciles a durable preparing replacement once after reload",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller),
              peer = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(), "before.png");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              h.control.failPhase = "original";
              await expect(
                h.images.addReplacement(port, before.id, h.file(), "failed.png"),
              ).rejects.toThrow("persistence failed");
              assert.deepEqual(h.counts(), { mintCalls: 1, posts: 1 });
              assert.equal((await h.originals.load()).length, 0);
              const b = await h.images.addReplacement(port, before.id, h.file(), "after.png");
              await h.images.upload(b.id);
              h.control.holdMetadata = true;
              const applying = h.images.insert(b.id, port);
              try {
                await h.control.metadataEntered.promise;
                peer.dispatch(peer.state.tr.setSelection(TextSelection.create(peer.state.doc, 1)));
                peer.edit("target changed");
              } finally {
                h.control.metadataReply.resolve();
              }
              await expect(applying).rejects.toThrow("Replacement target changed");
              assert.equal(h.images.getSnapshot().records[0]!.phase, "ready");
              assert.equal(
                mediaAssetId(controller.session.getSnapshot().blocks[0]!),
                mediaAssetId(before),
              );
              await h.images.release(b.id, port);
              const c = await h.images.addReplacement(
                port,
                before.id,
                h.file("video"),
                "after.mp4",
              );
              await h.images.upload(c.id);
              h.control.failPhase = "drafted";
              await expect(h.images.insert(c.id, port)).rejects.toThrow("persistence failed");
              const desired = controller.session.getSnapshot().blocks[0]!;
              assert.equal(desired.type, "video");
              assert.include(JSON.stringify(desired.content), "target changed");
              assert.equal(h.images.getSnapshot().records[0]!.phase, "preparing");
              await expect(controller.save()).rejects.toThrow();
              await expect(h.images.release(c.id, port)).rejects.toThrow("unresolved");
              await h.reload().hydrate();
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                );
                await h.images.insert(c.id, restoredPort);
                assert.deepEqual(restored.session.getSnapshot().blocks, [desired]);
                await restored.save();
                await h.images.release(c.id, restoredPort);
                assert.equal(h.documentRequests.length, 2);
                assert.equal(h.documentRequests[1]!.mutations.length, 1);
                assert.equal(h.documentRequests[1]!.mutations[0]!.kind, "replace");
              } finally {
                restoredView.stop();
              }
            } finally {
              h.control.metadataReply.resolve();
              view.stop();
              peer.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "cancels an unapplied preparing replacement after navigation and an authoritative revision change without releasing uncertain bindings",
  () =>
    Effect.scoped(
      fixture((service, databasePath) =>
        Effect.gen(function* () {
          const h = yield* imageWorkflowFixture(service, databasePath);
          yield* Effect.promise(async () => {
            const controller = h.createController();
            await controller.open();
            const view = savedView(controller);
            const port = view.bridge.imageInsertion(() => view.state, view.dispatch);
            try {
              const a = await h.images.add(h.key, h.file(), "before.png");
              await h.images.upload(a.id);
              await h.images.insert(a.id, port);
              await controller.save();
              const before = controller.session.getSnapshot().blocks[0]!;
              await h.images.release(a.id, port);
              const b = await h.images.addReplacement(port, before.id, h.file("pdf"), "after.pdf");
              await h.images.upload(b.id);
              let current = true;
              const departing = view.bridge.imageInsertion(
                () => view.state,
                view.dispatch,
                () => current,
              );
              h.control.holdPhase = "preparing";
              const applying = h.images.insert(b.id, departing);
              try {
                await h.control.entered.promise;
                current = false;
              } finally {
                h.control.release.resolve();
              }
              await expect(applying).rejects.toThrow("no longer current");
              assert.deepEqual(controller.session.getSnapshot().blocks, [before]);
              await expect(h.images.release(b.id, port)).rejects.toThrow("unresolved");
              const page = await h.ports.getPage(h.key);
              const remote = {
                ...before,
                content: {
                  assetId: mediaAssetId(before)!,
                  caption: [{ text: "remote caption", marks: [] }],
                },
              };
              const result = await h.ports.applyBlockBatch({
                ...h.key,
                mutationId: C.SpaceMutationId.make("replacement-navigation-remote"),
                receiptEpoch: page.mutationAdmission.epoch,
                baseRevision: page.page.revision,
                generation: 1,
                mutations: [{ kind: "replace", block: remote }],
              });
              assert.equal(result.status, "saved");
              await h.reload().hydrate();
              const restored = h.createController();
              await restored.open();
              const restoredView = savedView(restored);
              try {
                const restoredPort = restoredView.bridge.imageInsertion(
                  () => restoredView.state,
                  restoredView.dispatch,
                );
                assert.deepEqual(restored.session.getSnapshot().blocks, [remote]);
                await h.images.reselectPlacement(b.id, restoredPort);
                await h.images.release(b.id, restoredPort);
                assert.deepEqual(restored.session.getSnapshot().blocks, [remote]);
                assert.equal((await h.originals.load()).length, 0);
                assert.equal(h.documentRequests.length, 1);
              } finally {
                restoredView.stop();
              }
            } finally {
              h.control.release.resolve();
              view.stop();
            }
          });
        }),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
);
