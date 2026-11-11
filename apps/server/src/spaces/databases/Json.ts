import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type Json = Schema.Json;
export type JsonObject = { readonly [key: string]: Json };

export const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A strict decode: unknown keys are a failure, never silently dropped. */
export const strictOption = <S extends Schema.Decoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" });
  return (value: unknown) => Option.getOrUndefined(decode(value)) as S["Type"] | undefined;
};
