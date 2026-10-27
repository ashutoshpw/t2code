import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  WS_METHODS,
  WsServerRefreshProvidersRpc,
  RpcScopeAuthorization,
  SpaceContextCaptureResult,
  type AuthEnvironmentScope,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import { WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import { canonical } from "./CorePolicy.ts";
import * as SpacesRpc from "./Rpc.ts";
import * as SpacesService from "./SpacesService.ts";

const decodeCapture = Schema.decodeUnknownSync(SpaceContextCaptureResult);
const isCapture = Schema.is(SpaceContextCaptureResult);

const environmentId = EnvironmentId.make("encoded-spaces");
const env = { environmentId };
const decodeCreatedSpace = Schema.decodeUnknownSync(C.SpaceCreateResult);
const decodeApplied = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult);
const decodeLibrary = Schema.decodeUnknownSync(C.SpaceListResult);
const decodePage = Schema.decodeUnknownSync(C.SpacePageCreateResult);
const decodeWindow = Schema.decodeUnknownSync(C.SpaceReadBlocksResult);
const decodeLookup = Schema.decodeUnknownSync(C.SpaceReceiptLookupResult);
const decodeInspected = Schema.decodeUnknownSync(C.SpaceInspectStructureResult);
const decodeChild = Schema.decodeUnknownSync(C.SpaceCreateChildPageResult);
const decodeAssetCreated = Schema.decodeUnknownSync(C.SpaceAssetUploadCreateResult);
const decodeAssetStatus = Schema.decodeUnknownSync(C.SpaceAssetUploadStatus);
const decodeMoved = Schema.decodeUnknownSync(C.SpaceMovePageResult);
const decodeMovedBlocks = Schema.decodeUnknownSync(C.SpaceMoveBlocksResult);
const decodeReference = Schema.decodeUnknownSync(C.SpaceReferenceResolveResult);
const decodeRecovery = Schema.decodeUnknownSync(C.SpacePageRecoveryResult);
const decodePurged = Schema.decodeUnknownSync(C.SpacePagePurgeResult);
const decodeSearch = Schema.decodeUnknownSync(C.SpaceSearchResult);
const decodeTrash = Schema.decodeUnknownSync(C.SpaceTrashListResult);
const control = RpcGroup.make(WsServerRefreshProvidersRpc).middleware(RpcScopeAuthorization);
const group = SpacesRpc.group.merge(control);
const frameBytes = (response: unknown) => Buffer.byteLength(JSON.stringify(response), "utf8");

function savedValue(response: RpcMessage.FromServerEncoded) {
  assert.equal(response._tag, "Exit");
  if (response._tag !== "Exit") throw new Error("Expected encoded exit");
  assert.equal(response.exit._tag, "Success");
  if (response.exit._tag !== "Success") throw new Error("Expected success exit");
  return response.exit.value;
}
function expectDefect(response: RpcMessage.FromServerEncoded) {
  assert.equal(response._tag, "Exit");
  if (response._tag !== "Exit") throw new Error("Expected encoded exit");
  assert.equal(response.exit._tag, "Failure");
  assert.isBelow(frameBytes(response), 2_048);
  assert.include(JSON.stringify(response), "Invalid Spaces RPC payload.");
}

function typedFailure(response: RpcMessage.FromServerEncoded) {
  assert.equal(response._tag, "Exit");
  if (response._tag !== "Exit" || response.exit._tag !== "Failure")
    throw new Error("Expected failure exit");
  const first = response.exit.cause[0];
  assert.equal(first?._tag, "Fail");
  if (first?._tag !== "Fail") throw new Error("Expected typed failure");
  return first.error;
}

const encodedServer = Effect.fn("SpacesRpcTest.encodedServer")(function* (
  scopes: readonly AuthEnvironmentScope[] = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
  ],
) {
  const responses = yield* Queue.unbounded<string | Uint8Array>();
  const receive = yield* Deferred.make<Parameters<RpcServer.Protocol["Service"]["run"]>[0]>();
  const parser = RpcSerialization.json.makeUnsafe();
  const protocol = yield* RpcServer.Protocol.make((write) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(receive, write);
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
  const handlers = yield* SpacesRpc.handlers("rpc-client");
  const handlerContext = yield* SpacesRpc.group.toHandlers(handlers);
  const controlPayloads: unknown[] = [];
  yield* RpcServer.make(group, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeedContext(handlerContext),
        control.toLayerHandler(WS_METHODS.serverRefreshProviders, (input) =>
          Effect.sync(() => {
            controlPayloads.push(input);
            return { providers: [] };
          }),
        ),
        RpcAuthorization.layer(scopes),
        Layer.succeed(RpcServer.Protocol, protocol),
      ),
    ),
    Effect.forkScoped,
  );
  const write = yield* Deferred.await(receive);
  let nextId = 0;
  const request = Effect.fn("SpacesRpcTest.request")(function* (tag: string, payload: unknown) {
    const id = String(++nextId);
    const frame = parser.encode({ _tag: "Request", id, tag, payload, headers: [] })!;
    for (const message of parser.decode(frame)) {
      // The locally built envelope is typed by the protocol; framing deliberately returns unknown JSON.
      yield* write(0, message as RpcMessage.FromClientEncoded);
    }
    const encoded = yield* Queue.take(responses);
    return parser.decode(encoded)[0] as RpcMessage.FromServerEncoded;
  });
  return { request, controlPayloads };
});

const fixture = Effect.fn("SpacesRpcTest.fixture")(function* <A, E>(
  use: Effect.Effect<
    A,
    E,
    SpacesService.SpacesService | ServerSecretStore.ServerSecretStore | Settings.ServerSettingsService | import("effect/Scope").Scope
  >,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-rpc-" });
  return yield* use.pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerSecretStore.layer.pipe(
          Layer.provide(
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "spaces-rpc-secret-" }),
          ),
        ),
        SpacesService.layerFromPath(path.join(directory, "spaces.sqlite")).pipe(
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
          ),
          Layer.provideMerge(Settings.layerTest({ spacesEnabled: true })),
        ),
      ),
    ),
  );
});

it.layer(NodeServices.layer)("encoded Spaces RPC", (it) => {
  it.effect("captures context snapshots through an authorized strict read RPC", () =>
    fixture(
      Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        const library = yield* service.listSpaces(env);
        const created = yield* service.createPage({
          ...env,
          receiptEpoch: library.mutationAdmission.epoch,
          mutationId: "capture-page",
          title: "Capture",
          spaceId: library.defaultSpaceId,
          baseRootOrderRevision: 0,
        });
        if (created.status !== "saved") return yield* Effect.die("Expected page");
        yield* service.applyBlockBatch({
          ...env,
          receiptEpoch: library.mutationAdmission.epoch,
          mutationId: "capture-text",
          pageId: created.page.id,
          baseRevision: 0,
          generation: 0,
          mutations: [
            {
              kind: "insert",
              block: {
                id: "large-text",
                parentId: null,
                order: "00000000000000000000000000000001",
                type: "paragraph",
                version: 1,
                content: { runs: [{ text: "x".repeat(16_001), marks: [] }] },
              },
            },
          ],
        });
        const { request } = yield* encodedServer([AuthOrchestrationReadScope]);
        const input = {
          ...env,
          contextId: "ctx_capture",
          target: { kind: "page", pageId: created.page.id },
        };
        const wire = savedValue(yield* request("spaces.context.capture", input));
        const captured = decodeCapture(wire);
        if (captured.status !== "captured") return yield* Effect.die("Expected wire capture");
        assert.equal(captured.record.contextId, input.contextId);
        assert.isTrue(captured.record.snapshot.truncated);
        assert.lengthOf(captured.record.snapshot.text, 16_000);
        assert.isAtMost(frameBytes(captured.record), 65_536);
        assert.equal(captured.record.snapshot.sources[0]?.revision, 1);
        assert.isTrue(
          isCapture(
            savedValue(
              yield* request(WS_METHODS.spacesContextCapture, {
                ...input,
                contextId: "x".repeat(128),
              }),
            ),
          ),
        );
        for (const invalid of [
          { ...input, contextId: "x".repeat(129) },
          { ...input, contextId: "x".repeat(500_000) },
          { ...input, includeChildPages: "true" },
        ])
          expectDefect(yield* request(WS_METHODS.spacesContextCapture, invalid));
        assert.equal(
          (
            typedFailure(
              yield* request(WS_METHODS.spacesContextCapture, { ...input, environmentId: "other" }),
            ) as { _tag: string }
          )._tag,
          "SpaceEnvironmentMismatchError",
        );
        expectDefect(
          yield* request("spaces.context.capture", {
            ...input,
            target: { ...input.target, revision: 99 },
          }),
        );
        const denied = yield* encodedServer([AuthOrchestrationOperateScope]);
        assert.equal(
          (typedFailure(yield* denied.request("spaces.context.capture", input)) as { _tag: string })
            ._tag,
          "EnvironmentAuthorizationError",
        );
        const settings = yield* Settings.ServerSettingsService;
        yield* settings.updateSettings({ spacesEnabled: false });
        assert.equal(
          (typedFailure(yield* request(WS_METHODS.spacesContextCapture, input)) as { _tag: string })
            ._tag,
          "SpacesDisabledError",
        );
      }),
    ),
  );

  it.effect(
    "serves typed search with read scope and bounds the original search payload before decode",
    () =>
      fixture(
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          yield* service.createPage({
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "wire-search-page",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "wiresearchneedle",
          });
          const { request } = yield* encodedServer([AuthOrchestrationReadScope]);
          const pending = typedFailure(
            yield* request(WS_METHODS.spacesSearch, { ...env, query: "wiresearchneedle" }),
          );
          assert.deepEqual(pending, { _tag: "SpaceSearchUnavailableError", reason: "building" });
          const found = decodeSearch(
            savedValue(
              yield* request(WS_METHODS.spacesSearch, { ...env, query: "wiresearchneedle" }),
            ),
          );
          assert.equal(found.items[0]?.page.title, "wiresearchneedle");
          assert.isDefined(found.items[0]?.page.location);
          expectDefect(
            yield* request(WS_METHODS.spacesSearch, {
              ...env,
              query: "wiresearchneedle",
              grammar: "raw",
            }),
          );
          const base = { ...env, query: "" };
          const exact = { ...env, query: "x".repeat(1_048_576 - frameBytes(base)) };
          assert.equal(frameBytes(exact), 1_048_576);
          const large = typedFailure(yield* request(WS_METHODS.spacesSearch, exact));
          assert.equal(Reflect.get(large as object, "_tag"), "SpaceLimitExceededError");
          assert.equal(Reflect.get(large as object, "limit"), "search.maxQueryBytes");
          expectDefect(
            yield* request(WS_METHODS.spacesSearch, { ...exact, query: exact.query + "x" }),
          );
        }),
      ),
  );

  it.effect(
    "round-trips structural guards and receipt tags through original strict encoded mutation envelopes",
    () =>
      fixture(
        Effect.gen(function* () {
          const { request } = yield* encodedServer();
          const library = decodeLibrary(savedValue(yield* request(WS_METHODS.spacesList, env)));
          const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
          const root = decodePage(
            savedValue(
              yield* request(WS_METHODS.spacesPagesCreate, {
                ...common,
                mutationId: "wire-root",
                title: "Root",
                spaceId: library.defaultSpaceId,
                baseRootOrderRevision: 0,
              }),
            ),
          );
          if (root.status !== "saved") return yield* Effect.die("Expected page");
          const placement = { pageId: root.page.id, parentId: null, beforeBlockId: null };
          const inspected = decodeInspected(
            savedValue(
              yield* request(WS_METHODS.spacesStructureInspect, {
                ...env,
                target: { kind: "blocks", pageId: root.page.id, blockIds: [] },
                destination: { kind: "child", placement },
              }),
            ),
          );
          const input = {
            ...common,
            mutationId: "wire-child",
            title: "Child",
            placement,
            guards: inspected.guards,
          };
          expectDefect(
            yield* request(WS_METHODS.spacesPagesCreateChild, {
              ...input,
              placement: { ...placement, pageIdHint: "forged" },
            }),
          );
          const child = decodeChild(
            savedValue(yield* request(WS_METHODS.spacesPagesCreateChild, input)),
          );
          if (child.status !== "saved") return yield* Effect.die("Expected child");
          assert.isNull(child.page.rootOrder);
          assert.equal(child.page.location?.kind, "child");
          const second = decodePage(
            savedValue(
              yield* request(WS_METHODS.spacesPagesCreate, {
                ...common,
                mutationId: "wire-second",
                spaceId: library.defaultSpaceId,
                baseRootOrderRevision: 1,
                title: "Second",
              }),
            ),
          );
          if (second.status !== "saved") return yield* Effect.die("Expected second page");
          const blockDestination = { pageId: second.page.id, parentId: null, beforeBlockId: null };
          const blockPlan = decodeInspected(
            savedValue(
              yield* request(WS_METHODS.spacesStructureInspect, {
                ...env,
                target: { kind: "blocks", pageId: root.page.id, blockIds: [child.ownerBlockId] },
                destination: { kind: "child", placement: blockDestination },
              }),
            ),
          );
          const blockMove = {
            ...common,
            mutationId: "wire-block-move",
            sourcePageId: root.page.id,
            blockIds: [child.ownerBlockId],
            destination: blockDestination,
            guards: blockPlan.guards,
          };
          expectDefect(
            yield* request(WS_METHODS.spacesBlocksMove, {
              ...blockMove,
              destination: { ...blockDestination, pageIdHint: "forged" },
            }),
          );
          const movedBlocks = decodeMovedBlocks(
            savedValue(yield* request(WS_METHODS.spacesBlocksMove, blockMove)),
          );
          assert.equal(movedBlocks.status, "saved");
          assert.deepEqual(
            decodeMovedBlocks(savedValue(yield* request(WS_METHODS.spacesBlocksMove, blockMove))),
            movedBlocks,
          );
          assert.deepEqual(
            decodeLookup(
              savedValue(
                yield* request(WS_METHODS.spacesReceiptsGet, {
                  request: { operation: "moveBlocks", input: blockMove },
                }),
              ),
            ),
            { status: "found", receipt: { operation: "moveBlocks", result: movedBlocks } },
          );
          assert.deepEqual(
            typedFailure(
              yield* request(WS_METHODS.spacesBlocksMove, { ...blockMove, blockIds: ["changed"] }),
            ),
            { _tag: "SpaceMutationIdMismatchError", mutationId: blockMove.mutationId },
          );
          const referenceInput = {
            ...env,
            target: { kind: "block", blockId: child.ownerBlockId },
            pageIdHint: root.page.id,
          };
          expectDefect(
            yield* request(WS_METHODS.spacesReferencesResolve, {
              ...referenceInput,
              target: { ...referenceInput.target, pageId: "forged" },
            }),
          );
          const reference = decodeReference(
            savedValue(yield* request(WS_METHODS.spacesReferencesResolve, referenceInput)),
          );
          assert.equal(reference.status, "resolved");
          if (reference.status === "resolved") assert.equal(reference.page.id, second.page.id);
          const target = {
            ...env,
            target: { kind: "page", pageId: child.page.id },
            destination: { kind: "root", spaceId: library.defaultSpaceId, beforePageId: null },
          };
          const plan = decodeInspected(
            savedValue(yield* request(WS_METHODS.spacesStructureInspect, target)),
          );
          const move = {
            ...common,
            mutationId: "wire-move",
            pageId: child.page.id,
            destination: target.destination,
            guards: plan.guards,
          };
          const moved = decodeMoved(savedValue(yield* request(WS_METHODS.spacesPagesMove, move)));
          if (moved.status !== "saved") return yield* Effect.die("Expected root");
          assert.equal(moved.page.location?.kind, "root");
          assert.isNull(moved.ownerBlockId);
          assert.deepEqual(
            decodeLookup(
              savedValue(
                yield* request(WS_METHODS.spacesReceiptsGet, {
                  request: { operation: "movePage", input: move },
                }),
              ),
            ),
            { status: "found", receipt: { operation: "movePage", result: moved } },
          );
          assert.deepEqual(
            decodeMoved(savedValue(yield* request(WS_METHODS.spacesPagesMove, move))),
            moved,
          );
          assert.deepEqual(
            typedFailure(
              yield* request(WS_METHODS.spacesPagesMove, { ...move, pageId: root.page.id }),
            ),
            { _tag: "SpaceMutationIdMismatchError", mutationId: move.mutationId },
          );
          const trashPlan = decodeInspected(
            savedValue(
              yield* request(WS_METHODS.spacesStructureInspect, {
                ...env,
                target: { kind: "page", pageId: child.page.id },
                recovery: "trash",
              }),
            ),
          );
          const trash = {
            ...common,
            mutationId: "wire-trash",
            pageId: child.page.id,
            guards: trashPlan.guards,
          };
          expectDefect(
            yield* request(WS_METHODS.spacesPagesTrash, {
              ...trash,
              guards: { ...trash.guards, force: true },
            }),
          );
          const trashed = decodeRecovery(
            savedValue(yield* request(WS_METHODS.spacesPagesTrash, trash)),
          );
          assert.equal(trashed.status, "saved");
          expectDefect(
            yield* request(WS_METHODS.spacesTrashList, { ...env, spaceId: "unimplemented-filter" }),
          );
          assert.deepEqual(
            decodeTrash(savedValue(yield* request(WS_METHODS.spacesTrashList, env))).items.map(
              (row) => row.pageId,
            ),
            [child.page.id],
          );
          assert.deepEqual(
            decodeReference(
              savedValue(
                yield* request(WS_METHODS.spacesReferencesResolve, {
                  ...env,
                  target: { kind: "page", pageId: child.page.id },
                }),
              ),
            ),
            { status: "trashed", pageId: child.page.id },
          );
          const restorePlan = decodeInspected(
            savedValue(
              yield* request(WS_METHODS.spacesStructureInspect, {
                ...env,
                target: { kind: "page", pageId: child.page.id },
                recovery: "restore",
              }),
            ),
          );
          const restore = {
            ...common,
            mutationId: "wire-restore",
            pageId: child.page.id,
            guards: restorePlan.guards,
          };
          const restored = decodeRecovery(
            savedValue(yield* request(WS_METHODS.spacesPagesRestore, restore)),
          );
          assert.equal(restored.status, "saved");
          const again = decodeInspected(
            savedValue(
              yield* request(WS_METHODS.spacesStructureInspect, {
                ...env,
                target: { kind: "page", pageId: child.page.id },
                recovery: "trash",
              }),
            ),
          );
          savedValue(
            yield* request(WS_METHODS.spacesPagesTrash, {
              ...trash,
              mutationId: "wire-trash-again",
              guards: again.guards,
            }),
          );
          const purgePlan = decodeInspected(
            savedValue(
              yield* request(WS_METHODS.spacesStructureInspect, {
                ...env,
                target: { kind: "page", pageId: child.page.id },
                recovery: "permanentlyDelete",
              }),
            ),
          );
          assert.deepEqual(purgePlan.recovery, {
            operation: "permanentlyDelete",
            pageIds: [child.page.id],
          });
          const purge = {
            ...common,
            mutationId: "wire-purge",
            pageId: child.page.id,
            guards: purgePlan.guards,
          };
          const purged = decodePurged(
            savedValue(yield* request(WS_METHODS.spacesPagesPermanentlyDelete, purge)),
          );
          assert.equal(purged.status, "saved");
          assert.deepEqual(
            decodePurged(
              savedValue(yield* request(WS_METHODS.spacesPagesPermanentlyDelete, purge)),
            ),
            purged,
          );
          assert.deepEqual(
            decodeLookup(
              savedValue(
                yield* request(WS_METHODS.spacesReceiptsGet, {
                  request: { operation: "permanentlyDeletePage", input: purge },
                }),
              ),
            ),
            { status: "found", receipt: { operation: "permanentlyDeletePage", result: purged } },
          );
          assert.deepEqual(
            decodeRecovery(savedValue(yield* request(WS_METHODS.spacesPagesRestore, restore))),
            restored,
          );
          assert.deepEqual(
            decodeReference(
              savedValue(
                yield* request(WS_METHODS.spacesReferencesResolve, {
                  ...env,
                  target: { kind: "page", pageId: child.page.id },
                }),
              ),
            ),
            { status: "deleted" },
          );
        }),
      ),
  );
  it.effect.each([
    "createChildPage",
    "movePage",
    "moveBlocks",
    "trashPage",
    "restorePage",
    "permanentlyDeletePage",
  ] as const)("bounds the original %s envelope at exact1MiB and plus one", (operation) =>
    fixture(
      Effect.gen(function* () {
        const { request } = yield* encodedServer();
        const library = decodeLibrary(savedValue(yield* request(WS_METHODS.spacesList, env)));
        const common = {
          ...env,
          receiptEpoch: library.mutationAdmission.epoch,
          mutationId: "structural-ceiling",
          guards: { pages: [], roots: [] },
        };
        const recovery =
          operation === "trashPage" ||
          operation === "restorePage" ||
          operation === "permanentlyDeletePage";
        const input = recovery
          ? { ...common, pageId: "" }
          : operation === "createChildPage"
            ? {
                ...common,
                title: "",
                placement: { pageId: "page", parentId: null, beforeBlockId: null },
              }
            : operation === "movePage"
              ? {
                  ...common,
                  pageId: "page",
                  destination: { kind: "root", spaceId: "", beforePageId: null },
                }
              : {
                  ...common,
                  sourcePageId: "page",
                  blockIds: ["block"],
                  destination: { pageId: "", parentId: null, beforeBlockId: null },
                };
        const padding = 1048576 - Buffer.byteLength(canonical({ operation, input }), "utf8");
        const padded = (extra: number) =>
          recovery
            ? { ...input, pageId: "x".repeat(padding + extra) }
            : operation === "createChildPage"
              ? { ...input, title: "x".repeat(padding + extra) }
              : operation === "movePage"
                ? {
                    ...input,
                    destination: {
                      kind: "root",
                      spaceId: "x".repeat(padding + extra),
                      beforePageId: null,
                    },
                  }
                : {
                    ...input,
                    destination: {
                      pageId: "x".repeat(padding + extra),
                      parentId: null,
                      beforeBlockId: null,
                    },
                  };
        const tag =
          operation === "trashPage"
            ? WS_METHODS.spacesPagesTrash
            : operation === "restorePage"
              ? WS_METHODS.spacesPagesRestore
              : operation === "permanentlyDeletePage"
                ? WS_METHODS.spacesPagesPermanentlyDelete
                : operation === "createChildPage"
                  ? WS_METHODS.spacesPagesCreateChild
                  : operation === "movePage"
                    ? WS_METHODS.spacesPagesMove
                    : WS_METHODS.spacesBlocksMove;
        assert.deepEqual(typedFailure(yield* request(tag, padded(0))), {
          _tag: "SpaceLimitExceededError",
          limit: "maxMutationBytes",
          actual: 1048576,
          maximum: 262144,
        });
        expectDefect(yield* request(tag, padded(1)));
      }),
    ),
  );

  it.effect.each(["mutation", "lookup-wrapper", "lookup-input"] as const)(
    "rejects excess %s intent before persistence and keeps the next clean request usable",
    (kind) =>
      fixture(
        Effect.gen(function* () {
          const { request } = yield* encodedServer();
          const service = yield* SpacesService.SpacesService;
          const library = decodeLibrary(savedValue(yield* request(WS_METHODS.spacesList, env)));
          const input = {
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "extra",
            title: "Intended",
          };
          const intent = { operation: "createSpace", input };
          const response =
            kind === "mutation"
              ? yield* request(WS_METHODS.spacesCreate, { ...input, extraIntent: "must-not-strip" })
              : yield* request(
                  WS_METHODS.spacesReceiptsGet,
                  kind === "lookup-wrapper"
                    ? { request: intent, extraIntent: "must-not-strip" }
                    : {
                        request: { ...intent, input: { ...input, extraIntent: "must-not-strip" } },
                      },
                );
          expectDefect(response);
          assert.notInclude(JSON.stringify(response), "must-not-strip");
          assert.deepEqual(yield* service.lookupMutationReceipt({ request: intent }), {
            status: "absent",
          });
          const after = yield* service.listSpaces(env);
          assert.equal(after.catalogRevision, library.catalogRevision);
          assert.deepEqual(after.items, library.items);
          const clean = decodeCreatedSpace(
            savedValue(yield* request(WS_METHODS.spacesCreate, input)),
          );
          assert.deepEqual(
            decodeLookup(
              savedValue(yield* request(WS_METHODS.spacesReceiptsGet, { request: intent })),
            ),
            { status: "found", receipt: { operation: "createSpace", result: clean } },
          );
        }),
      ),
  );

  it.effect(
    "preserves canonical own opaque JSON through the encoded adapter into receipts and rejects changed reuse",
    () =>
      fixture(
        Effect.gen(function* () {
          const { request } = yield* encodedServer();
          const library = decodeLibrary(savedValue(yield* request(WS_METHODS.spacesList, env)));
          const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
          const page = decodePage(
            savedValue(
              yield* request(WS_METHODS.spacesPagesCreate, {
                ...common,
                mutationId: "page",
                spaceId: library.defaultSpaceId,
                baseRootOrderRevision: 0,
                title: "",
              }),
            ),
          );
          assert.equal(page.status, "saved");
          if (page.status !== "saved") return;
          const opaque = {
            constructor: { nested: ["界", null, false] },
            toString: "future",
            ["__proto__"]: { own: "json" },
          };
          const block = {
            ...opaque,
            id: C.SpaceBlockId.make("block"),
            parentId: null,
            order: "0".repeat(31) + "1",
            version: 1,
            type: "paragraph",
            content: {
              ...opaque,
              runs: [
                { ...opaque, text: "Preserved", marks: [{ ...opaque, type: "bold", version: 1 }] },
              ],
            },
          };
          const input = {
            ...common,
            mutationId: "opaque",
            pageId: page.page.id,
            baseRevision: 0,
            generation: 9,
            mutations: [{ kind: "insert", block }],
          };
          const saved = decodeApplied(
            savedValue(yield* request(WS_METHODS.spacesBlocksApply, input)),
          );
          const window = decodeWindow(
            savedValue(
              yield* request(WS_METHODS.spacesBlocksRead, {
                ...env,
                pageId: page.page.id,
                revision: 1,
              }),
            ),
          );
          assert.deepEqual(window.blocks, [block]);
          assert.equal(canonical(window.blocks[0]), canonical(block));
          assert.deepEqual(savedValue(yield* request(WS_METHODS.spacesBlocksApply, input)), saved);
          const found = decodeLookup(
            savedValue(
              yield* request(WS_METHODS.spacesReceiptsGet, {
                request: { operation: "applyBlockBatch", input },
              }),
            ),
          );
          assert.deepEqual(found, {
            status: "found",
            receipt: { operation: "applyBlockBatch", result: saved },
          });
          const changed = {
            ...input,
            mutations: [{ kind: "insert", block: { ...block, toString: "changed opaque intent" } }],
          };
          const mismatch = yield* request(WS_METHODS.spacesBlocksApply, changed);
          assert.deepEqual(typedFailure(mismatch), {
            _tag: "SpaceMutationIdMismatchError",
            mutationId: input.mutationId,
          });
          assert.equal(
            decodeWindow(
              savedValue(
                yield* request(WS_METHODS.spacesBlocksRead, {
                  ...env,
                  pageId: page.page.id,
                  revision: 1,
                }),
              ),
            ).revision,
            1,
          );
        }),
      ),
  );

  it.effect(
    "enforces the declared-field protocol ceiling, continues on the same protocol, and preserves unrelated Struct projection",
    () =>
      fixture(
        Effect.gen(function* () {
          const { request, controlPayloads } = yield* encodedServer();
          const service = yield* SpacesService.SpacesService;
          const library = decodeLibrary(savedValue(yield* request(WS_METHODS.spacesList, env)));
          const input = {
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "oversized",
            title: "",
          };
          const title = "x".repeat(1_048_576 - frameBytes({ operation: "createSpace", input }));
          const exact = { ...input, title };
          assert.equal(frameBytes({ operation: "createSpace", input: exact }), 1_048_576);
          assert.deepEqual(typedFailure(yield* request(WS_METHODS.spacesCreate, exact)), {
            _tag: "SpaceLimitExceededError",
            limit: "maxMutationBytes",
            actual: 1_048_576,
            maximum: 262_144,
          });
          const oversized = { ...exact, title: title + "x" };
          assert.equal(frameBytes({ operation: "createSpace", input: oversized }), 1_048_577);
          const response = yield* request(WS_METHODS.spacesCreate, oversized);
          expectDefect(response);
          if (response._tag === "Exit" && response.exit._tag === "Failure") {
            assert.equal(response.exit.cause[0]?._tag, "Die");
          }
          assert.deepEqual(
            yield* service.lookupMutationReceipt({ request: { operation: "createSpace", input } }),
            { status: "absent" },
          );
          assert.deepEqual(
            savedValue(
              yield* request(WS_METHODS.serverRefreshProviders, {
                cwd: "/control",
                unrelatedExtra: "still projected",
              }),
            ),
            { providers: [] },
          );
          assert.equal(controlPayloads.length, 1);
          assert.isFalse(Object.hasOwn(controlPayloads[0] as object, "unrelatedExtra"));
          assert.equal(Reflect.get(controlPayloads[0] as object, "cwd"), "/control");
          const after = decodeLibrary(savedValue(yield* request(WS_METHODS.spacesList, env)));
          assert.equal(after.catalogRevision, library.catalogRevision);
          assert.equal(after.items.length, 1);
        }),
      ),
  );

  it.effect(
    "allows read-only grants to list and look up receipts but denies writes before the real service",
    () =>
      fixture(
        Effect.gen(function* () {
          const { request } = yield* encodedServer([AuthOrchestrationReadScope]);
          const service = yield* SpacesService.SpacesService;
          const library = decodeLibrary(savedValue(yield* request(WS_METHODS.spacesList, env)));
          const input = {
            ...env,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "denied",
            title: "No write",
          };
          const denied = yield* request(WS_METHODS.spacesCreate, input);
          assert.include(JSON.stringify(typedFailure(denied)), "EnvironmentAuthorizationError");
          assert.include(JSON.stringify(denied), "orchestration:operate");
          assert.deepEqual(
            decodeLookup(
              savedValue(
                yield* request(WS_METHODS.spacesReceiptsGet, {
                  request: { operation: "createSpace", input },
                }),
              ),
            ),
            { status: "absent" },
          );
          assert.deepEqual((yield* service.listSpaces(env)).items, library.items);
        }),
      ),
  );
});

it.effect(
  "authorizes asset reservations before writes and rejects caller identity in the original wire envelope",
  () =>
    fixture(
      Effect.gen(function* () {
        const read = yield* encodedServer([AuthOrchestrationReadScope]);
        const input = {
          environmentId,
          requestId: "denied-reservation",
          expectedBytes: 51,
          mediaKind: "pdf",
          mimeType: "application/pdf",
          name: "report.pdf",
        };
        const denied = yield* read.request(WS_METHODS.spacesAssetsUploadCreate, input);
        assert.include(JSON.stringify(denied), "EnvironmentAuthorizationError");
        const owner = yield* encodedServer();
        expectDefect(
          yield* owner.request(WS_METHODS.spacesAssetsUploadCreate, {
            ...input,
            callerId: "forged",
          }),
        );

        const first = decodeAssetCreated(
          savedValue(
            yield* owner.request(WS_METHODS.spacesAssetsUploadCreate, {
              ...input,
              requestId: "first",
            }),
          ),
        );
        const second = decodeAssetCreated(
          savedValue(
            yield* owner.request(WS_METHODS.spacesAssetsUploadCreate, {
              ...input,
              requestId: "second",
            }),
          ),
        );
        assert.notEqual(first.uploadId, second.uploadId);
        assert.deepEqual(
          decodeAssetCreated(
            savedValue(
              yield* owner.request(WS_METHODS.spacesAssetsUploadCreate, {
                ...input,
                requestId: "first",
              }),
            ),
          ),
          first,
        );
        const status = decodeAssetStatus(
          savedValue(
            yield* read.request(WS_METHODS.spacesAssetsUploadGet, {
              environmentId,
              uploadId: first.uploadId,
            }),
          ),
        );
        assert.equal(status.state, "reserved");
        const notReady = yield* owner.request(WS_METHODS.spacesAssetsUploadFinalize, {
          environmentId,
          uploadId: first.uploadId,
        });
        assert.include(JSON.stringify(notReady), "SpaceAssetError");
        assert.include(JSON.stringify(notReady), "not_ready");
        const forbidden = yield* read.request(WS_METHODS.spacesAssetsUploadFinalize, {
          environmentId,
          uploadId: first.uploadId,
        });
        assert.include(JSON.stringify(forbidden), "EnvironmentAuthorizationError");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
