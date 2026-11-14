import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { NewViewPicker } from "./NewViewPicker";

/** A block with no views of its own (a fresh linked view): pick a type, and a data source when there are several. */
export function AddFirstView({
  model,
  actions,
}: {
  readonly model: DatabaseModel;
  readonly actions: DatabaseActions;
}) {
  const canAdd = model.permissions.views && model.permissions.block;
  return (
    <div className="space-y-1 rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      <p role="status">Add a view</p>
      <div className="mx-auto max-w-sm">
        <NewViewPicker mode="create" model={model} actions={actions} disabled={!canAdd} />
      </div>
    </div>
  );
}
