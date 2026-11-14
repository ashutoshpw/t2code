import { DatabaseIcon } from "lucide-react";
import { useState } from "react";
import { isViewType, offeredViewTypes } from "@t2code/client-runtime/spaces";
import type { SpaceDatabaseView, SpaceDataSourceId } from "@t2code/contracts/spaces";

import { cn } from "~/lib/utils";
import { useEnvironment } from "../../../state/environments";
import { OptionSelect } from "../controls/OptionSelect";
import type { DatabaseActions } from "../data/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { useDatabase } from "./context";
import { VIEW_REGISTRY } from "./viewRegistry";

const CELL =
  "flex flex-col items-center gap-1 rounded-md px-2 py-2.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50";

/** A new data source needs schema rights and room under the database's limit. */
export const canAddDataSource = (model: DatabaseModel) =>
  model.permissions.schema && model.dataSources.length < model.limits.maxDataSourcesPerDatabase;

/** The view types this environment's server accepts. */
function useOfferedTypes(environmentId: DatabaseModel["environmentId"]) {
  return offeredViewTypes(
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces?.features,
  );
}

type NewViewPickerProps =
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
    };

/** The view types as a grid: create one (with a data source choice when there are several), or change a view's layout. */
export function NewViewPicker(props: NewViewPickerProps) {
  return props.mode === "change" ? <ChangePicker {...props} /> : <CreatePicker {...props} />;
}

function ChangePicker({
  view,
  actions,
  disabled = false,
}: Extract<NewViewPickerProps, { readonly mode: "change" }>) {
  const offered = useOfferedTypes(useDatabase().model.environmentId);
  const types =
    isViewType(view.type) && !offered.includes(view.type) ? [...offered, view.type] : offered;
  return (
    <div role="radiogroup" aria-label="Layout" className="grid grid-cols-3 gap-1 p-2">
      {types.map((type) => {
        const { icon: Icon, label } = VIEW_REGISTRY[type];
        return (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={view.type === type}
            disabled={disabled}
            className={cn(CELL, view.type === type && "bg-accent")}
            onClick={() => void actions.changeViewType(view.id, type)}
          >
            <Icon className="size-5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function CreatePicker({
  model,
  actions,
  disabled = false,
  onDone,
}: Extract<NewViewPickerProps, { readonly mode: "create" }>) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const types = useOfferedTypes(model.environmentId);
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
        {types.map((type) => {
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
