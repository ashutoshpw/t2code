// @effect-diagnostics nodeBuiltinImport:off -- ids use the platform cryptographic generator.
import * as NodeCrypto from "node:crypto";

import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const clientIdPattern = /^[a-z0-9]{4,12}$/;

/** Allocates a server id and registers it in `spaces_ids`. */
export const register = Effect.fn("SpacesDatabases.registerId")(function* (
  kind: "database" | "data_source" | "view" | "page",
) {
  const sql = yield* SpacesSql.SpacesSql;
  const id = NodeCrypto.randomUUID();
  yield* sql`INSERT INTO spaces_ids (id, kind) VALUES (${id}, ${kind})`;
  return id;
});

/** A fresh block id; `BlockStore.apply` registers it with the insert. */
export const newBlockId = () => NodeCrypto.randomUUID();

export const retire = Effect.fn("SpacesDatabases.retireId")(function* (id: string) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_ids SET deleted = 1 WHERE id = ${id}`;
});

/** A short id that is not in `taken`. */
export function shortId(taken: ReadonlySet<string>) {
  for (;;) {
    const bytes = NodeCrypto.randomBytes(6);
    const id = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
    if (!taken.has(id) && id !== C.SPACE_TITLE_PROPERTY_ID) return id;
  }
}
