import {
  compile,
  evaluate,
  type CheckResult,
  type EvalContext,
  type FormulaProperty,
  type FormulaSchema,
  type FormulaValue,
} from "./index.ts";

export const TASKS = "tasks";
export const PROJECTS = "projects";

export const taskProps: FormulaProperty[] = [
  { id: "t_name", name: "Name", type: "text" },
  { id: "t_count", name: "Count", type: "number" },
  { id: "t_done", name: "Done", type: "boolean" },
  { id: "t_due", name: "Due", type: "date" },
  { id: "t_tags", name: "Tags", type: { list: "text" } },
  { id: "t_notes", name: "Notes", type: "text" },
  { id: "t_project", name: "Project", type: { list: { page: PROJECTS } }, relationTo: PROJECTS },
  { id: "t_blocked", name: "Blocked by", type: { list: { page: TASKS } }, relationTo: TASKS },
  { id: "t_nowish", name: "Age", type: "number", volatile: true },
  { id: "t_old", name: "Old", type: "text", deleted: true },
  { id: "t_bad", name: "Bad", type: "any", broken: true },
];
const projectProps: FormulaProperty[] = [
  { id: "p_name", name: "Name", type: "text" },
  { id: "p_budget", name: "Budget", type: "number" },
  { id: "p_start", name: "Start", type: "date" },
  { id: "p_live", name: "Live", type: "boolean" },
  { id: "p_aged", name: "Aged", type: "number", volatile: true },
  { id: "p_tasks", name: "Tasks", type: { list: { page: TASKS } }, relationTo: TASKS },
];

export function makeSchema(
  extra: ReadonlyArray<FormulaProperty> = [],
  source: Partial<Record<string, ReadonlyArray<FormulaProperty>>> = {},
): FormulaSchema {
  const tasks = [...taskProps, ...extra];
  const sources: Record<string, ReadonlyArray<FormulaProperty> | undefined> = {
    [PROJECTS]: projectProps,
    [TASKS]: tasks,
    ...source,
  };
  return {
    dataSourceId: TASKS,
    properties: tasks,
    source: (id) => sources[id],
    databaseName: (id) => (id === PROJECTS ? "Projects" : undefined),
  };
}

export const schema = makeSchema();

/** 2024-03-15 12:00 UTC */
export const NOW = Date.UTC(2024, 2, 15, 12, 0, 0);

export const day = (y: number, m: number, d: number): FormulaValue => ({
  kind: "date",
  start: Date.UTC(y, m - 1, d),
  timed: false,
});
export const instant = (ms: number, zone?: string): FormulaValue => ({
  kind: "date",
  start: ms,
  timed: true,
  ...(zone === undefined ? {} : { zone }),
});
export const page = (id: string, ds = PROJECTS): FormulaValue => ({ kind: "page", id, ds });

export type Store = Record<string, Record<string, FormulaValue>>;

export function context(store: Store = {}, over: Partial<EvalContext> = {}): EvalContext {
  return {
    now: NOW,
    timeZone: "UTC",
    row: { id: "row1", dataSourceId: TASKS },
    read: (p, propertyId) => store[p.id]?.[propertyId] ?? null,
    titleOf: (id) => (store[id]?.["title"] as string | undefined) ?? undefined,
    ...over,
  };
}

export function check(source: string, s: FormulaSchema = schema): CheckResult {
  return compile(source, s);
}

export function ev(
  source: string,
  store: Store = {},
  over: Partial<EvalContext> = {},
  s: FormulaSchema = schema,
): FormulaValue {
  const { compiled, diagnostics } = compile(source, s);
  if (compiled === null)
    throw new Error(`${source}: ${diagnostics.map((d) => d.message).join(" | ")}`);
  return evaluate(compiled, context(store, over));
}

export const errors = (source: string, s: FormulaSchema = schema): string[] =>
  compile(source, s).diagnostics.map((d) => d.message);
