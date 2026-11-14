import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";

import { boot } from "./Spaces.testkit.ts";
import { databaseKit, pid } from "./Databases.testkit.ts";

export const ids = {
  est: pid("est001"),
  done: pid("done01"),
  due: pid("due001"),
  tag: pid("tag001"),
  note: pid("note01"),
  project: pid("proj01"),
  tasksOf: pid("tsk001"),
  double: pid("dbl001"),
  total: pid("tot001"),
};
export const tags = { red: C.SpaceOptionId.make("red01"), blue: C.SpaceOptionId.make("blue1") };

export const numberValue = (value: number) => ({ type: "number", value });
export const stringValue = (value: string) => ({ type: "string", value });

/** Projects (P1, P2) and Tasks (T1, T2 in P1; T3 in P2) in one database, two-way related. */
export const setupWork = Effect.fn("DatabaseComputedTest.setup")(function* () {
  const { service, common, page } = yield* boot();
  const kit = databaseKit(service, common, page.spaceId);
  const created = yield* kit.create("Work", { appendToPageId: page.id });
  const projects = created.dataSourceId;
  const tasks = (yield* service.createDataSource({
    ...common,
    mutationId: "tasks-source",
    databaseId: created.databaseId,
    name: "Tasks",
  })).dataSourceId;
  yield* kit.schema(tasks, [
    { op: "addProperty", property: { id: ids.est, name: "Estimate", type: "number" } },
    { op: "addProperty", property: { id: ids.done, name: "Done", type: "checkbox" } },
    { op: "addProperty", property: { id: ids.due, name: "Due", type: "date" } },
    {
      op: "addProperty",
      property: {
        id: ids.tag,
        name: "Tag",
        type: "select",
        options: [
          { id: tags.red, name: "Red", color: "red" },
          { id: tags.blue, name: "Blue", color: "blue" },
        ],
      },
    },
    { op: "addProperty", property: { id: ids.note, name: "Note", type: "text" } },
    {
      op: "addProperty",
      property: {
        id: ids.project,
        name: "Project",
        type: "relation",
        config: { dataSourceId: projects, limit: "many", twoWay: { propertyId: ids.tasksOf } },
      },
    },
  ]);
  const p = (yield* kit.addRows(projects, [{ title: "P1" }, { title: "P2" }])).rows.map(
    (row) => row.pageId,
  );
  const t = (yield* kit.addRows(tasks, [
    {
      title: "T1",
      cells: {
        [ids.est]: 3,
        [ids.done]: true,
        [ids.due]: { start: "2026-11-05" },
        [ids.project]: [p[0]!],
      },
    },
    { title: "T2", cells: { [ids.est]: 4, [ids.project]: [p[0]!], [ids.tag]: tags.red } },
    { title: "T3", cells: { [ids.est]: 5, [ids.project]: [p[1]!] } },
  ])).rows.map((row) => row.pageId);
  const addComputed = (
    dataSourceId: C.SpaceDataSourceId,
    id: string,
    name: string,
    type: "formula" | "rollup",
    config: C.SpaceCellValue,
  ) =>
    kit.schema(dataSourceId, [
      { op: "addProperty", property: { id: pid(id), name, type, config } },
    ]);
  const cell = (pageId: C.SpacePageId, property: C.SpacePropertyId) =>
    Effect.map(kit.row(pageId), (read) => read.row.cells[property]);
  const property = Effect.fn("DatabaseComputedTest.property")(function* (
    dataSourceId: C.SpaceDataSourceId,
    id: string,
  ) {
    const got = yield* service.getDatabase({
      environmentId: common.environmentId,
      databaseId: created.databaseId,
    });
    return got.dataSources.find((source) => source.id === dataSourceId)!.properties[id]!;
  });
  return {
    service,
    common,
    page,
    kit,
    created,
    projects,
    tasks,
    p,
    t,
    addComputed,
    cell,
    property,
  };
});
