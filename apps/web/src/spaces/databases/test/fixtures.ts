import type {
  SpaceDataSource,
  SpaceDatabase,
  SpaceDatabaseRow,
  SpaceDatabaseView,
} from "@t2code/contracts/spaces";

const iso = "2026-01-01T00:00:00.000Z";

export const FIXTURE_IDS = {
  environment: "environment-1",
  space: "space-1",
  database: "database-1",
  dataSource: "data-source-1",
  tableView: "view-table",
  boardView: "view-board",
} as const;

const STATUS_OPTIONS = [
  { id: "todo", name: "Not started", color: "gray", group: "todo" },
  { id: "doing", name: "In progress", color: "blue", group: "in_progress" },
  { id: "done", name: "Done", color: "green", group: "complete" },
] as const;
const TAG_OPTIONS = [
  { id: "bug", name: "Bug", color: "red" },
  { id: "idea", name: "Idea", color: "yellow" },
] as const;

const property = (id: string, name: string, type: string, position: number, config: unknown = {}) =>
  ({ id, name, type, config, position }) as unknown as SpaceDataSource["properties"][string];

/** A data source with one property of every common type. */
export function fixtureDataSource(): SpaceDataSource {
  return {
    id: FIXTURE_IDS.dataSource,
    databaseId: FIXTURE_IDS.database,
    name: "Tasks",
    position: 0,
    schemaRevision: 1,
    dataRevision: 1,
    properties: {
      title: property("title", "Name", "title", 0),
      status: property("status", "Status", "status", 1, {
        options: STATUS_OPTIONS,
        defaultOptionId: "todo",
      }),
      tags: property("tags", "Tags", "multi_select", 2, { options: TAG_OPTIONS }),
      due: property("due", "Due", "date", 3),
      done: property("done", "Done", "checkbox", 4),
      notes: property("notes", "Notes", "text", 5),
      amount: property("amount", "Amount", "number", 6, { format: "number" }),
    },
    deletedProperties: [],
    templates: [],
  } as unknown as SpaceDataSource;
}

export function fixtureView(
  id: string,
  type: "table" | "board",
  name: string,
  position: number,
): SpaceDatabaseView {
  return {
    id,
    databaseId: FIXTURE_IDS.database,
    dataSourceId: FIXTURE_IDS.dataSource,
    name,
    type,
    position,
    sorts: [],
    ...(type === "board" ? { group: { property: "status" } } : {}),
    properties: ["title", "status", "tags", "due", "done", "notes", "amount"].map((propertyId) => ({
      propertyId,
      visible: true,
    })),
    layout: {},
  } as unknown as SpaceDatabaseView;
}

export function fixtureDatabase(live = true): SpaceDatabase {
  return {
    id: FIXTURE_IDS.database,
    spaceId: FIXTURE_IDS.space,
    title: "Tasks",
    revision: 1,
    home: { pageId: "page-1", blockId: "block-1" },
    live,
    createdAt: iso,
    updatedAt: iso,
  } as unknown as SpaceDatabase;
}

export function fixtureRows(count: number): SpaceDatabaseRow[] {
  return Array.from({ length: count }, (_, index) => {
    const title = `Task ${index + 1}`;
    return {
      page: {
        id: `row-${index + 1}`,
        title,
        revision: 1,
        createdAt: iso,
        updatedAt: iso,
      },
      number: index + 1,
      cells: {
        title,
        status: STATUS_OPTIONS[index % STATUS_OPTIONS.length]!.id,
        done: index % 2 === 0,
      },
    } as unknown as SpaceDatabaseRow;
  });
}
