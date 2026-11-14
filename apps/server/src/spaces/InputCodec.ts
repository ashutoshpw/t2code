import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import { canonical } from "./CorePolicy.ts";

const invalidPayload = () =>
  new SchemaIssue.InvalidValue({ message: "Invalid Spaces RPC payload." });

// Unknown sees original intent before Struct can strip fields; errors never retain the offending payload.
export const strictSpacePayload = <S extends Schema.Top>(
  schema: S,
  envelope: (raw: unknown) => unknown = (raw) => raw,
  advertised = false,
) => {
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" });
  const document = advertised
    ? Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
    : undefined;
  // Advertise the contract while the decoder still sees every original key before Struct projection.
  const raw = document
    ? Schema.Record(Schema.String, Schema.Unknown).check(
        Schema.makeFilter(() => true, {
          toJsonSchema: () => [{ ...document.schema, $defs: document.definitions }, true],
        }),
      )
    : Schema.Unknown;
  return raw.pipe(
    Schema.decodeTo(Schema.toType(schema), {
      decode: SchemaGetter.transformEffect((raw: unknown) =>
        Effect.try({
          try: () => {
            canonical(envelope(raw));
            return raw;
          },
          catch: invalidPayload,
        }).pipe(Effect.flatMap(decode), Effect.mapError(invalidPayload)),
      ),
      encode: SchemaGetter.transform((value) => value),
    }),
  );
};
