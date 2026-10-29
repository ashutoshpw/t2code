import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ServerEnvironment from "../apps/server/src/environment/ServerEnvironment.ts";
import * as ServerSettings from "../apps/server/src/serverSettings.ts";
import * as SpacesService from "../apps/server/src/spaces/SpacesService.ts";

export function mobileSpacesServiceLayer(file, environmentId) {
  return SpacesService.layerFromPath(NodePath.join(NodePath.dirname(file), "spaces.sqlite")).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        ServerSettings.layerTest({ spacesEnabled: true }),
      ),
    ),
  );
}

export const promiseRunner = Effect.fn("MobileSpacesTest.promiseRunner")(function* () {
  const requests = yield* Queue.unbounded();
  yield* Effect.forkScoped(
    Effect.forever(Queue.take(requests).pipe(Effect.flatMap(Effect.forkScoped))),
  );
  return (effect) =>
    new Promise((resolve, reject) => {
      const request = Effect.exit(effect).pipe(
        Effect.map((exit) => {
          if (Exit.isSuccess(exit)) resolve(exit.value);
          else reject(Cause.squash(exit.cause));
        }),
      );
      if (!Queue.offerUnsafe(requests, request)) reject(new Error("Test service scope closed"));
    });
});
