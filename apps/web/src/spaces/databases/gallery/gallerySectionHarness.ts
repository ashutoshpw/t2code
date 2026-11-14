import { applyViewPatch, knownView } from "@t2code/client-runtime/spaces";
import type { SpaceDataSource, SpaceDatabaseView } from "@t2code/contracts/spaces";

import type { LayoutSectionProps } from "../shell/layoutSection";

/** Props for a Layout section over a view that the test holds in state. */
export function layoutSectionProps(
  view: SpaceDatabaseView,
  dataSource: SpaceDataSource,
  onChange: (next: SpaceDatabaseView) => void,
): LayoutSectionProps {
  return {
    view,
    known: knownView(view),
    dataSource,
    disabled: false,
    editView: (patch) => onChange(applyViewPatch(view, patch)),
  };
}
