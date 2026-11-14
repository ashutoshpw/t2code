import { FUNCTIONS, typeLabel, type FormulaSchema } from "@t2code/shared/formula";
import { useState } from "react";

import { Input } from "~/components/ui/input";

/** Properties (click inserts `prop("Name")`) and the function reference, filtered by a search. */
export function FormulaReference({
  schema,
  disabled,
  onInsert,
}: {
  readonly schema: FormulaSchema;
  readonly disabled: boolean;
  readonly onInsert: (text: string) => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const properties = schema.properties.filter(
    (property) =>
      property.deleted !== true &&
      property.broken !== true &&
      (needle === "" || property.name.toLowerCase().includes(needle)),
  );
  const functions = FUNCTIONS.filter(
    (entry) =>
      needle === "" ||
      entry.name.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle),
  );
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <Input
        size="compact"
        aria-label="Search properties and functions"
        placeholder="Search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pe-1">
        {properties.length === 0 ? null : (
          <section aria-label="Properties" className="space-y-0.5">
            <h3 className="text-xs font-medium text-muted-foreground">Properties</h3>
            {properties.map((property) => (
              <button
                key={property.id}
                type="button"
                disabled={disabled}
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-64"
                onClick={() => onInsert(`prop(${JSON.stringify(property.name)})`)}
              >
                <span className="truncate">{property.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {typeLabel(property.type)}
                </span>
              </button>
            ))}
          </section>
        )}
        <section aria-label="Functions" className="space-y-0.5">
          <h3 className="text-xs font-medium text-muted-foreground">Functions</h3>
          {functions.map((entry) => (
            <button
              key={entry.name}
              type="button"
              disabled={disabled}
              className="block w-full rounded-sm px-2 py-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-64"
              onClick={() => onInsert(`${entry.name}(`)}
            >
              <span className="block truncate font-mono text-xs">{entry.signature}</span>
              <span className="block text-xs text-muted-foreground">{entry.description}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground/70">
                {entry.example}
              </span>
            </button>
          ))}
        </section>
      </div>
    </div>
  );
}
