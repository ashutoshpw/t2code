import { computedInfoOf, knownProperty } from "@t2code/client-runtime/spaces";
import type { SpacePropertyId, SpacePropertyType } from "@t2code/contracts/spaces";
import { lazy, Suspense, useState } from "react";

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
import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { DateFormatFields } from "./DateFormatFields";
import { NumberFormatSelect } from "./NumberFormatSelect";
import { OptionsEditor } from "./OptionsEditor";
import { PropertyNameField } from "./PropertyNameField";
import { PropertyTypeMenu } from "./PropertyTypeMenu";
import { RelationSettings } from "./RelationSettings";
import {
  CHANGEABLE_TYPES,
  configForType,
  defaultRollupConfig,
  type ConfigObject,
  typeChangeNeedsConfirmation,
} from "./propertyConfig";

// The formula engine is only needed once a formula or rollup is edited.
const FormulaEditor = lazy(() => import("../formula/FormulaEditor"));
const RollupConfig = lazy(() => import("./RollupConfig"));

function FormulaSettings({
  known,
  disabled,
  onConfig,
}: {
  readonly known: Extract<SpaceKnownDatabaseProperty, { type: "formula" }>;
  readonly disabled: boolean;
  readonly onConfig: (config: ConfigObject) => void;
}) {
  const [editing, setEditing] = useState(false);
  const info = computedInfoOf(known);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled}
        className="block w-full truncate rounded-md border bg-muted/30 px-2 py-1.5 text-start font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-64"
        aria-label="Edit formula"
        onClick={() => setEditing(true)}
      >
        {known.config.expression === "" ? (
          <span className="text-muted-foreground">Add a formula</span>
        ) : (
          known.config.expression
        )}
      </button>
      {info?.error === undefined ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {info.error.message}
        </p>
      )}
      {info?.resultType === "number" ? (
        <NumberFormatSelect known={known} disabled={disabled} onConfig={onConfig} />
      ) : null}
      {editing ? (
        <Suspense fallback={null}>
          <FormulaEditor propertyId={known.id} onClose={() => setEditing(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

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
    const config = configForType(type, dataSource);
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
            types={
              defaultRollupConfig(dataSource) === null
                ? CHANGEABLE_TYPES.filter((type) => type !== "rollup")
                : CHANGEABLE_TYPES
            }
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
        <RelationSettings known={known} disabled={disabled} />
      ) : known.type === "formula" ? (
        <FormulaSettings known={known} disabled={disabled} onConfig={setConfig} />
      ) : known.type === "rollup" ? (
        <Suspense fallback={null}>
          <RollupConfig known={known} disabled={disabled} />
        </Suspense>
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
