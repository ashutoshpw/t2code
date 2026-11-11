import type { FnDef } from "./fn.ts";
import { dateFunctions } from "./functions/date.ts";
import { listFunctions } from "./functions/list.ts";
import { logicFunctions } from "./functions/logic.ts";
import { addText, numberFunctions } from "./functions/number.ts";
import { textFunctions } from "./functions/text.ts";

const textConcat: FnDef = {
  name: "addText",
  signature: "addText(a, b)",
  description: "Joins text.",
  example: 'addText("a", "b")',
  category: "text",
  params: ["any", "any"],
  min: 2,
  max: 2,
  ret: "text",
  internal: true,
  noFar: true,
  run: ([a, b], rt) => addText(a ?? null, b ?? null, rt),
};

const ALL: ReadonlyArray<FnDef> = [
  ...logicFunctions,
  ...textFunctions,
  ...numberFunctions,
  ...dateFunctions,
  ...listFunctions,
  textConcat,
];

export const REGISTRY: ReadonlyMap<string, FnDef> = new Map(ALL.map((def) => [def.name, def]));

export interface FormulaFunctionDoc {
  readonly name: string;
  readonly signature: string;
  readonly description: string;
  readonly example: string;
  readonly category: FnDef["category"];
}

export const FUNCTIONS: ReadonlyArray<FormulaFunctionDoc> = ALL.filter(
  (def) => def.internal !== true && def.unsupported !== true,
).map(({ name, signature, description, example, category }) => ({
  name,
  signature,
  description,
  example,
  category,
}));
