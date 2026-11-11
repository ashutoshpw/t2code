import {
  SpaceDataSourceId,
  type SpacePropertyId,
  type SpacePropertyType,
} from "@t2code/contracts/spaces";
import { useState, type ReactElement, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { PROPERTY_TYPE_META, propertyTypeMeta } from "../primitives/propertyTypes";
import { OptionSelect } from "./OptionSelect";
import { configForType, orderWithInserted, uniqueName } from "./propertyConfig";
import { PropertyEditorDialog } from "./PropertyEditorDialog";
import { useViewControls } from "./useViewControls";

const WITH_SETTINGS: ReadonlyArray<string> = [
  "select",
  "multi_select",
  "status",
  "number",
  "date",
  "relation",
];
const TYPES = (Object.keys(PROPERTY_TYPE_META) as SpacePropertyType[]).filter(
  (type) => PROPERTY_TYPE_META[type].creatable,
);

/** A popover with a name and the creatable types; the new property is shown in the view. */
export function AddPropertyButton({
  render,
  beforePropertyId,
}: {
  readonly render: ReactElement;
  readonly beforePropertyId?: SpacePropertyId | null;
}): ReactNode {
  const { model, dataSource, columns, canEditSchema, actions } = useViewControls();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [relation, setRelation] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [editing, setEditing] = useState<SpacePropertyId | null>(null);
  if (!canEditSchema) return null;

  const names = Object.values(dataSource.properties).map((property) => property.name);
  const shownName = name ?? uniqueName("Property", names);
  const close = () => {
    setOpen(false);
    setName(null);
    setRelation(false);
    setTarget(null);
  };
  const add = async (type: SpacePropertyType, dataSourceId?: string) => {
    const config =
      type === "relation" && dataSourceId !== undefined
        ? { dataSourceId, limit: "many" }
        : configForType(type);
    const id = await actions.addProperty(
      {
        name: shownName.trim() === "" ? uniqueName("Property", names) : shownName.trim(),
        type,
        ...(config === undefined ? {} : { config }),
      },
      beforePropertyId,
    );
    if (id === null) return;
    if (beforePropertyId !== undefined)
      actions.editView({
        properties: {
          order: orderWithInserted(
            columns.map((column) => column.property.id),
            id,
            beforePropertyId,
          ),
        },
      });
    close();
    if (WITH_SETTINGS.includes(type)) setEditing(id);
  };

  return (
    <>
      <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <PopoverTrigger render={render} />
        <PopoverPopup align="end" padding="compact">
          <div className="w-60 space-y-2">
            <Input
              size="compact"
              aria-label="New property name"
              value={shownName}
              onChange={(event) => setName(event.target.value)}
            />
            {relation ? (
              <div className="space-y-2">
                <OptionSelect
                  label="Related data source"
                  value={target}
                  placeholder="Choose a data source"
                  choices={model.dataSources.map((source) => ({
                    value: source.id,
                    label: source.name,
                  }))}
                  onChange={setTarget}
                />
                <Button
                  size="xs"
                  disabled={target === null}
                  onClick={() =>
                    target !== null && void add("relation", SpaceDataSourceId.make(target))
                  }
                >
                  Add relation
                </Button>
              </div>
            ) : (
              <div role="menu" aria-label="Property type" className="space-y-0.5">
                {TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="menuitem"
                    className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => (type === "relation" ? setRelation(true) : void add(type))}
                  >
                    <PropertyTypeIcon type={type} />
                    {propertyTypeMeta(type).label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </PopoverPopup>
      </Popover>
      {editing === null ? null : (
        <PropertyEditorDialog
          propertyId={editing}
          open
          onOpenChange={(next) => !next && setEditing(null)}
        />
      )}
    </>
  );
}
