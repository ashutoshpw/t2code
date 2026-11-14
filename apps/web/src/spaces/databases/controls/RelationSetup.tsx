import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useDatabase } from "../shell/context";
import { DatabasePicker, type PickedDatabase } from "./DatabasePicker";
import { OptionSelect } from "./OptionSelect";

export interface RelationChoice {
  readonly target: PickedDatabase;
  readonly limit: "one" | "many";
  /** The twin's name when the relation shows on the target too. */
  readonly twinName: string | null;
}

const LIMITS = [
  { value: "many", label: "No limit" },
  { value: "one", label: "1 page" },
] as const;

/** Two steps: choose the target data source, then limit and the optional related property. */
export function RelationSetup({ onAdd }: { readonly onAdd: (choice: RelationChoice) => void }) {
  const { dataSource, model } = useDatabase();
  const [target, setTarget] = useState<PickedDatabase | null>(null);
  const [limit, setLimit] = useState<"one" | "many">("many");
  const [twoWay, setTwoWay] = useState(false);
  const [twinName, setTwinName] = useState<string | null>(null);
  if (target === null)
    return (
      <DatabasePicker
        environmentId={model.environmentId}
        spaceId={model.database.spaceId}
        currentDatabaseId={model.database.id}
        onPick={setTarget}
      />
    );
  const shownTwin = twinName ?? dataSource.name;
  return (
    <div className="space-y-2">
      <p className="truncate text-xs text-muted-foreground">Related to {target.databaseTitle}</p>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Limit</span>
        <OptionSelect label="Relation limit" value={limit} choices={LIMITS} onChange={setLimit} />
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">Show on {target.dataSourceName}</span>
        <Switch
          size="sm"
          aria-label={`Show on ${target.dataSourceName}`}
          checked={twoWay}
          onCheckedChange={setTwoWay}
        />
      </div>
      {twoWay ? (
        <Input
          size="compact"
          aria-label="Related property name"
          value={shownTwin}
          onChange={(event) => setTwinName(event.target.value)}
        />
      ) : null}
      <div className="flex gap-1.5">
        <Button variant="ghost" size="xs" onClick={() => setTarget(null)}>
          Back
        </Button>
        <Button
          size="xs"
          disabled={twoWay && shownTwin.trim() === ""}
          onClick={() => onAdd({ target, limit, twinName: twoWay ? shownTwin.trim() : null })}
        >
          Add relation
        </Button>
      </div>
    </div>
  );
}
