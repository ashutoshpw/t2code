import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  WS_METHODS,
  WsServerRefreshProvidersRpc,
  RpcScopeAuthorization,
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

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import { WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import { canonical } from "./CorePolicy.ts";
import * as SpacesRpc from "./Rpc.ts";
import * as SpacesService from "./SpacesService.ts";

const environmentId = EnvironmentId.make("encoded-spaces");
const env = { environmentId };
const decodeCreatedSpace = Schema.decodeUnknownSync(C.SpaceCreateResult);
const decodeApplied = Schema.decodeUnknownSync(C.SpaceApplyBlockBatchResult);
const decodeLibrary = Schema.decodeUnknownSync(C.SpaceListResult);
const decodePage = Schema.decodeUnknownSync(C.SpacePageCreateResult);
const decodeWindow = Schema.decodeUnknownSync(C.SpaceReadBlocksResult);
const decodeLookup = Schema.decodeUnknownSync(C.SpaceReceiptLookupResult);
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
  const handlers = yield* SpacesRpc.handlers;
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
  use: Effect.Effect<A, E, SpacesService.SpacesService | import("effect/Scope").Scope>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-rpc-" });
  return yield* use.pipe(
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

it.layer(NodeServices.layer)("encoded Spaces RPC", (it) => {
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
