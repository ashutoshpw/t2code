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
import * as SpacesRpc from "../../server/src/spaces/Rpc.ts";
import * as RpcAuthorization from "../../server/src/auth/RpcAuthorization.ts";
import { WS_RPC_SERVER_OPTIONS } from "../../server/src/ws.ts";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as TestClock from "effect/testing/TestClock";
import * as SpacesService from "../../server/src/spaces/SpacesService.ts";
import { EditorState, TextSelection, type Command, type Transaction } from "@tiptap/pm/state";
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
  ) => Effect.Effect<A, E, Scope.Scope>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-editor-" });
  return yield* SpacesService.SpacesService.pipe(
    Effect.flatMap((service) => use(service, path.join(directory, "spaces.sqlite"))),
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

const encodedRootRpc = Effect.fn("SpaceEditorServiceTest.encodedRootRpc")(function* (
  service: SpacesService.SpacesService["Service"],
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
  const handlers = yield* SpacesRpc.handlers.pipe(
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
    if (response._tag !== "Exit" || response.exit._tag !== "Success")
      throw new Error(JSON.stringify(response));
    return response.exit.value;
  });
});

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
    maxBytes = h.capability.limits.maxMutationBytes;
  const requests: C.SpaceMovePageInput[] = [],
    lookups: C.SpaceReceiptLookupInput[] = [];
  const disk = { fail: false, hold: false, started: signal(), release: signal() };
  const network = {
    lose: null as "before" | "after" | null,
    after: null as (() => Promise<void>) | null,
  };
  const documentReads = { failNext: false, attempted: [] as C.SpacePageId[] };
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
  const make = () =>
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
      blocks: async (input) => decodeMoveBody(await h.run(rpc(WS_METHODS.spacesBlocksRead, input))),
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
      newId: () => `placement-${++ids}`,
      reserve: (pages, restoring) => documents.reserve(environmentId, pages, restoring),
      checkDrafts: (pages) => checkSpaceStructureDrafts(drafts, environmentId, pages),
      refresh: async (pages) => {
        refreshed++;
        await documents.refreshStructure(environmentId, pages);
      },
      changed: () => {},
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
    requests,
    lookups,
    disk,
    network,
    counts: () => ({ admissions, refreshed }),
    stored: () => stored,
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
            ).rejects.toThrow("cycle");
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
