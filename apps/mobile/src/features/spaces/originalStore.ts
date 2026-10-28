import type { SpaceImageStore } from "@t2code/client-runtime/spaces";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { MobileDatabase, type MobileDatabaseError } from "../../persistence/mobile-database";
import type { NativeSpaceOriginal } from "./originals";

export function createMobileSpaceMediaStore(
  context: () => Promise<Context.Context<MobileDatabase>>,
): SpaceImageStore<NativeSpaceOriginal> {
  const run = async <A>(effect: Effect.Effect<A, MobileDatabaseError, MobileDatabase>) =>
    Effect.runPromiseWith(await context())(effect);
  return {
    load: () => run(Effect.flatMap(MobileDatabase, (db) => db.loadSpaceMediaRecords)),
    put: (record, expected) =>
      run(Effect.flatMap(MobileDatabase, (db) => db.writeSpaceMediaRecord(record, expected))),
    remove: (record) =>
      run(Effect.flatMap(MobileDatabase, (db) => db.removeSpaceMediaRecord(record))),
  };
}
