import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as BootService from "../cloud/bootService.ts";
import { runDoctor } from "./doctor.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import * as SpacesDatabaseTools from "../spaces/SpacesDatabaseTools.ts";
import * as SpacesSql from "../spaces/SpacesSql.ts";
import * as SpacesSqlite from "../spaces/Sqlite.ts";

it.effect(
  "--fix reclaims space with the service paused and keeps the V1 database, and --dry-run changes nothing",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const doctor = (dryRun: boolean) =>
        runDoctor("/test/statev2.sqlite", { fix: true, dryRun, interactive: false }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              SpacesDatabaseTools.layer.pipe(Layer.provide(NodeServices.layer)),
              Layer.mock(BootService.BootService)({
                withStopped: (operation) =>
                  Effect.sync(() => calls.push("pause")).pipe(
                    Effect.andThen(operation),
                    Effect.ensuring(Effect.sync(() => calls.push("resume"))),
                  ),
              }),
              Layer.succeed(DatabaseMaintenance.DatabaseMaintenance, {
                inspect: () =>
                  Effect.succeed({
                    databaseBytes: 2000,
                    reclaimableBytes: 1000,
                    incrementalVacuumEnabled: false,
                    legacyDatabaseBytes: 4000,
                  }),
                compact: () =>
                  Effect.sync(() => {
                    calls.push("compact");
                    return {
                      beforeBytes: 2000,
                      afterBytes: 1000,
                      deletedEventCount: 1,
                      deletedReceiptCount: 0,
                    };
                  }),
                removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
              }),
            ),
          ),
        );
      yield* doctor(true);
      assert.deepEqual(calls, []);
      yield* doctor(false);
      assert.deepEqual(calls, ["pause", "compact", "resume"]);
    }),
);

it.effect("doctor reports Spaces without creating chat or missing Spaces databases", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "doctor-spaces-" });
    const chatPath = path.join(directory, "statev2.sqlite");
    const spacesPath = path.join(directory, "spaces.sqlite");
    const messages: string[] = [];
    const console = yield* Console.Console;
    const inspect = runDoctor(chatPath, { fix: true, dryRun: false, interactive: false }).pipe(
      Effect.provideService(Console.Console, {
        ...console,
        log: (...args: readonly unknown[]) => messages.push(args.map(String).join(" ")),
      }),
    );
    yield* inspect;
    assert.include(messages, "Spaces database: not found.");
    assert.deepEqual(yield* fs.readDirectory(directory), []);

    yield* Effect.gen(function* () {
      const sql = yield* SpacesSql.SpacesSql;
      yield* sql`UPDATE spaces SET title = 'Keep Spaces' WHERE is_default = 1`;
    }).pipe(Effect.provide(SpacesSqlite.layerFromPath(spacesPath)));
    const before = yield* fs.readFile(spacesPath);
    messages.length = 0;
    yield* inspect;
    assert.include(messages, "Database: not found.");
    assert.isTrue(messages.some((line) => /^Spaces database: [1-9].*WAL.*reclaimable/.test(line)));
    assert.equal(Buffer.compare(yield* fs.readFile(spacesPath), before), 0);
    assert.isFalse(yield* fs.exists(chatPath));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DatabaseMaintenance.layer,
        SpacesDatabaseTools.layer,
        Layer.mock(BootService.BootService)({
          withStopped: () => Effect.die("Inspection must not pause a service or compact Spaces"),
        }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);
