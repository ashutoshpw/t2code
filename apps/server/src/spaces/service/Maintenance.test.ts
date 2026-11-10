import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../../serverSettings.ts";
import * as SpacesService from "../SpacesService.ts";
import * as SpacesMigrations from "../Migrations.ts";
import * as SpacesSql from "../SpacesSql.ts";
import { env, identity, fixture, boot } from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces physical reclaim", (it) => {
  it.effect.each(["missing", "disabled", "foreign", "existing-unacquired"] as const)(
    "skips %s storage without acquisition or filesystem changes",
    (mode) =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const fs = yield* FileSystem.FileSystem;
          const settings = yield* Settings.ServerSettingsService;
          if (mode === "disabled") yield* settings.updateSettings({ spacesEnabled: false });
          if (mode === "foreign")
            yield* fs.writeFileString(dbPath, "foreign database, do not initialize");
          if (mode === "existing-unacquired")
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* SpacesMigrations.runMigrations().pipe(
                Effect.provideService(SpacesSql.SpacesSql, sql),
              );
            }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.scoped);
          const exists = yield* fs.exists(dbPath);
          const before = exists ? yield* fs.readFile(dbPath) : undefined;
          const statements: string[] = [];
          const observe: Statement.Transformer = (statement) => {
            statements.push(statement.compile()[0]);
            return Effect.succeed(statement);
          };
          yield* service.reclaimExistingStorage.pipe(
            Effect.provideService(Statement.CurrentTransformer, observe),
            Effect.withTracer(Tracer.nativeTracer),
          );
          assert.deepEqual(statements, []);
          assert.equal(yield* fs.exists(dbPath), exists);
          if (before) assert.deepEqual(yield* fs.readFile(dbPath), before);
          for (const suffix of ["-wal", "-shm", "-journal"])
            assert.isFalse(yield* fs.exists(`${dbPath}${suffix}`));
        }),
      ),
  );

  it.effect("skips a validated nonincremental Spaces database without converting it", () =>
    fixture((dbPath) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* SpacesMigrations.runMigrations().pipe(
            Effect.provideService(SpacesSql.SpacesSql, sql),
          );
          yield* sql`CREATE TABLE reclaim_churn(value BLOB)`;
          yield* sql`INSERT INTO reclaim_churn VALUES (zeroblob(1048576))`;
          yield* sql`DROP TABLE reclaim_churn`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })), Effect.scoped);
        const service = yield* SpacesService.SpacesService;
        yield* service.listSpaces(env);
        const read = Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return { mode: yield* sql`PRAGMA auto_vacuum`, free: yield* sql`PRAGMA freelist_count` };
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        const before = yield* read;
        assert.deepEqual(before.mode, [{ auto_vacuum: 0 }]);
        yield* service.reclaimExistingStorage;
        assert.deepEqual(yield* read, before);
        assert.isFalse((yield* service.maintainAssets)?.incrementalVacuumEnabled);
      }),
    ),
  );

  it.effect(
    "releases the writer between reclaim pages and observes disabling before another step",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, page } = yield* boot();
          const settings = yield* Settings.ServerSettingsService;
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE reclaim_churn(value BLOB)`;
            yield* sql`INSERT INTO reclaim_churn VALUES (zeroblob(1048576))`;
            yield* sql`DROP TABLE reclaim_churn`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const first = yield* Deferred.make<void>(),
            release = yield* Deferred.make<void>(),
            writerStarted = yield* Deferred.make<void>();
          let steps = 0;
          const observe: Statement.Transformer = (statement) =>
            Effect.gen(function* () {
              if (statement.compile()[0] === "PRAGMA incremental_vacuum(1)") {
                steps++;
                if (steps === 1) {
                  yield* Deferred.succeed(first, undefined);
                  yield* Deferred.await(release);
                }
              }
              return statement;
            });
          const reclaim = yield* service.reclaimExistingStorage.pipe(
            Effect.provideService(Statement.CurrentTransformer, observe),
            Effect.withTracer(Tracer.nativeTracer),
            Effect.forkScoped,
          );
          yield* Deferred.await(first);
          const writer = yield* Effect.gen(function* () {
            yield* Deferred.succeed(writerStarted, undefined);
            const saved = yield* service.updatePage({
              ...common,
              mutationId: "reclaim-writer",
              pageId: page.id,
              baseRevision: 0,
              title: "Concurrent writer",
            });
            assert.equal(saved.status, "saved");
            assert.isBelow(steps, 64);
            yield* settings.updateSettings({ spacesEnabled: false });
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(writerStarted);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(writer);
          yield* Fiber.join(reclaim);
          assert.equal(steps, 1);
          yield* service.reclaimExistingStorage;
          assert.equal(steps, 1);
          yield* settings.updateSettings({ spacesEnabled: true });
          assert.equal(
            (yield* service.getPage({ ...env, pageId: page.id })).page.title,
            "Concurrent writer",
          );
        }).pipe(Effect.scoped),
      ),
  );
});

it.layer(NodeServices.layer)("Spaces reclaim path isolation", (it) => {
  it.effect("does not create an absent parent directory for physical reclaim", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-reclaim-absent-" });
      const parent = path.join(root, "never-created");
      yield* SpacesService.SpacesService.pipe(
        Effect.flatMap((service) => service.reclaimExistingStorage),
        Effect.provide(
          SpacesService.layerFromPath(path.join(parent, "spaces.sqlite")).pipe(
            Layer.provide(identity),
            Layer.provide(Settings.layerTest({ spacesEnabled: true })),
          ),
        ),
      );
      assert.isFalse(yield* fs.exists(parent));
    }),
  );
});
