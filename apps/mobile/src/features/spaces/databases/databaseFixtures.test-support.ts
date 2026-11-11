import type {
  SpaceCellValue,
  SpaceDataSource,
  SpaceDatabaseProperty,
  SpaceDatabaseRow,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";

/** Plain data builders for the pure database tests; ids are branded only where a type requires it. */
export const property = (
  id: string,
  name: string,
  type: string,
  config: SpaceDatabaseProperty["config"] = {},
  extra: Partial<SpaceDatabaseProperty> = {},
): SpaceDatabaseProperty => ({ id, name, type, config, position: 0, ...extra }) as never;

export function dataSource(
  properties: ReadonlyArray<SpaceDatabaseProperty>,
  id = "source1",
): SpaceDataSource {
  return {
    id,
    databaseId: "database1",
    name: "Tasks",
    position: 0,
    schemaRevision: 1,
    dataRevision: 1,
    properties: Object.fromEntries(
      properties.map((entry, position) => [entry.id, { ...entry, position }]),
    ),
    deletedProperties: [],
    templates: [],
  } as never;
}

export function view(
  type: string,
  options: {
    readonly visible?: ReadonlyArray<string>;
    readonly layout?: Record<string, unknown>;
    readonly filter?: unknown;
    readonly sorts?: ReadonlyArray<unknown>;
    readonly group?: unknown;
    readonly subGroup?: unknown;
    readonly id?: string;
  } = {},
): SpaceDatabaseView {
  return {
    id: options.id ?? `${type}-view`,
    databaseId: "database1",
    dataSourceId: "source1",
    name: type,
    type,
    position: 0,
    sorts: options.sorts ?? [],
    properties: (options.visible ?? []).map((propertyId) => ({ propertyId, visible: true })),
    layout: options.layout ?? {},
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.group === undefined ? {} : { group: options.group }),
    ...(options.subGroup === undefined ? {} : { subGroup: options.subGroup }),
  } as never;
}

export const row = (
  id: string,
  title: string,
  cells: Record<string, SpaceCellValue> = {},
): SpaceDatabaseRow =>
  ({
    page: { id, title, revision: 1, createdAt: "t", updatedAt: "t" },
    number: 1,
    cells: { title, ...cells },
  }) as never;
