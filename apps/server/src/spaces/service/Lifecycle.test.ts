import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Settings from "../../serverSettings.ts";
import * as SpacesService from "../SpacesService.ts";
import { environmentId, env, identity, fixture } from "./Spaces.testkit.ts";

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect(
    "never opens disabled storage, gates every operation, and retains data over disable/re-enable",
    () =>
      fixture(
        (dbPath) =>
          Effect.gen(function* () {
            const service = yield* SpacesService.SpacesService;
            const settings = yield* Settings.ServerSettingsService;
            const fs = yield* FileSystem.FileSystem;
            assert.isNull(yield* service.getCapability(environmentId));
            const operations: ReadonlyArray<
              (raw: unknown) => Effect.Effect<unknown, C.SpaceServiceError>
            > = [
              service.search,
              service.listSpaces,
              service.listPages,
              service.getPage,
              service.readBlocks,
              service.createSpace,
              service.renameSpace,
              service.setDefaultSpace,
              service.createPage,
              service.updatePage,
              service.applyBlockBatch,
              service.lookupMutationReceipt,
              service.createChildPage,
              service.movePage,
              service.inspectStructure,
              service.moveBlocks,
              service.resolveReference,
              service.trashPage,
              service.restorePage,
              service.permanentlyDeletePage,
              service.listTrash,
            ];
            for (const operation of operations) {
              assert.equal(
                yield* operation({}).pipe(
                  Effect.match({
                    onFailure: (error) => error._tag,
                    onSuccess: () => "unexpected success",
                  }),
                ),
                "SpacesDisabledError",
              );
            }
            assert.isFalse(yield* fs.exists(dbPath));
            yield* settings.updateSettings({ spacesEnabled: true });
            assert.equal(
              (yield* Effect.flip(service.listSpaces({ environmentId: "another" })))._tag,
              "SpaceEnvironmentMismatchError",
            );
            assert.isFalse(yield* fs.exists(dbPath));
            const library = yield* service.listSpaces(env);
            const saved = yield* service.createSpace({
              ...env,
              receiptEpoch: library.mutationAdmission.epoch,
              mutationId: "create",
              title: "Retained",
            });
            yield* settings.updateSettings({ spacesEnabled: false });
            assert.isNull(yield* service.getCapability(environmentId));
            assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
            yield* settings.updateSettings({ spacesEnabled: true });
            const again = yield* service.listSpaces(env);
            assert.isTrue(
              again.items.some(
                (space) => space.id === saved.space.id && space.title === "Retained",
              ),
            );
            assert.equal((yield* service.getCapability(environmentId))?.version, 2);
            assert.isTrue(Option.isNone(yield* Effect.serviceOption(SqlClient.SqlClient)));
          }),
        false,
      ),
  );

  it.effect("initialization failure is typed and leaves disabled startup usable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-unavailable-" });
      const obstacle = path.join(directory, "file");
      yield* fs.writeFileString(obstacle, "not a directory");
      yield* Effect.gen(function* () {
        const service = yield* SpacesService.SpacesService;
        const settings = yield* Settings.ServerSettingsService;
        assert.isNull(yield* service.getCapability(environmentId));
        yield* settings.updateSettings({ spacesEnabled: true });
        assert.isNull(yield* service.getCapability(environmentId));
        const failure = yield* Effect.flip(service.listSpaces(env));
        assert.equal(failure._tag, "SpacesUnavailableError");
        if (failure._tag === "SpacesUnavailableError") assert.equal(failure.stage, "initializing");
        yield* settings.updateSettings({ spacesEnabled: false });
        assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
      }).pipe(
        Effect.provide(
          SpacesService.layerFromPath(path.join(obstacle, "spaces.sqlite")).pipe(
            Layer.provide(identity),
            Layer.provideMerge(Settings.layerTest()),
          ),
        ),
      );
      assert.equal(yield* fs.readFileString(obstacle), "not a directory");
    }),
  );

  it.effect(
    "keeps admitted writes alive across disable and owns lazy storage until the layer closes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "spaces-admission-" });
        const dbPath = path.join(directory, "spaces.sqlite");
        const accepted = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const settingsContext = yield* Layer.build(Settings.layerTest({ spacesEnabled: true }));
        const settings = Context.get(settingsContext, Settings.ServerSettingsService);
        const pauseIdentity = yield* Ref.make(false);
        const waitIdentity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Ref.get(pauseIdentity).pipe(
            Effect.flatMap((pause) =>
              pause
                ? Deferred.succeed(accepted, undefined).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                    Effect.as(environmentId),
                  )
                : Effect.succeed(environmentId),
            ),
          ),
        });
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          yield* Ref.set(pauseIdentity, true);
          const fiber = yield* service
            .createSpace({
              ...env,
              receiptEpoch: library.mutationAdmission.epoch,
              mutationId: "accepted",
              title: "Accepted before disable",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(accepted);
          yield* settings.updateSettings({ spacesEnabled: false });
          yield* Deferred.succeed(proceed, undefined);
          const saved = yield* Fiber.join(fiber);
          assert.equal(saved.space.title, "Accepted before disable");
          assert.equal((yield* Effect.flip(service.listSpaces(env)))._tag, "SpacesDisabledError");
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(waitIdentity),
              Layer.provide(Layer.succeedContext(settingsContext)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          assert.isTrue(library.items.some((space) => space.title === "Accepted before disable"));
        }).pipe(
          Effect.provide(
            SpacesService.layerFromPath(dbPath).pipe(
              Layer.provide(identity),
              Layer.provide(Settings.layerTest({ spacesEnabled: true })),
            ),
          ),
        );
      }),
  );
});
