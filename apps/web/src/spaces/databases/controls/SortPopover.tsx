import {
  SPACE_SORTABLE_TYPES,
  type SpaceDatabaseProperty,
  type SpaceKnownSort,
} from "@t2code/contracts/spaces";
import { propertyQueryType, unqueryableReason } from "@t2code/client-runtime/spaces";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { PropertyPicker } from "../primitives/PropertyPicker";
import { OptionSelect } from "./OptionSelect";
import { SortableList, SortableRow } from "./Sortable";
import { useViewControls } from "./useViewControls";

const DIRECTIONS = [
  { value: "ascending", label: "Ascending" },
  { value: "descending", label: "Descending" },
] as const;
const sortable = (property: SpaceDatabaseProperty) =>
  (SPACE_SORTABLE_TYPES as ReadonlyArray<string>).includes(propertyQueryType(property) ?? "");
const listed = (property: SpaceDatabaseProperty) =>
  sortable(property) || unqueryableReason(property) !== undefined;

export function SortPopover() {
  const { known, columns, limits, canEditView, actions } = useViewControls();
  const sorts = known?.sorts ?? [];
  const properties = columns.map((column) => column.property).filter(listed);
  const used = new Set(sorts.map((sort) => sort.property));
  const unused = properties.find((property) => sortable(property) && !used.has(property.id));
  const commit = (next: ReadonlyArray<SpaceKnownSort>) => actions.editView({ sorts: next });
  const change = (index: number, patch: Partial<SpaceKnownSort>) =>
    commit(sorts.map((sort, at) => (at === index ? { ...sort, ...patch } : sort)));
  const nameOf = (id: string) =>
    columns.find((column) => column.property.id === id)?.property.name ?? id;
  return (
    <div className="w-[22rem] max-w-[calc(100vw-2rem)] space-y-2">
      {sorts.length === 0 ? (
        <p className="text-xs text-muted-foreground">No sorts applied to this view</p>
      ) : null}
      <SortableList
        ids={sorts.map((sort) => sort.property)}
        onReorder={(ids) =>
          commit(ids.flatMap((id) => sorts.filter((sort) => sort.property === id)))
        }
      >
        <div className="space-y-1.5">
          {sorts.map((sort, index) => (
            <SortableRow
              key={sort.property}
              id={sort.property}
              label={nameOf(sort.property)}
              disabled={!canEditView}
            >
              <div className="min-w-0 flex-1">
                <PropertyPicker
                  label="Sort property"
                  properties={properties}
                  value={sort.property}
                  disabled={!canEditView}
                  disabledReason={unqueryableReason}
                  filter={(property) => property.id === sort.property || !used.has(property.id)}
                  onChange={(property) => change(index, { property })}
                />
              </div>
              <OptionSelect
                label={`Direction of ${nameOf(sort.property)}`}
                value={sort.direction}
                choices={DIRECTIONS}
                disabled={!canEditView}
                onChange={(direction) => change(index, { direction })}
              />
              <Button
                variant="ghost-muted"
                size="icon-xs"
                disabled={!canEditView}
                aria-label={`Remove sort on ${nameOf(sort.property)}`}
                onClick={() => commit(sorts.filter((_, at) => at !== index))}
              >
                <XIcon />
              </Button>
            </SortableRow>
          ))}
        </div>
      </SortableList>
      <div className="flex items-center justify-between">
        <Button
          variant="ghost-muted"
          size="xs"
          disabled={!canEditView || unused === undefined || sorts.length >= limits.maxSorts}
          onClick={() =>
            unused !== undefined &&
            commit([...sorts, { property: unused.id, direction: "ascending" }])
          }
        >
          <PlusIcon />
          Add sort
        </Button>
        {sorts.length > 0 ? (
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={!canEditView}
            onClick={() => commit([])}
          >
            <Trash2Icon />
            Delete sort
          </Button>
        ) : null}
      </div>
    </div>
  );
}
