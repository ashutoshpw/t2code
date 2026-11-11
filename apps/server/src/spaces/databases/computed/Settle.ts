import * as Effect from "effect/Effect";

import type { Touched } from "../Touched.ts";
import * as Drain from "./Drain.ts";
import * as Dirty from "./Dirty.ts";

/**
 * What every mutation does before it finalizes: queue the rows its writes affect, then compute as
 * many of them as fit in the mutation; data sources whose computed cells changed are reported
 * through `touched.sources` so their data revision is bumped once.
 */
export const settleAndDrain = Effect.fn("SpacesDatabases.settleAndDrain")(function* (
  touched: Touched,
) {
  yield* Dirty.settle(touched);
  for (const id of yield* Drain.inMutation()) touched.sources.add(id);
});
