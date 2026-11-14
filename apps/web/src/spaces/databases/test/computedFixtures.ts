import type { SpaceDataSource, SpaceDatabaseRow } from "@t2code/contracts/spaces";

import { EditableFakeDatabase } from "../controls/controlsFake";
import { fixtureDataSource, fixtureRows, fixtureView } from "./fixtures";

/** The fixture data source plus a formula "Double" = Amount * 2, over rows with Amount 5 and 10. */
export function computedFake(
  options: {
    readonly expression?: string;
    readonly extra?: Readonly<Record<string, unknown>>;
    readonly computedPending?: number;
    readonly listLimit?: number;
    readonly others?: ConstructorParameters<typeof EditableFakeDatabase>[0] extends infer O
      ? O extends { others?: infer T }
        ? T
        : never
      : never;
  } = {},
) {
  const base = fixtureDataSource();
  const dataSource = {
    ...base,
    properties: {
      ...base.properties,
      dbl: {
        id: "dbl",
        name: "Double",
        type: "formula",
        config: { expression: options.expression ?? 'prop("Amount") * 2' },
        position: 7,
      },
      ...options.extra,
    },
  } as unknown as SpaceDataSource;
  const rows = fixtureRows(2).map(
    (row, index) =>
      ({ ...row, cells: { ...row.cells, amount: (index + 1) * 5 } }) as SpaceDatabaseRow,
  );
  const view = fixtureView("view-table", "table", "Table", 0);
  const fake = new EditableFakeDatabase({
    dataSource,
    rowData: rows,
    views: [
      {
        ...view,
        properties: [...view.properties, { propertyId: "dbl", visible: true }],
      } as never,
    ],
    ...(options.others === undefined ? {} : { others: options.others }),
    ...(options.listLimit === undefined ? {} : { listLimit: options.listLimit }),
    ...(options.computedPending === undefined ? {} : { computedPending: options.computedPending }),
  });
  fake.recomputeFormulas();
  return fake;
}
