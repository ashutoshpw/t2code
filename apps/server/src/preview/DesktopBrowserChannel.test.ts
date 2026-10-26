import * as NodeServices from "@effect/platform-node/NodeServices";
import { type DesktopBrowserCommand, type DesktopBrowserEvent } from "@t2code/contracts";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

const key = { threadId: "thread", tabId: "tab" };

const layer = Layer.orDie(
  DesktopBrowserChannel.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t2-desktop-channel-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

const bundledLayer = Layer.orDie(
  DesktopBrowserChannel.layer.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const services = yield* Layer.build(
            ServerConfig.layerTest(process.cwd(), { prefix: "t2-desktop-channel-bundled-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          );
          return ServerConfig.ServerConfig.of({
            ...Context.get(services, ServerConfig.ServerConfig),
            // Never opened: the channel only needs their presence to refuse remote hosts.
            desktopBrowserFd: -1,
            desktopBrowserControlFd: -1,
          });
        }),
      ),
    ),
  ),
);

interface FakeHost {
  readonly transport: DesktopBrowserChannel.DesktopBrowserTransport;
  /** Commands the channel sent to this host, in order. */
  readonly sent: Queue.Queue<DesktopBrowserCommand>;
  readonly emit: (event: DesktopBrowserEvent) => Effect.Effect<void>;
  readonly disconnect: Effect.Effect<void>;
}

const makeFakeHost = Effect.fn("test.makeFakeHost")(function* () {
  const events = yield* Queue.unbounded<DesktopBrowserEvent, Cause.Done>();
  const sent = yield* Queue.unbounded<DesktopBrowserCommand>();
  const host: FakeHost = {
    transport: {
      events: Stream.fromQueue(events),
      send: (command) => Queue.offer(sent, command).pipe(Effect.asVoid),
      close: Queue.end(events),
    },
    sent,
    emit: (event) => Queue.offer(events, event).pipe(Effect.asVoid),
    disconnect: Queue.end(events),
  };
  return host;
});

const nextCommand = (host: FakeHost) => Queue.take(host.sent);

it.effect("refuses a remote host when the server already has browser fds", () =>
  Effect.gen(function* () {
    const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
    const host = yield* makeFakeHost();
    const error = yield* Effect.scoped(channel.attachHost(host.transport)).pipe(Effect.flip);
    expect(error._tag).toBe("DesktopBrowserHostUnavailableError");
    expect(channel.available).toBe(false);
  }).pipe(Effect.provide(bundledLayer)),
);

it.effect("attaches a host, relays events, and exposes it while connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const host = yield* makeFakeHost();
      expect(channel.available).toBe(false);

      // Buffered before the host attaches, so ingestion sees it once the channel subscribes.
      yield* host.emit({ type: "attached", ...key });
      const session = yield* channel.attachHost(host.transport);
      expect(channel.available).toBe(true);
      expect(yield* channel.awaitAttached(key, "1 second")).toBe(true);
      expect(yield* channel.isAttached(key)).toBe(true);

      yield* channel.pointer(key, { phase: "click", x: 5, y: 6 });
      expect(yield* nextCommand(host)).toEqual({
        type: "pointer",
        ...key,
        phase: "click",
        x: 5,
        y: 6,
      });

      // A later attach doubles as a barrier: ingestion handles events in order.
      const barrier = { threadId: "thread", tabId: "barrier" };
      yield* host.emit({ type: "detached", ...key });
      yield* host.emit({ type: "attached", ...barrier });
      expect(yield* channel.awaitAttached(barrier, "1 second")).toBe(true);
      expect(yield* channel.isAttached(key)).toBe(false);

      yield* host.disconnect;
      yield* session.closed;
      expect(channel.available).toBe(false);
      expect(yield* channel.isAttached(key)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a replacement host closes the previous one and detaches its tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const first = yield* makeFakeHost();
      const second = yield* makeFakeHost();

      yield* first.emit({ type: "attached", ...key });
      const firstSession = yield* channel.attachHost(first.transport);
      expect(yield* channel.awaitAttached(key, "1 second")).toBe(true);

      // Replacing detaches the previous host's tabs before the new one takes over.
      const secondSession = yield* channel.attachHost(second.transport);
      expect(yield* channel.isAttached(key)).toBe(false);
      yield* firstSession.closed;
      expect(channel.available).toBe(true);

      const replacementKey = { threadId: "thread", tabId: "replacement" };
      const barrier = { threadId: "thread", tabId: "barrier" };
      yield* second.emit({ type: "attached", ...replacementKey });
      yield* second.emit({ type: "attached", ...barrier });
      expect(yield* channel.awaitAttached(barrier, "1 second")).toBe(true);
      expect(yield* channel.isAttached(replacementKey)).toBe(true);

      yield* second.disconnect;
      yield* secondSession.closed;
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("relays debugger frames between Playwright and the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
      const host = yield* makeFakeHost();
      yield* host.emit({ type: "attached", ...key });
      yield* channel.attachHost(host.transport);
      expect(yield* channel.awaitAttached(key, "1 second")).toBe(true);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const endpoint = yield* channel.endpoint(key);
          const received = Promise.withResolvers<string>();
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => new WebSocket(endpoint)),
            (socket) => Effect.sync(() => socket.close()),
          );
          socket.addEventListener("message", (event) => received.resolve(String(event.data)));

          yield* host.emit({ type: "cdp", ...key, message: '{"id":1,"result":{}}' });
          expect(yield* Effect.promise(() => received.promise)).toBe('{"id":1,"result":{}}');

          socket.send('{"id":2,"method":"Runtime.evaluate"}');
          expect(yield* nextCommand(host)).toEqual({
            type: "cdp",
            ...key,
            message: '{"id":2,"method":"Runtime.evaluate"}',
          });
        }),
      );
      // Closing the Playwright connection releases the host-side session.
      expect(yield* nextCommand(host)).toEqual({ type: "release", ...key });
    }),
  ).pipe(Effect.provide(layer)),
);
