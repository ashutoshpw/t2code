import type { SpacePropertyId } from "@t2code/contracts/spaces";
import { ChevronLeftIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { AddPropertyButton } from "./AddPropertyButton";
import { DeletedProperties } from "./DeletedProperties";
import { PropertyEditor } from "./PropertyEditor";
import { SortableList, SortableRow } from "./Sortable";
import { useViewControls } from "./useViewControls";

const TITLE = "title";

export function PropertiesPopover() {
  const { columns, canEditView, canEditSchema, actions } = useViewControls();
  const [editing, setEditing] = useState<SpacePropertyId | null>(null);
  if (editing !== null)
    return (
      <div className="space-y-2">
        <Button variant="ghost-muted" size="xs" onClick={() => setEditing(null)}>
          <ChevronLeftIcon />
          Properties
        </Button>
        <PropertyEditor propertyId={editing} />
      </div>
    );
  const setVisible = (visible: boolean) =>
    actions.editView({
      properties: {
        set: Object.fromEntries(
          columns
            .filter((column) => column.property.id !== TITLE && column.visible !== visible)
            .map((column) => [column.property.id, { visible }]),
        ),
      },
    });
  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Properties</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={!canEditView}
            onClick={() => setVisible(true)}
          >
            Show all
          </Button>
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={!canEditView}
            onClick={() => setVisible(false)}
          >
            Hide all
          </Button>
        </div>
      </div>
      <SortableList
        ids={columns.map((column) => column.property.id)}
        onReorder={(order) =>
          actions.editView({ properties: { order: order as SpacePropertyId[] } })
        }
      >
        <div className="space-y-0.5">
          {columns.map((column) => (
            <SortableRow
              key={column.property.id}
              id={column.property.id}
              label={column.property.name}
              disabled={!canEditView || column.property.id === TITLE}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={`Edit ${column.property.name}`}
                onClick={() => setEditing(column.property.id)}
              >
                <PropertyTypeIcon type={column.property.type} />
                <span className="truncate">{column.property.name}</span>
              </button>
              <Switch
                size="sm"
                aria-label={`Show ${column.property.name}`}
                checked={column.visible}
                disabled={!canEditView || column.property.id === TITLE}
                onCheckedChange={(visible) =>
                  actions.editView({
                    properties: { set: { [column.property.id]: { visible } } },
                  })
                }
              />
            </SortableRow>
          ))}
        </div>
      </SortableList>
      {canEditSchema ? (
        <AddPropertyButton
          render={
            <Button variant="ghost-muted" size="xs">
              <PlusIcon />
              New property
            </Button>
          }
        />
      ) : null}
      <DeletedProperties />
    </div>
  );
}
