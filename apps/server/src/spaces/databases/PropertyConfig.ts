import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { byteLength, databaseLimits } from "../CorePolicy.ts";
import { type Json, type JsonObject, isObject, strictOption } from "./Json.ts";
import { dbError } from "./Types.ts";

const number = strictOption(C.SpaceKnownPropertyConfig.number);
const date = strictOption(C.SpaceKnownPropertyConfig.date);
const relation = strictOption(C.SpaceKnownPropertyConfig.relation);
const rollup = strictOption(C.SpaceKnownPropertyConfig.rollup);
const formula = strictOption(C.SpaceKnownPropertyConfig.formula);
const uniqueId = strictOption(C.SpaceKnownPropertyConfig.unique_id);

const plain = new Set<C.SpacePropertyType>([
  "title",
  "text",
  "checkbox",
  "url",
  "email",
  "phone",
  "files",
]);
const dateLike = new Set<C.SpacePropertyType>(["date", "created_time", "last_edited_time"]);
export const optionTypes = new Set<C.SpacePropertyType>(["select", "multi_select", "status"]);

/**
 * The stored shape of a property config: always without `options`, which live in their own
 * table. Anything with a key the type does not know is rejected.
 */
export const normalizeConfig = Effect.fn("SpacesDatabases.normalizeConfig")(function* (
  type: C.SpacePropertyType,
  raw: Json | undefined,
  propertyId?: string,
) {
  const bad = () => dbError("invalid_property_config", propertyId);
  const value = raw ?? {};
  if (!isObject(value)) return yield* bad();
  let decoded: JsonObject | undefined;
  if (plain.has(type) || type === "select" || type === "multi_select") {
    decoded = Object.keys(value).length === 0 ? {} : undefined;
  } else if (type === "status") {
    const keys = Object.keys(value);
    decoded =
      keys.every((key) => key === "defaultOptionId") &&
      (value.defaultOptionId === undefined || typeof value.defaultOptionId === "string")
        ? value
        : undefined;
  } else if (type === "number")
    decoded = number(Object.keys(value).length ? value : { format: "number" });
  else if (dateLike.has(type)) decoded = date(value);
  else if (type === "relation") decoded = relation(value);
  else if (type === "rollup") decoded = rollup(value);
  else if (type === "formula") {
    decoded = formula(value);
    if (decoded && byteLength(decoded.expression) > databaseLimits.maxFormulaBytes)
      return yield* new C.SpaceLimitExceededError({
        limit: "databases.maxFormulaBytes",
        actual: byteLength(decoded.expression),
        maximum: databaseLimits.maxFormulaBytes,
      });
  } else decoded = uniqueId(value);
  if (decoded === undefined) return yield* bad();
  return decoded;
});
