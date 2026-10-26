import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { EnvironmentId, WS_METHODS } from "@t2code/contracts";
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
} from "@t2code/client-runtime/spaces";
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

it.layer(NodeServices.layer)("Spaces editor commands with real SQLite", (it) => {
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
