// @effect-diagnostics nodeBuiltinImport:off - writes a WebSocket close frame before the handler returns.
import {
  AuthPreviewOperateScope,
  DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE,
  DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE,
} from "@t2code/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";

// Mounted under the preview-stream base so remote hubs proxy it like the media routes.
const PREVIEW_HOST_ROUTE_PREFIX = "/api/preview-stream";
const PREVIEW_HOST_ROUTE_PATH = `${PREVIEW_HOST_ROUTE_PREFIX}/host`;

const textDecoder = new TextDecoder();

// Request middleware owns tracing, including long-lived WebSocket sessions.
const makeHandler = Effect.fnUntraced(function* (
  channel: DesktopBrowserChannel.DesktopBrowserChannel["Service"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (
    Option.isNone(url) ||
    url.value.pathname !== PREVIEW_HOST_ROUTE_PATH ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  yield* authenticateMediaRequest(AuthPreviewOperateScope);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* request.upgrade;
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      // One frame is one NDJSON record; the appended newline keeps the line decoder
      // flushing even for clients that do not terminate their frames.
      const session = yield* channel
        .attachHost({
          events: DesktopBrowserChannel.decodeEvents(
            Stream.fromEffectRepeat(reader.pull).pipe(
              Stream.flatMap((frames) =>
                Stream.fromIterable(frames).pipe(
                  Stream.map((frame) => {
                    const text = typeof frame === "string" ? frame : textDecoder.decode(frame);
                    return Buffer.from(`${text}\n`, "utf8");
                  }),
                ),
              ),
            ),
          ),
          send: (command) =>
            DesktopBrowserChannel.encodeCommandLine(command).pipe(
              Effect.flatMap((line) => writer.write(line)),
              // A malformed command must not end the host session.
              Effect.catchCause((cause) =>
                Effect.logWarning("preview host command failed", { cause }),
              ),
            ),
          close: writer
            .write(new Socket.CloseEvent(DESKTOP_BROWSER_HOST_REPLACED_CLOSE_CODE, "host replaced"))
            .pipe(Effect.ignore),
        })
        .pipe(
          Effect.asSome,
          Effect.catchTags({
            DesktopBrowserHostUnavailableError: () => Effect.succeedNone,
          }),
        );
      if (Option.isNone(session)) {
        yield* writer.write(
          new Socket.CloseEvent(
            DESKTOP_BROWSER_HOST_REFUSED_CLOSE_CODE,
            "server has its own desktop",
          ),
        );
        return HttpServerResponse.empty();
      }
      yield* session.value.closed;
      return HttpServerResponse.empty();
    }),
  );
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
    yield* router.add("GET", PREVIEW_HOST_ROUTE_PATH, makeHandler(channel));
  }),
);
