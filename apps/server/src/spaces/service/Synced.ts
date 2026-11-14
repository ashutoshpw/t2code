import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ensureLimit, byteLength } from "../CorePolicy.ts";
import * as SyncedBlocks from "../SyncedBlocks.ts";
import { pageSummary, strict, isServiceError, validateRaw, checkIds } from "./Helpers.ts";
import type { Runtime } from "./Runtime.ts";

const decodeSubtree = Schema.decodeUnknownEffect(C.SpaceReadSubtreeInput, strict);

export const make = (rt: Runtime) => {
  const { admit, checkEnvironment, readWithAdmission } = rt;
  const readSubtree = Effect.fn("SpacesService.readSubtree")(function* (raw: unknown) {
    const environmentId = yield* admit();
    const input = yield* validateRaw(raw).pipe(
      Effect.flatMap(decodeSubtree),
      Effect.mapError((e) =>
        isServiceError(e) ? e : new C.SpaceValidationError({ reason: "invalid_input" }),
      ),
    );
    yield* checkEnvironment(environmentId, input.environmentId);
    return yield* readWithAdmission(environmentId, (_meta, admission) =>
      Effect.gen(function* () {
        yield* checkIds(input);
        const found = yield* SyncedBlocks.readSubtree(input.blockId);
        if (found.status !== "found") return found;
        const result = {
          ...found,
          page: pageSummary(found.page),
          mutationAdmission: admission,
        };
        yield* ensureLimit("maxBlockWindowResponseBytes", byteLength(result));
        return result;
      }),
    );
  });
  return { readSubtree };
};
