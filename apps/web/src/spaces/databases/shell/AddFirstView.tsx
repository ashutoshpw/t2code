import { useState } from "react";
import type { SpaceDataSourceId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { OptionSelect } from "../controls/OptionSelect";
import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { VIEW_REGISTRY, VIEW_TYPES } from "./viewRegistry";

/** A block with no views of its own (a fresh linked view): pick a type, and a data source when there are several. */
export function AddFirstView({
  model,
  actions,
}: {
  readonly model: DatabaseModel;
  readonly actions: DatabaseActions;
}) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const many = model.dataSources.length > 1;
  const canAdd = model.permissions.views && model.permissions.block;
  const chosen = sourceId ?? model.dataSources[0]?.id ?? null;
  return (
    <div className="space-y-2 rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      <p role="status">Add a view</p>
      {many ? (
        <div className="mx-auto w-48">
          <OptionSelect
            label="Data source"
            value={chosen}
            choices={model.dataSources.map((source) => ({
              value: source.id as string,
              label: source.name,
            }))}
            disabled={!canAdd}
            onChange={setSourceId}
          />
        </div>
      ) : null}
      <div className="flex flex-wrap justify-center gap-1.5">
        {VIEW_TYPES.map((type) => {
          const { icon: Icon, label } = VIEW_REGISTRY[type];
          return (
            <Button
              key={type}
              variant="outline"
              size="xs"
              disabled={!canAdd || chosen === null}
              onClick={() =>
                chosen !== null && void actions.createView(type, chosen as SpaceDataSourceId)
              }
            >
              <Icon />
              {label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
