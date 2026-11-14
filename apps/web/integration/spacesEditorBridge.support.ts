import { assert } from "@effect/vitest";
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
  decodeSpaceDocumentDraft,
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
import * as ServerConfig from "../../server/src/config.ts";
import * as ServerSecrets from "../../server/src/auth/ServerSecretStore.ts";
import * as SpacesService from "../../server/src/spaces/SpacesService.ts";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { SpaceDocumentController } from "../src/spaces/documentController.ts";
import { SpaceEditorBridge } from "../src/spaces/editorBridge.ts";

export const environmentId = EnvironmentId.make("editor-service");

export const fixture = Effect.fn("SpaceEditorServiceTest.fixture")(function* <A, E>(
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
  options?: { readonly backgroundDrain?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-editor-" });
  return yield* SpacesService.SpacesService.pipe(
    Effect.flatMap((service) => use(service, path.join(directory, "spaces.sqlite"))),
    Effect.provide(
      Layer.mergeAll(
        SpacesService.layerFromPath(path.join(directory, "spaces.sqlite"), undefined, options).pipe(
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

export const boot = Effect.fn("SpaceEditorServiceTest.boot")(function* (
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

export const queryRuntime = Effect.fn("SpaceEditorServiceTest.queryRuntime")(function* (
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
    inboundFrames: Effect.never,
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

export function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function savedParagraph(
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

export const savedUndoFixture = Effect.fn("SpaceEditorServiceTest.savedUndo")(function* (
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

export function savedView(controller: SpaceDocumentController) {
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
