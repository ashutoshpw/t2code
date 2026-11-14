import { DatabaseIcon } from "lucide-react";
import { useState } from "react";
import { isViewType } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseView, SpaceDataSourceId } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { OptionSelect } from "../controls/OptionSelect";
import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { VIEW_REGISTRY, VIEW_TYPES } from "./viewRegistry";

const CELL =
  "flex flex-col items-center gap-1 rounded-md px-2 py-2.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50";

/** A new data source needs schema rights and room under the database's limit. */
export const canAddDataSource = (model: DatabaseModel) =>
  model.permissions.schema && model.dataSources.length < model.limits.maxDataSourcesPerDatabase;

/** The view types as a grid: create one (with a data source choice when there are several), or change a view's layout. */
export function NewViewPicker(
  props:
    | {
        readonly mode: "create";
        readonly model: DatabaseModel;
        readonly actions: DatabaseActions;
        readonly disabled?: boolean;
        readonly onDone?: () => void;
      }
    | {
        readonly mode: "change";
        readonly view: SpaceDatabaseView;
        readonly actions: DatabaseActions;
        readonly disabled?: boolean;
      },
) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  if (props.mode === "change") {
    const { view, actions, disabled = false } = props;
    return (
      <div role="radiogroup" aria-label="Layout" className="grid grid-cols-3 gap-1 p-2">
        {VIEW_TYPES.map((type) => {
          const { icon: Icon, label } = VIEW_REGISTRY[type];
          return (
            <button
              key={type}
              type="button"
              role="radio"
              aria-checked={view.type === type}
              disabled={disabled}
              className={cn(CELL, view.type === type && "bg-accent")}
              onClick={() => {
                if (isViewType(type)) void actions.changeViewType(view.id, type);
              }}
            >
              <Icon className="size-5" />
              {label}
            </button>
          );
        })}
      </div>
    );
  }
  const { model, actions, disabled = false, onDone } = props;
  const chosen = sourceId ?? model.dataSources[0]?.id ?? null;
  return (
    <div>
      {model.dataSources.length > 1 ? (
        <div className="px-2 pt-2">
          <OptionSelect
            label="Data source"
            value={chosen}
            choices={model.dataSources.map((source) => ({
              value: source.id as string,
              label: source.name,
            }))}
            disabled={disabled}
            onChange={setSourceId}
          />
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-1 p-2">
        {VIEW_TYPES.map((type) => {
          const { icon: Icon, label } = VIEW_REGISTRY[type];
          return (
            <button
              key={type}
              type="button"
              disabled={disabled || chosen === null}
              className={CELL}
              onClick={() => {
                if (chosen === null) return;
                void actions.createView(type, chosen as SpaceDataSourceId);
                onDone?.();
              }}
            >
              <Icon className="size-5" />
              {label}
            </button>
          );
        })}
      </div>
      {!disabled && canAddDataSource(model) ? (
        <button
          type="button"
          className="mx-2 mb-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => {
            void actions.createDataSource();
            onDone?.();
          }}
        >
          <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
          New data source
        </button>
      ) : null}
    </div>
  );
}
