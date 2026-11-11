import { formulaSchemaOf } from "@t2code/client-runtime/spaces";
import type {
  SpaceCellValue,
  SpaceDataSource,
  SpaceDatabaseProperty,
  SpaceDatabaseRow,
} from "@t2code/contracts/spaces";
import { compile, evaluate, type FormulaValue } from "@t2code/shared/formula";

import { cellAsFormulaValue } from "../formula/preview";
import { positionOf } from "../formula/formulaText";

/**
 * Formula support for the fake: the real engine checks a saved expression (a refusal carries
 * `detail` as the server's does) and evaluates it over the stored cells of each row.
 */

const QUERY_TYPE = { number: "number", text: "text", boolean: "checkbox", date: "date" } as const;
const ISO_DAY = /T00:00:00\.000Z$/;

function wire(value: FormulaValue): SpaceCellValue | undefined {
  if (value === null) return undefined;
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return { type: "string", value };
  if (Array.isArray(value))
    return { type: "array", value: value.flatMap((item) => wire(item) ?? []) };
  if ("kind" in value) {
    if (value.kind === "page") return { type: "page", value: value.id, dataSourceId: value.ds };
    if (value.kind === "rich")
      return { type: "string", value: value.runs.map((run) => run.text).join("") };
    if (value.kind === "date") {
      const iso = new Date(value.start).toISOString();
      return {
        type: "date",
        value: { start: value.timed ? iso : iso.replace(ISO_DAY, "").slice(0, 10) },
      };
    }
  }
  return undefined;
}

function formulaRefusal(detail: string) {
  return { _tag: "SpaceDatabaseError", reason: "invalid_property_config", detail };
}

/** Compiles every formula property, records `computed`, and evaluates each row. Throws a refusal. */
export function computeFormulas(
  dataSource: SpaceDataSource,
  rows: ReadonlyArray<SpaceDatabaseRow>,
  lookup: (id: string) => SpaceDataSource | undefined,
  now: number,
): { readonly dataSource: SpaceDataSource; readonly rows: SpaceDatabaseRow[] } {
  const properties: Record<string, SpaceDatabaseProperty> = { ...dataSource.properties };
  const current = { ...dataSource, properties };
  const compiledById = new Map<string, ReturnType<typeof compile>["compiled"]>();
  const formulas = Object.values(properties)
    .filter((property) => property.type === "formula")
    .sort((a, b) => a.position - b.position);
  for (let pass = 0; pass < 3; pass++)
    for (const property of formulas) {
      const config = property.config as { expression?: string };
      const source = config.expression ?? "";
      const { compiled, diagnostics } = compile(source, formulaSchemaOf(current, lookup));
      const first = diagnostics[0];
      if (first !== undefined && pass === 2) {
        const at = positionOf(source, first.start);
        throw formulaRefusal(`${at.line}:${at.column} ${first.message}`);
      }
      if (compiled === null) continue;
      compiledById.set(property.id, compiled);
      const queryType =
        compiled.volatile || typeof compiled.type !== "string"
          ? undefined
          : QUERY_TYPE[compiled.type as keyof typeof QUERY_TYPE];
      properties[property.id] = {
        ...property,
        computed: {
          resultType: compiled.type as never,
          ...(queryType === undefined ? {} : { queryType }),
          ...(compiled.volatile ? { volatile: true } : {}),
          inputs: [...compiled.deps.own] as never,
        },
      } as SpaceDatabaseProperty;
    }
  const nextRows = rows.map((row) => {
    let cells = row.cells;
    for (const [id, compiled] of compiledById) {
      if (compiled === null) continue;
      const value = evaluate(compiled, {
        now,
        timeZone: "UTC",
        row: { id: row.page.id, dataSourceId: dataSource.id },
        read: (page, propertyId) => {
          const property = current.properties[propertyId];
          return page.id !== row.page.id || property === undefined
            ? null
            : cellAsFormulaValue(
                property,
                propertyId === "title" ? row.page.title : cells[propertyId],
              );
        },
        titleOf: (pageId) => (pageId === row.page.id ? row.page.title : undefined),
      });
      const cell = wire(value);
      const { [id]: _old, ...rest } = cells;
      cells = cell === undefined ? rest : { ...rest, [id]: cell };
    }
    return cells === row.cells ? row : ({ ...row, cells } as SpaceDatabaseRow);
  });
  return { dataSource: current, rows: nextRows };
}
