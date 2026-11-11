import {
  childrenOf,
  filterShape,
  prune,
  rootGroup,
  type FilterGroupNode,
} from "@t2code/client-runtime/spaces";

import { FilterGroup } from "./FilterGroup";
import { useViewControls } from "./useViewControls";

export function FilterPopover() {
  const { known, view, dataSource, limits, canEditView, actions } = useViewControls();
  const filter = known?.filter ?? null;
  const root = rootGroup(filter);
  const shape = filterShape(filter);
  const commit = (next: FilterGroupNode) => actions.editView({ filter: prune(next) });
  return (
    <div key={view.id} className="w-[34rem] max-w-[calc(100vw-2rem)] space-y-2">
      {childrenOf(root).length === 0 ? (
        <p className="text-xs text-muted-foreground">No filters applied to this view</p>
      ) : null}
      <FilterGroup
        root={root}
        path={[]}
        context={{
          properties: dataSource.properties,
          disabled: !canEditView,
          maxDepth: limits.maxFilterDepth,
          atConditionLimit: shape.conditions >= limits.maxFilterConditions,
          commit,
        }}
      />
    </div>
  );
}
