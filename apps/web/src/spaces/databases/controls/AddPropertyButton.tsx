import type { SpacePropertyId, SpacePropertyType } from "@t2code/contracts/spaces";
import { lazy, Suspense, useState, type ReactElement, type ReactNode } from "react";

import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { PROPERTY_TYPE_META, propertyTypeMeta } from "../primitives/propertyTypes";
import {
  configForType,
  defaultRollupConfig,
  orderWithInserted,
  uniqueName,
} from "./propertyConfig";
import { PropertyEditorDialog } from "./PropertyEditorDialog";
import { RelationSetup, type RelationChoice } from "./RelationSetup";
import { useViewControls } from "./useViewControls";

const WITH_SETTINGS: ReadonlyArray<string> = [
  "select",
  "multi_select",
  "status",
  "number",
  "date",
  "rollup",
];
const FormulaEditor = lazy(() => import("../formula/FormulaEditor"));
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
  const { dataSource, columns, canEditSchema, actions } = useViewControls();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [relation, setRelation] = useState(false);
  const [editing, setEditing] = useState<SpacePropertyId | null>(null);
  const [formula, setFormula] = useState<SpacePropertyId | null>(null);
  if (!canEditSchema) return null;

  const names = Object.values(dataSource.properties).map((property) => property.name);
  const noRelation = defaultRollupConfig(dataSource) === null;
  const shownName = name ?? uniqueName("Property", names);
  const close = () => {
    setOpen(false);
    setName(null);
    setRelation(false);
  };
  const propertyName = () =>
    shownName.trim() === "" ? uniqueName("Property", names) : shownName.trim();
  const placed = (id: SpacePropertyId) => {
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
  };
  const addRelation = async (choice: RelationChoice) => {
    const id = await actions.addRelation({
      name: propertyName(),
      target: choice.target.dataSourceId,
      limit: choice.limit,
      twin: choice.twinName === null ? null : { name: choice.twinName },
      ...(beforePropertyId === undefined ? {} : { beforePropertyId }),
    });
    if (id === null) return;
    placed(id);
    close();
    setEditing(id);
  };
  const add = async (type: SpacePropertyType) => {
    const config = configForType(type, dataSource);
    const id = await actions.addProperty(
      {
        name: propertyName(),
        type,
        ...(config === undefined ? {} : { config }),
      },
      beforePropertyId,
    );
    if (id === null) return;
    placed(id);
    close();
    if (type === "formula") setFormula(id);
    else if (WITH_SETTINGS.includes(type)) setEditing(id);
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
              <RelationSetup onAdd={(choice) => void addRelation(choice)} />
            ) : (
              <div role="menu" aria-label="Property type" className="space-y-0.5">
                {TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    role="menuitem"
                    className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-sm outline-none hover:bg-accent disabled:opacity-64 disabled:hover:bg-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    disabled={type === "rollup" && noRelation}
                    onClick={() => (type === "relation" ? setRelation(true) : void add(type))}
                  >
                    <PropertyTypeIcon type={type} />
                    {propertyTypeMeta(type).label}
                    {type === "rollup" && noRelation ? (
                      <span className="ms-auto text-xs text-muted-foreground">
                        Needs a relation
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </PopoverPopup>
      </Popover>
      {formula === null ? null : (
        <Suspense fallback={null}>
          <FormulaEditor propertyId={formula} onClose={() => setFormula(null)} />
        </Suspense>
      )}
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
