import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { isServiceError, strict, validateRaw } from "./Helpers.ts";
import type { Runtime } from "./Runtime.ts";

const decodeSubscribe = Schema.decodeUnknownEffect(C.SpaceDatabaseChangesSubscribeInput, strict);

export const make = (rt: Runtime) => {
  // Admission and the environment check run before the mailbox exists, so a refused call receives nothing.
  const subscribeDatabaseChanges = (raw: unknown) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const environmentId = yield* rt.admit();
        const input = yield* validateRaw(raw).pipe(
          Effect.flatMap(decodeSubscribe),
          Effect.mapError((e) =>
            isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
          ),
        );
        yield* rt.checkEnvironment(environmentId, input.environmentId);
        yield* rt.acquire.pipe(Effect.asVoid);
        return rt.changes.subscribe;
      }),
    );
  return { subscribeDatabaseChanges };
};
