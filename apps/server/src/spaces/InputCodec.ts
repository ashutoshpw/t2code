import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import { canonical } from "./CorePolicy.ts";

const invalidPayload = (location = "") =>
  new SchemaIssue.InvalidValue({
    message: `Invalid Spaces RPC payload${location === "" ? "" : ` at ${location}`}.`,
  });

type Candidate = { readonly path: ReadonlyArray<PropertyKey>; readonly score: number };
const unrelated: Candidate = { path: [], score: 0 };

// Longest path wins inside a union, which is the branch the input came closest to matching.
// A path that ends at an unexpected key loses ties: that branch just has no such field.
const deepestPath = (issue: SchemaIssue.Issue): Candidate => {
  switch (issue._tag) {
    case "Pointer": {
      const inner = deepestPath(issue.issue);
      return { path: [...issue.path, ...inner.path], score: inner.score + 2 * issue.path.length };
    }
    case "Filter":
    case "Encoding":
      return deepestPath(issue.issue);
    case "Composite":
    case "AnyOf":
      return issue.issues
        .map(deepestPath)
        .reduce((best, next) => (next.score > best.score ? next : best), unrelated);
    case "UnexpectedKey":
      return { path: [], score: -1 };
    default:
      return unrelated;
  }
};

// Names the field, never its value, so a rejected payload cannot echo what it carried.
const payloadLocation = (error: unknown) => {
  const issue = Predicate.hasProperty(error, "issue") ? error.issue : undefined;
  if (!SchemaIssue.isIssue(issue)) return "";
  return deepestPath(issue)
    .path.slice(0, 12)
    .map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key).slice(0, 48)}`))
    .join("")
    .replace(/^\./, "");
};

export type AdvertisedDocument = {
  readonly schema: { readonly [key: string]: unknown };
  readonly definitions: { readonly [key: string]: unknown };
};

// Unknown sees original intent before Struct can strip fields; errors never retain the offending payload.
export const strictSpacePayload = <S extends Schema.Top>(
  schema: S,
  envelope: (raw: unknown) => unknown = (raw) => raw,
  advertised: boolean | ((document: AdvertisedDocument) => AdvertisedDocument) = false,
) => {
  const decode = Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" });
  const derived = advertised
    ? Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
    : undefined;
  // A reducer shrinks only what the model reads; decoding below always uses the full schema.
  const document =
    derived && typeof advertised === "function"
      ? advertised({ schema: derived.schema, definitions: derived.definitions })
      : derived;
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
          catch: () => invalidPayload(),
        }).pipe(
          Effect.flatMap(decode),
          Effect.mapError((error) => invalidPayload(payloadLocation(error))),
        ),
      ),
      encode: SchemaGetter.transform((value) => value),
    }),
  );
};
