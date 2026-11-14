import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as SpacesService from "../SpacesService.ts";
import { boot, env, fixture } from "./Spaces.testkit.ts";
import { databaseKit, pid } from "./Databases.testkit.ts";
import { ids, setupWork } from "./DatabaseComputed.testkit.ts";

type Changed = Extract<C.SpaceDatabaseChangeEvent, { readonly type: "changed" }>;

// Pulled by hand, so each assertion sees exactly what the mailbox collected since the last pull.
const listen = Effect.fn("DatabaseChangesTest.listen")(function* (
  service: Effect.Success<ReturnType<typeof setupWork>>["service"],
) {
  const pull = yield* Stream.toPull(service.subscribeDatabaseChanges(env));
  assert.deepEqual(yield* pull, [{ type: "resync" }]);
  return Effect.map(pull, (events) =>
    events.filter((event): event is Changed => event.type === "changed"),
  );
});

const revisions = Effect.fn("DatabaseChangesTest.revisions")(function* (
  service: Effect.Success<ReturnType<typeof setupWork>>["service"],
  databaseId: C.SpaceDatabaseId,
) {
  const got = yield* service.getDatabase({ ...env, databaseId });
  return {
    database: got.database.revision,
    sources: new Map(
      got.dataSources.map((source) => [source.id, [source.schemaRevision, source.dataRevision]]),
    ),
  };
});

const sourceIds = (events: ReadonlyArray<Changed>) =>
  events.flatMap((event) => event.dataSources.map((source) => source.id)).toSorted();

it.layer(NodeServices.layer)("Spaces database change stream", (it) => {
  it.effect("publishes a cell edit once, with the revisions it committed and no row data", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, kit, tasks, created, t } = yield* setupWork();
          const next = yield* listen(service);
          yield* kit.setCells(tasks, t[0]!, { [ids.note]: [{ text: "secret", marks: [] }] });
          const events = yield* next;
          const after = yield* revisions(service, created.databaseId);
          assert.equal(events.length, 1);
          const [dataSource] = events[0]!.dataSources;
          assert.deepEqual(events[0]!.dataSources.length, 1);
          assert.equal(dataSource!.id, tasks);
          assert.deepEqual(
            [dataSource!.schemaRevision, dataSource!.dataRevision],
            after.sources.get(tasks),
          );
          assert.notInclude(JSON.stringify(events), "secret");
          // The next edit is a separate event, not a repeat of the first.
          yield* kit.setCells(tasks, t[1]!, { [ids.est]: 9 });
          const second = yield* next;
          assert.equal(second.length, 1);
          assert.equal(second[0]!.dataSources[0]!.dataRevision, dataSource!.dataRevision + 1);
        }),
      ),
    ),
  );

  it.effect("publishes a schema edit as its data source, and a database edit as its database", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, kit, tasks, created } = yield* setupWork();
          const next = yield* listen(service);
          yield* kit.schema(tasks, [
            { op: "addProperty", property: { id: pid("extra1"), name: "Extra", type: "text" } },
          ]);
          const events = yield* next;
          const after = yield* revisions(service, created.databaseId);
          assert.equal(events.length, 1);
          assert.deepEqual(sourceIds(events), [tasks]);
          assert.equal(events[0]!.dataSources[0]!.databaseId, created.databaseId);
          assert.equal(events[0]!.dataSources[0]!.schemaRevision, after.sources.get(tasks)![0]);
          yield* service.updateDatabase({
            ...kit.common,
            mutationId: kit.next("rename"),
            databaseId: created.databaseId,
            title: "Renamed",
          });
          const renamed = yield* next;
          assert.deepEqual(
            renamed.flatMap((event) => event.databases),
            [
              {
                id: created.databaseId,
                revision: (yield* revisions(service, created.databaseId)).database,
              },
            ],
          );
        }),
      ),
    ),
  );

  it.effect("publishes nothing for a failed mutation or a replayed receipt", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, common, kit, projects, tasks, t, p } = yield* setupWork();
          const next = yield* listen(service);
          const failed = yield* service
            .updateRows({
              ...common,
              mutationId: "bad-cell",
              dataSourceId: tasks,
              rows: [
                { pageId: t[0]!, cells: { [ids.est]: 77 } },
                { pageId: C.SpacePageId.make("missing"), cells: { [ids.est]: 1 } },
              ],
            })
            .pipe(Effect.result);
          assert.equal(failed._tag, "Failure");
          const replayed = {
            ...common,
            mutationId: C.SpaceMutationId.make("same"),
            dataSourceId: projects,
            rows: [{ pageId: p[0]!, cells: { title: "Renamed" } }],
          };
          yield* service.updateRows(replayed);
          assert.deepEqual(sourceIds(yield* next), [projects]);
          yield* service.updateRows(replayed);
          yield* kit.setCells(tasks, t[0]!, { [ids.est]: 8 });
          // Only the later write arrives: the failure and the replay left nothing behind.
          assert.deepEqual(sourceIds(yield* next), [tasks]);
        }),
      ),
    ),
  );

  it.effect("publishes the other data source when a rollup recomputes", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service, kit, projects, tasks, t, addComputed } = yield* setupWork();
          yield* addComputed(projects, "tot001", "Total", "rollup", {
            relationPropertyId: ids.tasksOf,
            targetPropertyId: ids.est,
            function: "sum",
          });
          const next = yield* listen(service);
          yield* kit.setCells(tasks, t[0]!, { [ids.est]: 100 });
          assert.deepEqual(sourceIds(yield* next), [projects, tasks].toSorted());
        }),
      ),
    ),
  );

  it.effect("publishes the result of a background drain batch", () =>
    fixture(
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { service, common, page } = yield* boot();
            const kit = databaseKit(service, common, page.spaceId);
            const created = yield* kit.create("Heavy", { appendToPageId: page.id });
            const source = created.dataSourceId;
            yield* kit.addRows(
              source,
              Array.from({ length: 90 }, (_, i) => ({ title: `row ${i}` })),
            );
            yield* kit.schema(source, [
              {
                op: "addProperty",
                property: {
                  id: pid("heavy1"),
                  name: "Heavy",
                  type: "formula",
                  config: { expression: 'replaceAll(repeat("abc def ", 500), "[a-z]+", "x")' },
                },
              },
            ]);
            const before = (yield* revisions(service, created.databaseId)).sources.get(source)![1]!;
            const next = yield* listen(service);
            yield* service.drainComputed;
            const events = yield* next;
            const after = (yield* revisions(service, created.databaseId)).sources.get(source)![1]!;
            assert.isAbove(after, before);
            assert.deepEqual(sourceIds(events), [source]);
            assert.equal(events.at(-1)!.dataSources[0]!.dataRevision, after);
          }),
        ),
      true,
      { backgroundDrain: false },
    ),
  );

  it.effect("refuses another environment and disabled Spaces before streaming anything", () =>
    fixture(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { service } = yield* setupWork();
          const wrong = yield* service
            .subscribeDatabaseChanges({ environmentId: EnvironmentId.make("elsewhere") })
            .pipe(Stream.runCollect, Effect.flip);
          assert.equal(wrong._tag, "SpaceEnvironmentMismatchError");
          const malformed = yield* service
            .subscribeDatabaseChanges({ ...env, extra: true })
            .pipe(Stream.runCollect, Effect.flip);
          assert.equal(malformed._tag, "SpaceValidationError");
        }),
      ),
    ),
  );

  it.effect("refuses a subscription while Spaces is disabled", () =>
    fixture(
      () =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const failure = yield* service
            .subscribeDatabaseChanges(env)
            .pipe(Stream.runCollect, Effect.flip);
          assert.equal(failure._tag, "SpacesDisabledError");
        }),
      false,
    ),
  );
});
