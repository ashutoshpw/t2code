// @effect-diagnostics nodeBuiltinImport:off -- the fingerprint is a platform SHA-256 digest.
import * as NodeCrypto from "node:crypto";

import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { byteLength, canonical, databaseLimits } from "../../CorePolicy.ts";
import { parseJson } from "../Json.ts";
import type { Compile, Effective, Fragment, KeyValue } from "./Types.ts";
import type { SortExpr } from "./Sort.ts";

const OPERATION = "databases.query";

const Payload = Schema.Struct({
  e: Schema.String,
  o: Schema.Literal(OPERATION),
  f: Schema.String,
  k: Schema.Array(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
  p: Schema.Finite,
  s: Schema.Finite,
});
const decodePayload = Schema.decodeUnknownOption(Payload);

export interface Position {
  readonly keys: readonly KeyValue[];
  readonly position: number;
  readonly seq: number;
}

/** What makes two windows of one query comparable; relative dates stay relative. */
export const fingerprint = (input: {
  readonly dataSourceId: string;
  readonly effective: Effective;
  readonly c: Compile;
}) => {
  const { effective: e, c } = input;
  const scoped = e.scope.group !== undefined || e.scope.subGroup !== undefined;
  const body = canonical({
    dataSourceId: input.dataSourceId,
    filters: e.filters,
    search: e.search,
    sorts: e.sorts,
    sortTypes: e.sorts.map((sort) => c.snapshot.byId.get(sort.property)?.type ?? null),
    scope: e.scope,
    groups: scoped ? [e.group?.source ?? null, e.subGroup?.source ?? null] : null,
  });
  return NodeCrypto.createHash("sha256").update(body).digest("hex");
};

export const encode = Effect.fn("SpacesDatabases.encodeCursor")(function* (
  environmentId: string,
  print: string,
  at: Position,
) {
  const cursor = Buffer.from(
    canonical({ e: environmentId, o: OPERATION, f: print, k: at.keys, p: at.position, s: at.seq }),
  ).toString("base64url");
  if (byteLength(cursor) > databaseLimits.maxCursorBytes)
    return yield* new C.SpaceLimitExceededError({
      limit: "databases.maxCursorBytes",
      actual: byteLength(cursor),
      maximum: databaseLimits.maxCursorBytes,
    });
  return C.SpaceCursor.make(cursor);
});

/** A cursor for this environment and operation; a changed query definition is stale, not invalid. */
export const decode = Effect.fn("SpacesDatabases.decodeCursor")(function* (
  cursor: C.SpaceCursor,
  environmentId: string,
  print: string,
  sortKeys: number,
  dataRevision: number,
) {
  const invalid = () => new C.SpaceValidationError({ reason: "invalid_cursor" });
  if (cursor.length > databaseLimits.maxCursorBytes) return yield* invalid();
  const parsed = yield* Effect.try({
    try: () => decodePayload(parseJson(Buffer.from(cursor, "base64url").toString("utf8"))),
    catch: invalid,
  });
  if (parsed._tag === "None" || parsed.value.e !== environmentId) return yield* invalid();
  if (parsed.value.f !== print)
    return yield* new C.SpaceCursorStaleError({ revision: dataRevision });
  if (parsed.value.k.length !== sortKeys) return yield* invalid();
  return { keys: parsed.value.k, position: parsed.value.p, seq: parsed.value.s } satisfies Position;
});

/** Rows strictly after `at` in the query's order (section 4.8); empty values sort last. */
export const after = (
  c: Compile,
  keys: readonly SortExpr[],
  at: Position,
  alias: { readonly position: Fragment; readonly seq: Fragment },
): Fragment => {
  const { sql } = c;
  const exprs: { expr: Fragment; descending: boolean; value: KeyValue }[] = [
    ...keys.map((key, i) => ({ ...key, value: at.keys[i] ?? null })),
    { expr: alias.position, descending: false, value: at.position },
    { expr: alias.seq, descending: false, value: at.seq },
  ];
  const branches = exprs.map((key, i) => {
    const equal = exprs.slice(0, i).map((prior) => sql`${prior.expr} IS ${prior.value}`);
    const later =
      key.value === null
        ? sql`0`
        : key.descending
          ? sql`(${key.expr} < ${key.value} OR ${key.expr} IS NULL)`
          : sql`(${key.expr} > ${key.value} OR ${key.expr} IS NULL)`;
    return sql`(${sql.and([...equal, later])})`;
  });
  return sql`(${sql.or(branches)})`;
};
