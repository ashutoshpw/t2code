import { joins, keyExpr, orderExpr } from "./Group.ts";
import type { Plan } from "./Plan.ts";
import type { Fragment } from "./Types.ts";

/** How many group levels the filtered row set `f` carries: none, the group, group and sub-group. */
export type Levels = 0 | 1 | 2;

/**
 * `WITH f AS MATERIALIZED (...)`: the filtered rows, one line per cell item of each group property
 * (a row with no item is one line with a NULL key), optionally with the sort keys k0..kn.
 */
export const filteredRows = (plan: Plan, levels: Levels, withSort: boolean): Fragment => {
  const { sql } = plan.c;
  const { group, subGroup } = plan.e;
  const columns: Fragment[] = [
    sql`p.page_id AS page_id`,
    sql`p.row_position AS row_position`,
    sql`p.row_seq AS row_seq`,
  ];
  let from = sql`spaces_pages p`;
  if (withSort)
    plan.keys.forEach((key, i) => columns.push(sql`${key.expr} AS ${sql.literal(`k${i}`)}`));
  const levelsOf = [
    { spec: group, alias: "g0", key: "g", order: "go" },
    { spec: subGroup, alias: "g1", key: "sg", order: "so" },
  ] as const;
  for (const level of levelsOf.slice(0, levels)) {
    if (level.spec === undefined) continue;
    from = sql`${from} ${joins(plan.c, level.spec, level.alias)}`;
    columns.push(sql`${keyExpr(plan.c, level.spec, level.alias)} AS ${sql.literal(level.key)}`);
    columns.push(
      sql`${orderExpr(plan.c, level.spec, level.alias) ?? sql`NULL`} AS ${sql.literal(level.order)}`,
    );
  }
  return sql`WITH f AS MATERIALIZED (SELECT ${sql.csv(columns)} FROM ${from} WHERE ${plan.where})`;
};
