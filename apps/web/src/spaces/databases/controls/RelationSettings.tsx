import type { SpaceKnownDatabaseProperty } from "@t2code/contracts/spaces";
import { SpacePropertyId } from "@t2code/contracts/spaces";
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
import { Switch } from "~/components/ui/switch";
import { randomUUID } from "~/lib/utils";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { OptionSelect } from "./OptionSelect";
import { nextConfig } from "./propertyConfig";
import { useRelationTarget } from "./useRelationTarget";

const LIMITS = [
  { value: "one", label: "One page" },
  { value: "many", label: "Many pages" },
] as const;

type Relation = Extract<SpaceKnownDatabaseProperty, { type: "relation" }>;

const newId = () => SpacePropertyId.make(randomUUID().replaceAll("-", "").slice(0, 6));

/** Limit, the two-way switch and the read-only target of a relation property. */
export function RelationSettings({
  known,
  disabled,
}: {
  readonly known: Relation;
  readonly disabled: boolean;
}) {
  const { model } = useDatabase();
  const actions = useDatabaseActions();
  const [confirmOff, setConfirmOff] = useState(false);
  const targetId = known.config.dataSourceId;
  const target = useRelationTarget(model.environmentId, model.database.spaceId, targetId);
  const title = target.title ?? "the related database";
  const deleted = target.deleted;
  const twin = known.config.twoWay?.propertyId;
  const setConfig = (patch: Parameters<typeof nextConfig>[1]) =>
    void actions.updateSchema([
      { op: "updateProperty", propertyId: known.id, config: nextConfig(known, patch) },
    ]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-xs text-muted-foreground">Related to</span>
        {deleted ? (
          <span role="status" className="text-xs text-muted-foreground">
            Related database was deleted
          </span>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Limit</span>
        <OptionSelect
          label="Relation limit"
          value={known.config.limit}
          choices={LIMITS}
          disabled={disabled}
          onChange={(limit) => setConfig({ limit })}
        />
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">Show on {title}</span>
        <Switch
          size="sm"
          aria-label={`Show on ${title}`}
          checked={twin !== undefined}
          disabled={disabled || deleted}
          onCheckedChange={(on) => {
            if (on) setConfig({ twoWay: { propertyId: newId() } });
            else setConfirmOff(true);
          }}
        />
      </div>
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the related property?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the related property from {title}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => setConfig({ twoWay: undefined })}
            >
              Remove
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
