import * as Effect from "effect/Effect";

import * as SpacesSql from "../SpacesSql.ts";

export default Effect.gen(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`
    CREATE TABLE spaces (
      space_id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      root_order_revision INTEGER NOT NULL DEFAULT 0 CHECK (root_order_revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX spaces_one_default ON spaces (is_default) WHERE is_default = 1`;
  yield* sql`
    CREATE TRIGGER spaces_keep_default BEFORE DELETE ON spaces WHEN OLD.is_default = 1
    BEGIN
      SELECT RAISE(ABORT, 'The default space cannot be deleted.');
    END
  `;
  yield* sql`
    INSERT INTO spaces (space_id, title, is_default, created_at, updated_at)
    VALUES ('default', 'My space', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
});
