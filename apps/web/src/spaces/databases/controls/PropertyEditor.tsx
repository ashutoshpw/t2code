import { knownProperty } from "@t2code/client-runtime/spaces";
import type { SpacePropertyId, SpacePropertyType } from "@t2code/contracts/spaces";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { PropertyTypeIcon } from "../primitives/PropertyTypeIcon";
import { propertyTypeMeta } from "../primitives/propertyTypes";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { DateFormatFields } from "./DateFormatFields";
import { NumberFormatSelect } from "./NumberFormatSelect";
import { OptionSelect } from "./OptionSelect";
import { OptionsEditor } from "./OptionsEditor";
import { PropertyNameField } from "./PropertyNameField";
import { PropertyTypeMenu } from "./PropertyTypeMenu";
import {
  CHANGEABLE_TYPES,
  configForType,
  type ConfigObject,
  nextConfig,
  typeChangeNeedsConfirmation,
} from "./propertyConfig";

const LIMITS = [
  { value: "one", label: "One page" },
  { value: "many", label: "Many pages" },
] as const;

export function PropertyEditor({ propertyId }: { readonly propertyId: SpacePropertyId }) {
  const { dataSource, model } = useDatabase();
  const actions = useDatabaseActions();
  const [pendingType, setPendingType] = useState<SpacePropertyType | null>(null);
  const property = dataSource.properties[propertyId];
  const known = property === undefined ? null : knownProperty(property);
  const disabled = !model.permissions.schema;
  if (property === undefined)
    return <p className="text-xs text-muted-foreground">This property no longer exists.</p>;

  const isTitle = property.type === "title";
  const setConfig = (config: ConfigObject) =>
    void actions.updateSchema([{ op: "updateProperty", propertyId, config }]);
  const changeType = async (type: SpacePropertyType) => {
    const config = configForType(type);
    const result = await actions.updateSchema([
      { op: "changePropertyType", propertyId, type, ...(config === undefined ? {} : { config }) },
    ]);
    if (result !== null && result.clearedCells > 0)
      toastManager.add({
        type: "info",
        title: `${result.clearedCells} ${result.clearedCells === 1 ? "value" : "values"} cleared`,
      });
  };
  const pick = (type: SpacePropertyType) => {
    if (typeChangeNeedsConfirmation(property.type, type)) setPendingType(type);
    else void changeType(type);
  };

  return (
    <div className="w-72 max-w-[calc(100vw-2rem)] space-y-3">
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">Name</span>
        <PropertyNameField propertyId={propertyId} name={property.name} disabled={disabled} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Type</span>
        {isTitle || !CHANGEABLE_TYPES.includes(property.type as SpacePropertyType) ? (
          <span className="flex items-center gap-1.5 text-sm">
            <PropertyTypeIcon type={property.type} />
            {propertyTypeMeta(property.type).label}
          </span>
        ) : (
          <PropertyTypeMenu
            value={property.type}
            types={CHANGEABLE_TYPES}
            disabled={disabled}
            onChange={pick}
          />
        )}
      </div>
      {known === null ? null : known.type === "select" ||
        known.type === "multi_select" ||
        known.type === "status" ? (
        <OptionsEditor property={known} disabled={disabled} />
      ) : known.type === "number" ? (
        <NumberFormatSelect known={known} disabled={disabled} onConfig={setConfig} />
      ) : known.type === "date" ||
        known.type === "created_time" ||
        known.type === "last_edited_time" ? (
        <DateFormatFields known={known} disabled={disabled} onConfig={setConfig} />
      ) : known.type === "relation" ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Limit</span>
          <OptionSelect
            label="Relation limit"
            value={known.config.limit}
            choices={LIMITS}
            disabled={disabled}
            onChange={(limit) => setConfig(nextConfig(known, { limit }))}
          />
        </div>
      ) : null}
      <AlertDialog
        open={pendingType !== null}
        onOpenChange={(open) => {
          if (!open) setPendingType(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change type to {pendingType === null ? "" : propertyTypeMeta(pendingType).label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Values that cannot be converted are cleared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => pendingType !== null && void changeType(pendingType)}
            >
              Change type
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
