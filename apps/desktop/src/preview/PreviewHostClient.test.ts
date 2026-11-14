// @effect-diagnostics nodeBuiltinImport:off - Stands in for a WebSocket.
import { it, expect } from "@effect/vitest";
import {
  DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE,
  DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE,
  EnvironmentId,
  type DesktopPreviewHostState,
} from "@t2code/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewHostClient from "./PreviewHostClient.ts";

const environment = EnvironmentId.make("env-1");
const lineEncoder = new TextEncoder();

interface FakeSocket {
  readonly sent: Array<string>;
  readonly openSocket: () => void;
  readonly receive: (data: string) => void;
  readonly fireClose: (code: number) => void;
  readonly firstSend: Promise<string>;
}

const makeSocket = (): FakeSocket & PreviewHostClient.PreviewHostSocket => {
  const openListeners: Array<() => void> = [];
  const messageListeners: Array<(data: string) => void> = [];
  const closeListeners: Array<(event: { readonly code: number }) => void> = [];
  const firstSend = Promise.withResolvers<string>();
  const sent: Array<string> = [];
  return {
    sent,
    firstSend: firstSend.promise,
    openSocket: () => openListeners.forEach((listener) => listener()),
    receive: (data) => messageListeners.forEach((listener) => listener(data)),
    fireClose: (code) => closeListeners.forEach((listener) => listener({ code })),
    send: (data) => {
      sent.push(data);
      if (sent.length === 1) firstSend.resolve(data);
    },
    close: () => undefined,
    onOpen: (listener) => openListeners.push(listener),
    onMessage: (listener) => messageListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
  };
};

interface Harness {
  readonly sockets: Array<FakeSocket & PreviewHostClient.PreviewHostSocket>;
  readonly eventSink: Queue.Queue<Uint8Array, Cause.Done>;
  readonly handled: PromiseWithResolvers<{
    readonly transport: string;
    readonly message: string;
  }>;
  readonly client: PreviewHostClient.PreviewHostClient["Service"];
}

const makeHarness = Effect.gen(function* () {
  const sockets: Array<FakeSocket & PreviewHostClient.PreviewHostSocket> = [];
  const eventSink = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const handled = Promise.withResolvers<{ readonly transport: string; readonly message: string }>();
  const service: DesktopBrowserHost.DesktopBrowserHost["Service"] = {
    events: Stream.empty,
    eventsFor: () => Stream.fromQueue(eventSink),
    handleCommandLine: (message, transport = "fd") =>
      Effect.sync(() => handled.resolve({ transport, message })),
    attach: () => undefined,
    detach: () => undefined,
    humanStartedDownload: () => false,
    placeDownload: () => false,
    pointers: Stream.empty,
  };
  const client = yield* PreviewHostClient.PreviewHostClient.pipe(
    Effect.provide(
      PreviewHostClient.layerWith(() => {
        const socket = makeSocket();
        sockets.push(socket);
        return socket;
      }).pipe(Layer.provide(Layer.succeed(DesktopBrowserHost.DesktopBrowserHost, service))),
    ),
  );
  return { sockets, eventSink, handled, client } satisfies Harness;
});

const withHarness = <A, E, R>(
  body: (harness: Harness) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    return yield* body(harness);
  });

const nextState = (
  client: PreviewHostClient.PreviewHostClient["Service"],
): Effect.Effect<DesktopPreviewHostState> =>
  client.states.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

const startUrl = "ws://t2.test/api/preview-stream/host";

it.effect("relays host frames to the server and server commands back", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const { client, sockets, eventSink, handled } = harness;
      yield* client.start({ environmentId: environment, url: startUrl });
      const socket = sockets[0]!;
      expect(yield* nextState(client)).toEqual({
        environmentId: environment,
        status: "connecting",
      });
      yield* Effect.sync(() => socket.openSocket());
      expect(yield* nextState(client)).toEqual({ environmentId: environment, status: "connected" });

      yield* Queue.offer(eventSink, lineEncoder.encode('{"type":"attached"}')).pipe(Effect.asVoid);
      expect(yield* Effect.promise(() => socket.firstSend)).toBe('{"type":"attached"}');

      yield* Effect.sync(() => socket.receive('{"type":"pointer"}'));
      expect(yield* Effect.promise(() => handled.promise)).toEqual({
        transport: environment,
        message: '{"type":"pointer"}',
      });
    }),
  ),
);

it.effect("steps aside when another host wins or the server has its own browser", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const { client, sockets } = harness;
      yield* client.start({ environmentId: environment, url: startUrl });
      yield* nextState(client);
      yield* Effect.sync(() => sockets[0]!.openSocket());
      yield* nextState(client);

      yield* Effect.sync(() => sockets[0]!.fireClose(DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE));
      expect(yield* nextState(client)).toEqual({
        environmentId: environment,
        status: "closed",
        reason: "replaced",
      });
      yield* TestClock.adjust("1 minute");
      expect(sockets).toHaveLength(1);

      yield* client.start({ environmentId: environment, url: startUrl });
      yield* nextState(client);
      yield* Effect.sync(() => sockets[1]!.fireClose(DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE));
      expect(yield* nextState(client)).toEqual({
        environmentId: environment,
        status: "closed",
        reason: "refused",
      });
      yield* TestClock.adjust("1 minute");
      expect(sockets).toHaveLength(2);
    }),
  ),
);

it.effect("asks for a fresh ticket instead of retrying an unauthorized connection", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const { client, sockets } = harness;
      yield* client.start({ environmentId: environment, url: startUrl });
      yield* nextState(client);
      yield* Effect.sync(() => sockets[0]!.fireClose(1008));
      expect(yield* nextState(client)).toEqual({
        environmentId: environment,
        status: "closed",
        reason: "unauthorized",
      });
      yield* TestClock.adjust("1 minute");
      expect(sockets).toHaveLength(1);
    }),
  ),
);

it.effect("reconnects on its own after a dropped connection", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const { client, sockets } = harness;
      yield* client.start({ environmentId: environment, url: startUrl });
      yield* nextState(client);
      yield* Effect.sync(() => sockets[0]!.openSocket());
      yield* nextState(client);

      yield* Effect.sync(() => sockets[0]!.fireClose(1006));
      expect(yield* nextState(client)).toEqual({
        environmentId: environment,
        status: "closed",
        reason: "disconnected",
      });
      yield* TestClock.adjust("1 seconds");
      expect(sockets).toHaveLength(2);
      expect(yield* nextState(client)).toEqual({
        environmentId: environment,
        status: "connecting",
      });
      yield* Effect.sync(() => sockets[1]!.openSocket());
      expect(yield* nextState(client)).toEqual({ environmentId: environment, status: "connected" });
    }),
  ),
);
