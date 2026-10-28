import * as Context from "effect/Context";
import type * as SqlClient from "effect/sql/SqlClient";

export class SpacesSql extends Context.Service<SpacesSql, SqlClient.SqlClient>()(
  "@t2code/cli/spaces/SpacesSql",
) {}
