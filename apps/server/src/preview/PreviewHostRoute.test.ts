import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthPreviewOperateScope,
  AuthSessionId,
  type AuthEnvironmentScope,
  DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE,
  DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE,
} from "@t2code/contracts";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import { expect } from "vite-plus/test";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import { routeLayer } from "./PreviewHostRoute.ts";

const platformLayer = NodeHttpPlatform.layer.pipe(Layer.provideMerge(NodeServices.layer));

const channelLayer = Layer.orDie(
  DesktopBrowserChannel.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t2-preview-host-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

// A server that came up with browser fds refuses remote hosts.
const bundledChannelLayer = Layer.orDie(
  DesktopBrowserChannel.layer.pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const services = yield* Layer.build(
            ServerConfig.layerTest(process.cwd(), { prefix: "t2-preview-host-bundled-" }).pipe(
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

const makeAuth = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  error?: EnvironmentAuth.ServerAuthCredentialError,
) =>
  Layer.mock(EnvironmentAuth.EnvironmentAuth, {
    authenticateWebSocketUpgrade: () =>
      error
        ? Effect.fail(error)
        : Effect.succeed({
            sessionId: AuthSessionId.make("host-test"),
            subject: "host-test",
            method: "bearer-access-token" as const,
            scopes,
          }),
  });

interface ServerOptions {
  readonly channel: Layer.Layer<DesktopBrowserChannel.DesktopBrowserChannel>;
  readonly auth: Layer.Layer<EnvironmentAuth.EnvironmentAuth>;
}

const routes = ({ channel }: Pick<ServerOptions, "channel">) =>
  routeLayer.pipe(Layer.provideMerge(channel), Layer.provideMerge(platformLayer));

const routesWithAuth = ({ channel, auth }: ServerOptions) =>
  routes({ channel }).pipe(Layer.provideMerge(auth));

const startServer = (options: ServerOptions) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(routes(options), { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(options.auth),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    return {
      origin: HttpServer.formatAddress(server.address).replace(/^http/, "ws"),
      channel: Context.get(services, DesktopBrowserChannel.DesktopBrowserChannel),
    };
  });

const webHandler = (options: ServerOptions) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routesWithAuth(options), { disableLogger: true })),
    ({ dispose }) => Effect.promise(dispose),
  );

const RESOURCE = "/api/preview-stream/host?wsTicket=host-ticket";

const unauthenticated = (options: ServerOptions) =>
  Effect.gen(function* () {
    const handler = yield* webHandler(options);
    return yield* Effect.promise(() =>
      handler.handler(
        new Request(`http://t2.test${RESOURCE}`, { headers: { upgrade: "websocket" } }),
      ),
    );
  });

const receiveClose = (socket: WebSocket) => {
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  socket.addEventListener("close", (event) =>
    closed.resolve({ code: event.code, reason: event.reason }),
  );
  return Effect.promise(() => closed.promise);
};

const openHost = (origin: string) =>
  Effect.gen(function* () {
    const opened = Promise.withResolvers<void>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const ws = new WebSocket(`${origin}${RESOURCE}`);
        ws.addEventListener("open", () => opened.resolve());
        return ws;
      }),
      (ws) => Effect.sync(() => ws.close()),
    );
    yield* Effect.promise(() => opened.promise);
    return socket;
  });

it.effect("rejects connections without the preview operate scope", () =>
  Effect.gen(function* () {
    const response = yield* unauthenticated({
      channel: channelLayer,
      auth: makeAuth([]),
    });
    expect(response.status).toBe(403);
  }),
);

it.effect("rejects credentials that fail authentication", () =>
  Effect.gen(function* () {
    const response = yield* unauthenticated({
      channel: channelLayer,
      auth: makeAuth([], new EnvironmentAuth.ServerAuthMissingCredentialError({})),
    });
    expect(response.status).toBe(401);
  }),
);

it.effect("hosts a remote browser over WebSocket frames", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { origin, channel } = yield* startServer({
        channel: channelLayer,
        auth: makeAuth([AuthPreviewOperateScope]),
      });
      const socket = yield* openHost(origin);

      // Desktop events cross as one JSON record per text frame.
      socket.send('{"type":"attached","threadId":"thread","tabId":"tab"}\n');
      expect(yield* channel.awaitAttached({ threadId: "thread", tabId: "tab" }, "60 seconds")).toBe(
        true,
      );

      // Server commands cross back the same way.
      const received = Promise.withResolvers<unknown>();
      socket.addEventListener("message", (event) =>
        received.resolve(JSON.parse(String(event.data))),
      );
      yield* channel.pointer({ threadId: "thread", tabId: "tab" }, { phase: "click", x: 5, y: 6 });
      expect(yield* Effect.promise(() => received.promise)).toEqual({
        type: "pointer",
        threadId: "thread",
        tabId: "tab",
        phase: "click",
        x: 5,
        y: 6,
      });
    }),
  ),
);

it.effect("replaces the previous host and refuses servers with their own browser", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { origin, channel } = yield* startServer({
        channel: channelLayer,
        auth: makeAuth([AuthPreviewOperateScope]),
      });
      const first = yield* openHost(origin);
      first.send('{"type":"attached","threadId":"thread","tabId":"first"}\n');
      expect(
        yield* channel.awaitAttached({ threadId: "thread", tabId: "first" }, "60 seconds"),
      ).toBe(true);

      const firstClosed = receiveClose(first);
      yield* openHost(origin);
      expect((yield* firstClosed).code).toBe(DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE);
      expect(yield* channel.isAttached({ threadId: "thread", tabId: "first" })).toBe(false);

      const bundled = yield* startServer({
        channel: bundledChannelLayer,
        auth: makeAuth([AuthPreviewOperateScope]),
      });
      const bundledSocket = yield* openHost(bundled.origin);
      const bundledClosed = receiveClose(bundledSocket);
      expect((yield* bundledClosed).code).toBe(DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE);
    }),
  ),
);
