/** The desktop browser pane volunteers itself to each remote server the app is using. */
import {
  DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE,
  DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE,
  type DesktopPreviewHostState,
  type EnvironmentId,
} from "@t2code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

/** The two events this protocol needs from a WebSocket, so tests can run without a network. */
export interface PreviewHostSocket {
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly onOpen: (listener: () => void) => void;
  readonly onMessage: (listener: (data: string) => void) => void;
  readonly onClose: (listener: (event: { readonly code: number }) => void) => void;
}

export type PreviewHostSocketFactory = (url: string) => PreviewHostSocket;

const openWebSocket: PreviewHostSocketFactory = (url) => {
  const socket = new WebSocket(url);
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => socket.close(),
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onMessage: (listener) =>
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") listener(event.data);
      }),
    onClose: (listener) =>
      socket.addEventListener("close", (event) => listener({ code: event.code })),
  };
};

const CLOSE_REASONS: Readonly<Record<number, DesktopPreviewHostState["reason"]>> = {
  [DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE]: "replaced",
  [DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE]: "refused",
  1008: "unauthorized",
  4401: "unauthorized",
};

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;

interface HostSession {
  readonly environmentId: EnvironmentId;
  readonly url: string;
  socket: PreviewHostSocket;
  pump: Fiber.Fiber<void> | null;
  retry: Fiber.Fiber<void> | null;
  attempts: number;
  opened: boolean;
}

export class PreviewHostClient extends Context.Service<
  PreviewHostClient,
  {
    /** Connects this browser pane to a server; a second call replaces the current connection. */
    readonly start: (input: {
      readonly environmentId: EnvironmentId;
      readonly url: string;
    }) => Effect.Effect<void>;
    readonly stop: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly states: Stream.Stream<DesktopPreviewHostState>;
  }
>()("@t2code/desktop/preview/PreviewHostClient") {}

const make = Effect.fn("PreviewHostClient.make")(function* (open: PreviewHostSocketFactory) {
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  // A single-consumer queue keeps states for whoever attaches to the stream.
  const states = yield* Queue.unbounded<DesktopPreviewHostState>();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const sessions = new Map<EnvironmentId, HostSession>();

  const publish = (state: DesktopPreviewHostState) => runFork(Queue.offer(states, state));

  const isCurrent = (session: HostSession) => sessions.get(session.environmentId) === session;

  const disconnect = (session: HostSession) => {
    session.socket.close();
    if (session.pump !== null) runFork(Fiber.interrupt(session.pump));
    if (session.retry !== null) runFork(Fiber.interrupt(session.retry));
    session.pump = null;
    session.retry = null;
  };

  const connect = (environmentId: EnvironmentId, url: string) => {
    const socket = open(url);
    const session: HostSession = {
      environmentId,
      url,
      socket,
      pump: null,
      retry: null,
      attempts: 0,
      opened: false,
    };
    sessions.set(environmentId, session);

    const retryLater = () => {
      if (!isCurrent(session)) return;
      const delay = Math.min(RETRY_BASE_MS * 2 ** session.attempts, RETRY_MAX_MS);
      session.attempts += 1;
      session.retry = runFork(
        Effect.sleep(delay).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!isCurrent(session)) return;
              connect(environmentId, url);
              publish({ environmentId, status: "connecting" });
            }),
          ),
        ),
      );
    };

    socket.onOpen(() => {
      if (!isCurrent(session)) return;
      session.opened = true;
      session.attempts = 0;
      publish({ environmentId, status: "connected" });
      session.pump = runFork(
        browserHost.eventsFor(environmentId).pipe(
          Stream.runForEach((line) =>
            Effect.sync(() => session.socket.send(new TextDecoder().decode(line))),
          ),
          Effect.ignore,
        ),
      );
    });

    socket.onMessage((data) => {
      if (!isCurrent(session)) return;
      runFork(browserHost.handleCommandLine(data.trim(), environmentId));
    });

    socket.onClose(({ code }) => {
      if (session.pump !== null) runFork(Fiber.interrupt(session.pump));
      session.pump = null;
      if (!isCurrent(session)) return;
      // A refused or replaced host must stop: retrying would fight the host that won.
      const reason = CLOSE_REASONS[code] ?? (session.opened ? "disconnected" : "unauthorized");
      publish({ environmentId, status: "closed", reason });
      if (reason === "replaced" || reason === "refused") {
        sessions.delete(environmentId);
        return;
      }
      if (reason === "unauthorized") {
        // The server mints a ticket per connection; only the renderer can refresh one.
        sessions.delete(environmentId);
        return;
      }
      retryLater();
    });
  };

  return PreviewHostClient.of({
    start: Effect.fn("PreviewHostClient.start")(function* ({
      environmentId,
      url,
    }: {
      readonly environmentId: EnvironmentId;
      readonly url: string;
    }) {
      const existing = sessions.get(environmentId);
      if (existing !== undefined) {
        if (existing.url === url) return;
        sessions.delete(environmentId);
        disconnect(existing);
      }
      connect(environmentId, url);
      yield* Queue.offer(states, { environmentId, status: "connecting" });
    }),
    stop: Effect.fn("PreviewHostClient.stop")((environmentId) =>
      Effect.sync(() => {
        const session = sessions.get(environmentId);
        if (session === undefined) return;
        sessions.delete(environmentId);
        disconnect(session);
      }),
    ),
    states: Stream.fromQueue(states),
  });
});

export const layerWith = (open: PreviewHostSocketFactory) =>
  Layer.effect(PreviewHostClient, make(open));

export const layer = layerWith(openWebSocket);
