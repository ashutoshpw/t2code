import { formulaTypeOfProperty, knownProperty } from "@t2code/client-runtime/spaces";
import type { SpaceKnownDatabaseProperty, SpacePropertyId } from "@t2code/contracts/spaces";
import {
  rollupFunctionsFor,
  rollupResultType,
  typeLabel,
  type RollupFunction,
} from "@t2code/shared/formula";

import { useFormulaSchema } from "../formula/useFormulaSchema";
import { useDatabase, useDatabaseActions } from "../shell/context";
import { NumberFormatSelect } from "./NumberFormatSelect";
import { OptionSelect } from "./OptionSelect";
import { nextConfig, type ConfigObject } from "./propertyConfig";

type Rollup = Extract<SpaceKnownDatabaseProperty, { type: "rollup" }>;

const FUNCTION_LABELS: Record<string, string> = {
  show_original: "Show original",
  show_unique: "Show unique values",
  count_all: "Count all",
  count_values: "Count values",
  count_unique: "Count unique values",
  count_empty: "Count empty",
  count_not_empty: "Count not empty",
  percent_empty: "Percent empty",
  percent_not_empty: "Percent not empty",
  sum: "Sum",
  average: "Average",
  median: "Median",
  min: "Min",
  max: "Max",
  range: "Range",
  earliest_date: "Earliest date",
  latest_date: "Latest date",
  date_range: "Date range",
  checked: "Checked",
  unchecked: "Unchecked",
  percent_checked: "Percent checked",
  percent_unchecked: "Percent unchecked",
};
const rollupFunctionLabel = (fn: string) => FUNCTION_LABELS[fn] ?? fn;

/** Relation, target property and calculation of a rollup; only functions valid for the target type. */
function RollupConfig({ known, disabled }: { readonly known: Rollup; readonly disabled: boolean }) {
  const { dataSource } = useDatabase();
  const actions = useDatabaseActions();
  const { loading, sourceOf } = useFormulaSchema(dataSource);
  const relations = Object.values(dataSource.properties)
    .filter((property) => property.type === "relation")
    .sort((a, b) => a.position - b.position);
  const relation = dataSource.properties[known.config.relationPropertyId];
  const relationKnown = relation === undefined ? null : knownProperty(relation);
  const targetSourceId =
    relationKnown?.type === "relation" ? relationKnown.config.dataSourceId : undefined;
  const targetSource = targetSourceId === undefined ? undefined : sourceOf(targetSourceId);
  // The server refuses a rollup of a rollup, and a target in error or using now().
  const targets =
    targetSource === undefined
      ? undefined
      : Object.values(targetSource.properties)
          .filter(
            (property) =>
              property.type !== "rollup" &&
              property.computed?.error === undefined &&
              property.computed?.volatile !== true,
          )
          .sort((a, b) => a.position - b.position)
          .map((property) => ({
            id: property.id,
            name: property.name,
            type: formulaTypeOfProperty(property),
          }));
  const target = targets?.find((property) => property.id === known.config.targetPropertyId);
  const functions = target === undefined ? [] : rollupFunctionsFor(target.type);
  const result =
    target === undefined
      ? null
      : rollupResultType(known.config.function as RollupFunction, target.type);

  const commit = (patch: Partial<Rollup["config"]>) =>
    void actions.updateSchema([
      {
        op: "updateProperty",
        propertyId: known.id,
        config: nextConfig(known, patch as Record<string, never>),
      },
    ]);
  const commitFormat = (config: ConfigObject) =>
    void actions.updateSchema([{ op: "updateProperty", propertyId: known.id, config }]);
  const pickTarget = (id: string) => {
    const next = targets?.find((property) => property.id === id);
    if (next === undefined) return;
    const legal = rollupFunctionsFor(next.type).includes(known.config.function as RollupFunction);
    commit({
      targetPropertyId: id as SpacePropertyId,
      ...(legal ? {} : { function: "show_original" }),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Relation</span>
        <OptionSelect
          label="Rollup relation"
          value={known.config.relationPropertyId}
          choices={relations.map((property) => ({ value: property.id, label: property.name }))}
          disabled={disabled}
          onChange={(id) => {
            if (id === known.config.relationPropertyId) return;
            commit({
              relationPropertyId: id as SpacePropertyId,
              targetPropertyId: "title" as SpacePropertyId,
              function: "show_original",
            });
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Property</span>
        <OptionSelect
          label="Rollup property"
          value={known.config.targetPropertyId}
          choices={(targets ?? []).map((property) => ({
            value: property.id,
            label: property.name,
          }))}
          placeholder={loading ? "Loading…" : "Choose a property"}
          disabled={disabled || targets === undefined}
          onChange={pickTarget}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Calculate</span>
        <OptionSelect
          label="Rollup calculation"
          value={known.config.function}
          choices={functions.map((fn) => ({ value: fn, label: rollupFunctionLabel(fn) }))}
          disabled={disabled || target === undefined}
          onChange={(fn) => commit({ function: fn })}
        />
      </div>
      {result === "number" ? (
        <NumberFormatSelect
          known={known}
          disabled={disabled}
          defaultFormat={known.config.function.startsWith("percent_") ? "percent" : "number"}
          onConfig={commitFormat}
        />
      ) : result === null ? null : (
        <p className="text-xs text-muted-foreground">Shows {typeLabel(result)}</p>
      )}
    </div>
  );
}

export default RollupConfig;
