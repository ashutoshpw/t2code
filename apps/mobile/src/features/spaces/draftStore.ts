import type { SpaceDraftStore } from "@t2code/client-runtime/spaces";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";

import { MobileDatabase, type MobileDatabaseError } from "../../persistence/mobile-database";

export function createMobileSpaceDraftStore(
  context: () => Promise<Context.Context<MobileDatabase>>,
): SpaceDraftStore {
  const run = async <A>(effect: Effect.Effect<A, MobileDatabaseError, MobileDatabase>) =>
    Effect.runPromiseWith(await context())(effect);
  return {
    load: (key) =>
      run(Effect.flatMap(MobileDatabase, (database) => database.loadSpacePageDraft(key))),
    write: (key, draft) =>
      run(Effect.flatMap(MobileDatabase, (database) => database.writeSpacePageDraft(key, draft))),
  };
}
