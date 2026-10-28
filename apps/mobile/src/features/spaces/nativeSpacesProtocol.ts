import * as Schema from "effect/Schema";

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const styleFields = {
  bold: Schema.Boolean,
  italic: Schema.Boolean,
  code: Schema.Boolean,
  link: Schema.optionalKey(Schema.String),
};
export const SpacesNativeRun = Schema.Struct({ text: Schema.String, ...styleFields });
export type SpacesNativeRun = typeof SpacesNativeRun.Type;

export const SpacesNativeSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  revision: Offset,
  runs: Schema.Array(SpacesNativeRun),
  selection: Schema.Struct({ start: Offset, end: Offset }),
  composing: Schema.Boolean,
  typing: Schema.Struct(styleFields),
});
export type SpacesNativeSnapshot = typeof SpacesNativeSnapshot.Type;

export type SpacesNativeDocument = Omit<SpacesNativeSnapshot, "composing" | "typing">;
export type SpacesNativeMark = "bold" | "italic" | "code";

const decode = Schema.decodeUnknownSync(SpacesNativeSnapshot, { onExcessProperty: "error" });

function validBoundary(text: string, offset: number): boolean {
  return (
    offset <= text.length &&
    !(
      offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) &&
      /[\uDC00-\uDFFF]/.test(text.charAt(offset))
    )
  );
}

export function decodeSpacesNativeSnapshot(value: unknown): SpacesNativeSnapshot {
  const snapshot = decode(value);
  const text = snapshot.runs.map((run) => run.text).join("");
  if (
    snapshot.selection.end < snapshot.selection.start ||
    !validBoundary(text, snapshot.selection.start) ||
    !validBoundary(text, snapshot.selection.end)
  ) {
    throw new Error("Invalid native UTF-16 selection");
  }
  return snapshot;
}
