import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
  EnvironmentId,
} from "@t2code/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t2code/client-runtime/connection";
import { createSpacesEnvironmentAtoms } from "@t2code/client-runtime/state/spaces";
import type { WsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";
import type { RpcSession } from "../../../packages/client-runtime/src/rpc/session.ts";
import * as C from "@t2code/contracts/spaces";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";
import { sessionStates } from "./spacesDatabases.sessions.support.ts";

export { sessionStates };
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcAuthorization from "../../server/src/auth/RpcAuthorization.ts";
import * as SpacesRpc from "../../server/src/spaces/Rpc.ts";
import * as SpacesService from "../../server/src/spaces/SpacesService.ts";
import { WS_RPC_SERVER_OPTIONS } from "../../server/src/ws.ts";

import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";

export const environmentId = EnvironmentId.make("editor-service");

type Service = SpacesService.SpacesService["Service"];
type SpacesCapability = NonNullable<Effect.Success<ReturnType<Service["getCapability"]>>>;

/** What a session of the browser holds: the grants decide `permissionAtom` and the guard. */
export const sessionStateOf = (scopes: ReadonlyArray<AuthEnvironmentScope>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [...scopes],
  permissions: [...scopes],
});
export const OPERATE_SESSION = sessionStateOf([
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
]);
export const READ_ONLY_SESSION = sessionStateOf([AuthOrchestrationReadScope]);

const decoders = new Map<string, (value: unknown) => unknown>();
const decoderFor = (tag: string, schema: Schema.Decoder<unknown>) => {
  let decode = decoders.get(tag);
  if (decode === undefined) {
    decode = Schema.decodeUnknownSync(schema);
    decoders.set(tag, decode);
  }
  return decode;
};
const decodeError = Schema.decodeUnknownOption(C.SpaceServiceError);

/** A server over the real wire format (JSON frames, strict payloads, scope middleware). */
export const wireServer = Effect.fn("DatabasesIntegration.wireServer")(function* (
  service: Service,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
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
  const handlers = yield* SpacesRpc.handlers("databases-integration").pipe(
    Effect.provideService(SpacesService.SpacesService, service),
  );
  const context = yield* SpacesRpc.group.toHandlers(handlers);
  yield* RpcServer.make(SpacesRpc.group, WS_RPC_SERVER_OPTIONS).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeedContext(context),
        Layer.succeed(RpcServer.Protocol, protocol),
        RpcAuthorization.layer(scopes),
      ),
    ),
    Effect.forkScoped,
  );
  const write = yield* Deferred.await(receive);
  // Replies are matched by request id, so concurrent requests interleave as they do on a socket.
  const waiting = new Map<string, Deferred.Deferred<RpcMessage.FromServerEncoded>>();
  yield* Queue.take(responses).pipe(
    Effect.flatMap((frame) =>
      Effect.forEach(parser.decode(frame), (message) => {
        const reply = message as RpcMessage.FromServerEncoded;
        const pending = reply._tag === "Exit" ? waiting.get(String(reply.requestId)) : undefined;
        return pending === undefined ? Effect.void : Deferred.succeed(pending, reply);
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  let sequence = 0;
  return Effect.fn("DatabasesIntegration.request")(function* (tag: string, payload: unknown) {
    const id = String(++sequence);
    const reply = yield* Deferred.make<RpcMessage.FromServerEncoded>();
    waiting.set(id, reply);
    const frame = parser.encode({ _tag: "Request", id, tag, payload, headers: [] })!;
    for (const message of parser.decode(frame))
      yield* write(0, message as RpcMessage.FromClientEncoded);
    const response = yield* Deferred.await(reply);
    waiting.delete(id);
    return response;
  });
});

type WireRequest = Effect.Success<ReturnType<typeof wireServer>>;

/** Sends one request and decodes the answer as the generated RPC client would. */
export const call = (request: WireRequest, tag: string, input: unknown) =>
  Effect.gen(function* () {
    const rpc = SpacesRpc.group.requests.get(tag);
    if (rpc === undefined) return yield* Effect.die(`Unknown spaces method ${tag}`);
    const response = yield* request(tag, JSON.parse(JSON.stringify(input)));
    if (response._tag !== "Exit") return yield* Effect.die(JSON.stringify(response));
    if (response.exit._tag === "Success")
      return decoderFor(tag, rpc.successSchema as Schema.Decoder<unknown>)(response.exit.value);
    for (const cause of response.exit.cause) {
      if (cause._tag !== "Fail") continue;
      const decoded = decodeError(cause.error);
      return yield* Effect.fail(Option.isSome(decoded) ? decoded.value : cause.error);
    }
    return yield* Effect.die(JSON.stringify(response.exit));
  });

export interface DatabasesWorld {
  readonly service: Service;
  readonly capability: SpacesCapability;
  /** The structure owner of the page tree, as "Move to trash" on a row page uses it. */
  readonly structure: SpaceRootReorder;
  /** A page to put database blocks on, and the space it lives in. */
  readonly page: C.SpacePageId;
  /** Every request the app sent through the full-grant connection, in order. */
  readonly log: Array<{ readonly tag: string; readonly input: unknown }>;
  readonly spaceId: C.SpaceId;
  /** A request through a connection that only holds the read grant, straight to the server. */
  readonly readOnlyCall: (tag: string, input: unknown) => Effect.Effect<unknown, unknown>;
  /** Raw spaces RPC through the full-grant connection, for seeding what the web layer lacks. */
  readonly call: (tag: string, input: unknown) => Effect.Effect<unknown, unknown>;
}

/** Set by `withDatabasesWorld`; read by the stand-ins that module mocks install. */
export const holder: { current: DatabasesWorld | null } = { current: null };
const currentWorld = () => {
  if (holder.current === null) throw new Error("No databases world is running");
  return holder.current;
};

/** The generated RPC client the app would hold: every spaces method goes to the real server. */
const stubClient = new Proxy(
  {},
  {
    get: (_target, tag) =>
      typeof tag === "string" ? (input: unknown) => currentWorld().call(tag, input) : undefined,
  },
);

const makeSession = (): RpcSession => ({
  // The generated client is a plain method table; the proxy answers any spaces tag.
  client: stubClient as unknown as WsRpcProtocolClient,
  initialConfig: Effect.never,
  subscribeServerConfig: () => Stream.never,
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
  inboundFrames: Effect.never,
});

const supervisor = Effect.gen(function* () {
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Databases integration",
      httpBaseUrl: "https://databases.example.test",
      wsBaseUrl: "wss://databases.example.test",
    }),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(makeSession())),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
}).pipe(Effect.runSync);

type Registry = EnvironmentRegistry.EnvironmentRegistry["Service"];
const environments = EnvironmentRegistry.EnvironmentRegistry.of({
  run: ((_id: EnvironmentId, effect: Effect.Effect<unknown, unknown, unknown>) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisor,
    )) as unknown as Registry["run"],
  followStream: ((_id: EnvironmentId, stream: Stream.Stream<unknown, unknown, unknown>) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisor,
    )) as unknown as Registry["followStream"],
  stateChanges: () => SubscriptionRef.changes(supervisor.state),
} as unknown as Registry);

const capabilityOf = Atom.family((_id: EnvironmentId) =>
  Atom.make((): C.SpaceCapability | undefined => holder.current?.capability),
);

/** Replaces `apps/web/src/state/spaces`: the real client-runtime atoms over the real server. */
export const stateSpacesModule = {
  spacesEnvironment: createSpacesEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments)),
    { capabilityAtom: capabilityOf },
  ),
};

/** Replaces `apps/web/src/spaces/sessionRuntime`: trash goes through a real structure owner. */
export const sessionRuntimeModule = { spaceRootReorder: () => currentWorld().structure };
