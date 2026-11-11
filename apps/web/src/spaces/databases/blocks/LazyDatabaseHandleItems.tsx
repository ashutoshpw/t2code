import { type ComponentProps, lazy, Suspense } from "react";

import { MoveBlockItems } from "./MoveBlockItems";

// The linked-view lookup behind the delete item reaches the signed-in data layer, which the
// public viewer renders this editor without and must not load.
const Loaded = lazy(() =>
  import("./DatabaseHandleItems").then((module) => ({ default: module.DatabaseHandleItems })),
);

export function DatabaseHandleItems(props: ComponentProps<typeof Loaded>) {
  const { adapter, blockId, can, run } = props;
  return (
    <Suspense fallback={<MoveBlockItems adapter={adapter} blockId={blockId} can={can} run={run} />}>
      <Loaded {...props} />
    </Suspense>
  );
}
