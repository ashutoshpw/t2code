import { RegistryContext } from "@effect/atom-react";
import type { SpaceDataSource, SpaceRelatedPage } from "@t2code/contracts/spaces";
import { useContext, useEffect, useState } from "react";

import { databasePorts } from "../data/ports";
import { useDatabase } from "../shell/context";
import { viewerTimeZone } from "./formulaText";
import type { PreviewRow } from "./preview";

export interface SampleRow {
  readonly row: PreviewRow;
  readonly relatedPages: Readonly<Record<string, SpaceRelatedPage>>;
}

/** The first row of a data source, fetched once when the editor opens, for the result preview. */
export function useSampleRow(dataSource: SpaceDataSource): SampleRow | null {
  const registry = useContext(RegistryContext);
  const { model } = useDatabase();
  const [sample, setSample] = useState<SampleRow | null>(null);
  const dataSourceId = dataSource.id;
  const propertyIds = Object.keys(dataSource.properties).join(",");
  const environmentId = model.environmentId;
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Fetch one row from the server for the result preview; it is external data, asked again only when the schema changes.
  useEffect(() => {
    let current = true;
    void databasePorts
      .query(registry, {
        environmentId,
        dataSourceId,
        filter: null,
        sorts: [],
        group: null,
        subGroup: null,
        mode: "rows",
        properties: propertyIds.split(",") as never,
        limit: 1,
        timeZone: viewerTimeZone(),
      })
      .then(
        (result) => {
          const first = result.rows[0];
          if (current && first !== undefined)
            setSample({
              row: { id: first.page.id, title: first.page.title, cells: first.cells },
              relatedPages: result.relatedPages,
            });
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [registry, environmentId, dataSourceId, propertyIds]);
  return sample;
}
