import type * as C from "@t2code/contracts/spaces";

import type { Property } from "../SchemaStore.ts";
import { hasCell } from "./Cells.ts";
import type { Compile, Fragment } from "./Types.ts";

/** One ORDER BY key; a sort can yield more than one (status sorts by group, then option). */
export interface SortExpr {
  readonly expr: Fragment;
  readonly descending: boolean;
}

/** The first cell of the property in `ord` order, as one scalar. */
const firstCell = (c: Compile, property: Property, column: Fragment, extra?: Fragment) =>
  c.sql`(SELECT ${column} FROM spaces_db_cells c ${extra ?? c.sql``}
    WHERE c.page_id = p.page_id AND c.property_id = ${property.id} ORDER BY c.ord LIMIT 1)`;

const optionJoin = (c: Compile) =>
  c.sql`JOIN spaces_db_options o ON o.data_source_id = c.data_source_id
    AND o.property_id = c.property_id AND o.option_id = c.ref`;

/** Section 4.4: the sort value of each type; an empty value is NULL and sorts last. */
const valueExprs = (c: Compile, property: Property): readonly Fragment[] => {
  const { sql } = c;
  switch (property.type) {
    case "number":
      return [firstCell(c, property, sql`c.num`)];
    case "unique_id":
      return [sql`p.row_seq`];
    case "checkbox":
      return [sql`CASE WHEN ${hasCell(sql, property.id)} THEN 1 ELSE 0 END`];
    case "select":
    case "multi_select":
      return [firstCell(c, property, sql`o.position`, optionJoin(c))];
    case "status":
      return [
        firstCell(
          c,
          property,
          sql`CASE o.status_group WHEN 'todo' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END`,
          optionJoin(c),
        ),
        firstCell(c, property, sql`o.position`, optionJoin(c)),
      ];
    case "date":
      return [firstCell(c, property, sql`c.time_start`)];
    case "created_time":
      return [sql`p.created_at`];
    case "last_edited_time":
      return [sql`p.updated_at`];
    case "relation":
      return [
        sql`(SELECT tc.text_key FROM spaces_db_cells c
          JOIN spaces_pages t ON t.page_id = c.ref AND t.trash_batch_id IS NULL
          LEFT JOIN spaces_db_cells tc ON tc.page_id = t.page_id AND tc.property_id = 'title'
          WHERE c.page_id = p.page_id AND c.property_id = ${property.id} ORDER BY c.ord LIMIT 1)`,
      ];
    default:
      return [firstCell(c, property, sql`c.text_key`)];
  }
};

export const sortExprs = (c: Compile, sorts: readonly C.SpaceKnownSort[]) =>
  sorts.flatMap((sort): SortExpr[] => {
    const property = c.snapshot.byId.get(sort.property)!;
    return valueExprs(c, property).map((expr) => ({
      expr,
      descending: sort.direction === "descending",
    }));
  });

/** `ORDER BY` for selected key columns `k0..kn`: empty last in both directions, then manual order. */
export const orderBy = (c: Compile, keys: readonly SortExpr[], prefix: "p." | "" = "p.") => {
  const { sql } = c;
  const parts = keys.flatMap((key, i) => [
    sql`(${sql.literal(`k${i}`)} IS NULL)`,
    key.descending ? sql`${sql.literal(`k${i}`)} DESC` : sql`${sql.literal(`k${i}`)}`,
  ]);
  return sql.csv([...parts, sql.literal(`${prefix}row_position`), sql.literal(`${prefix}row_seq`)]);
};
