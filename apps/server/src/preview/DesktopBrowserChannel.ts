// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to browser hosts.
/** Playwright needs a CDP WebSocket, so the secret loopback endpoint relays debugger frames to whichever host is attached. */
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t2code/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

/** One NDJSON browser-host protocol, whatever carries it: bootstrap fds or a WebSocket. */
export interface DesktopBrowserTransport {
  readonly events: Stream.Stream<DesktopBrowserEventType, unknown>;
  readonly send: (command: DesktopBrowserCommandType) => Effect.Effect<void>;
  /** Signals the host that its connection is being shut down. Safe to run more than once. */
  readonly close: Effect.Effect<void>;
}

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserHostSession {
  /** Completes when the attached host went away, whether it closed or was replaced. */
  readonly closed: Effect.Effect<void>;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

/** Decodes host NDJSON frames; invalid lines are dropped so one bad frame cannot end a session. */
export const decodeEvents = (
  bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<DesktopBrowserEventType, unknown> =>
  bytes.pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
    Stream.flatMap((decoded) =>
      Option.isSome(decoded) ? Stream.make(decoded.value) : Stream.empty,
    ),
  );

export const encodeCommandLine = (command: DesktopBrowserCommandType) => encodeCommand(command);

export class DesktopBrowserHostUnavailableError extends Schema.TaggedError<DesktopBrowserHostUnavailableError>()(
  "DesktopBrowserHostUnavailableError",
  { reason: Schema.Literal("bundled-host") },
) {
  override get message(): string {
    return "This server runs inside its own desktop app, so another computer cannot host its browser.";
  }
}

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    /** True while a desktop app, local or remote, holds the browser-host connection. */
    readonly available: boolean;
    /** Subscribe before checking so concurrent attaches cannot be missed. */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly attached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
    /** Never fails. A failed write means a broken channel; the next backend starts with no turns. */
    readonly turn: (threadId: string, active: boolean) => Effect.Effect<void>;
    /**
     * Attaches a remote browser host for the scope's lifetime. A new host replaces the old
     * one, whose tabs detach; servers bundled with a desktop app refuse remote hosts.
     */
    readonly attachHost: (
      transport: DesktopBrowserTransport,
    ) => Effect.Effect<DesktopBrowserHostSession, DesktopBrowserHostUnavailableError, Scope.Scope>;
  }
>()("@t2code/cli/preview/DesktopBrowserChannel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Map<string, DesktopTabKey>();
  const inbound = new Map<string, Queue.Queue<string>>();
  let active: { readonly transport: DesktopBrowserTransport; readonly generation: number } | null =
    null;
  let generation = 0;

  const send = (message: DesktopBrowserCommandType) =>
    active === null ? Effect.void : active.transport.send(message);

  const detachAll = Effect.gen(function* () {
    const tabs = [...attachedTabs];
    attachedTabs.clear();
    yield* Effect.forEach(
      tabs,
      ([id, key]) =>
        Effect.gen(function* () {
          const queue = inbound.get(id);
          yield* queue ? Queue.shutdown(queue) : Effect.void;
          yield* PubSub.publish(changes, { key, attached: false });
        }),
      { discard: true },
    );
  });

  const handleEvent = (source: number) => (event: DesktopBrowserEventType) => {
    // Events from a replaced transport must not touch the new host's tabs.
    if (active?.generation !== source) return Effect.void;
    const key = { threadId: event.threadId, tabId: event.tabId };
    const id = keyOf(key);
    switch (event.type) {
      case "cdp": {
        const queue = inbound.get(id);
        return queue ? Queue.offer(queue, event.message).pipe(Effect.asVoid) : Effect.void;
      }
      case "attached":
        attachedTabs.set(id, key);
        return PubSub.publish(changes, { key, attached: true });
      case "detached": {
        attachedTabs.delete(id);
        const queue = inbound.get(id);
        return (queue ? Queue.shutdown(queue) : Effect.void).pipe(
          Effect.andThen(PubSub.publish(changes, { key, attached: false })),
        );
      }
    }
  };

  const releaseIfActive = (source: number) =>
    Effect.suspend(() => {
      if (active?.generation !== source) return Effect.void;
      active = null;
      return detachAll;
    });

  const register = Effect.fn("DesktopBrowserChannel.register")(function* (
    transport: DesktopBrowserTransport,
  ) {
    const previous = active;
    if (previous !== null) {
      yield* detachAll;
      active = null;
      yield* previous.transport.close.pipe(Effect.ignore);
    }
    const source = ++generation;
    const closed = yield* Deferred.make<void>();
    active = { transport, generation: source };
    yield* transport.events.pipe(
      Stream.runForEach(handleEvent(source)),
      Effect.catchCause((cause) => Effect.logWarning("desktop browser host stopped", { cause })),
      // A dead transport cannot relay frames; detach its tabs instead of leaving them hanging.
      Effect.ensuring(releaseIfActive(source)),
      Effect.ensuring(Deferred.succeed(closed, undefined)),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.andThen(releaseIfActive(source), Deferred.succeed(closed, undefined)),
    );
    return { closed: Deferred.await(closed) } satisfies DesktopBrowserHostSession;
  });

  const makeFdTransport = Effect.fn("DesktopBrowserChannel.makeFdTransport")(function* (
    input: number,
    control: number,
  ) {
    const writeLock = yield* Semaphore.make(1);
    // Use cancellable socket reads; filesystem pipe reads keep Node alive after scope shutdown.
    const readable = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeNet.Socket({ fd: input, readable: true, writable: false })),
      (stream) => Effect.sync(() => stream.destroy()),
    );
    const transport: DesktopBrowserTransport = {
      events: decodeEvents(
        NodeStream.fromReadable<Uint8Array, Error>({
          evaluate: () => readable,
          closeOnDone: true,
          onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
      ),
      send: (message) =>
        writeLock.withPermits(1)(
          encodeCommand(message).pipe(
            Effect.flatMap((line) => writeAllToFileDescriptor(control, Buffer.from(`${line}\n`))),
            Effect.catchCause((cause) =>
              Effect.logWarning("desktop browser command failed", { cause }),
            ),
          ),
        ),
      close: Effect.sync(() => readable.destroy()),
    };
    return transport;
  });

  const fds =
    inputFd !== undefined && controlFd !== undefined
      ? { input: inputFd, control: controlFd }
      : null;
  const bundledTransport =
    fds === null
      ? null
      : yield* makeFdTransport(fds.input, fds.control).pipe(
          // The server degrades to server-rendered tabs rather than failing to boot.
          Effect.catchCause((cause) =>
            Effect.logError("the desktop browser fds are unusable", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
  if (bundledTransport !== null) yield* register(bundledTransport);

  const endpoint = Effect.fn("DesktopBrowserChannel.endpoint")(function* (key: DesktopTabKey) {
    const id = keyOf(key);
    const secret = NodeCrypto.randomBytes(24).toString("base64url");
    const server = yield* NodeSocketServer.makeWebSocket({
      host: "127.0.0.1",
      port: 0,
      path: `/${secret}`,
    }).pipe(Effect.orDie);
    const queue = yield* Queue.unbounded<string>();
    inbound.set(id, queue);
    // A detach before this registration shut down no queue, so check again.
    if (!attachedTabs.has(id)) {
      inbound.delete(id);
      return yield* Effect.die("The desktop tab detached before the server connected.");
    }
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (inbound.get(id) === queue) inbound.delete(id);
        yield* Queue.shutdown(queue);
        yield* send({ type: "release", ...key });
      }),
    );
    // The relay serves one Playwright connection; a second would see the first's sessions.
    let connected = false;
    yield* server
      .run((socket) =>
        Effect.gen(function* () {
          if (connected) return;
          connected = true;
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          yield* Stream.fromQueue(queue).pipe(
            Stream.runForEach((message) => writer.write(message)),
            Effect.forkScoped,
          );
          const decoder = new TextDecoder();
          return yield* reader.pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) =>
                  send({
                    type: "cdp",
                    ...key,
                    message: typeof frame === "string" ? frame : decoder.decode(frame),
                  }),
                { discard: true },
              ),
            ),
            Effect.forever,
          );
        }).pipe(Effect.scoped, Effect.ignore),
      )
      .pipe(Effect.forkScoped);
    const address = server.address;
    if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
    return `ws://127.0.0.1:${address.port}/${secret}`;
  });

  return DesktopBrowserChannel.of({
    get available() {
      return active !== null;
    },
    awaitAttached: (key, timeout) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (attachedTabs.has(keyOf(key))) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.attached && keyOf(change.key) === keyOf(key)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      ),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    attached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: (key) => Effect.sync(() => attachedTabs.has(keyOf(key))),
    endpoint,
    pointer: (key, pointer) => send({ type: "pointer", ...key, ...pointer }),
    turn: Effect.fn("DesktopBrowserChannel.turn")(function (threadId, active) {
      return send({ type: "turn", threadId, active });
    }),
    attachHost: Effect.fn("DesktopBrowserChannel.attachHost")(function* (transport) {
      if (fds !== null) {
        return yield* new DesktopBrowserHostUnavailableError({ reason: "bundled-host" });
      }
      return yield* register(transport);
    }),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);
