import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "../packages/contracts/src/index.ts";
import { SpaceBlockId } from "../packages/contracts/src/spaces.ts";
import {
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
} from "../packages/client-runtime/src/spaces/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { diskDatabase } from "../apps/mobile/src/persistence/mobile-database.test-support.ts";
import * as ServerEnvironment from "../apps/server/src/environment/ServerEnvironment.ts";
import * as ServerSettings from "../apps/server/src/serverSettings.ts";
import * as SpacesService from "../apps/server/src/spaces/SpacesService.ts";

const promiseRunner = Effect.fn("MobileDraftSessionTest.promiseRunner")(function* () {
  const requests = yield* Queue.unbounded();
  yield* Effect.forkScoped(
    Effect.forever(Queue.take(requests).pipe(Effect.flatMap(Effect.forkScoped))),
  );
  return (effect) =>
    new Promise((resolve, reject) => {
      const request = Effect.exit(effect).pipe(
        Effect.map((exit) => {
          if (Exit.isSuccess(exit)) resolve(exit.value);
          else reject(Cause.squash(exit.cause));
        }),
      );
      if (!Queue.offerUnsafe(requests, request)) reject(new Error("Test service scope closed"));
    });
});

it.effect(
  "recovers an actual service receipt after mobile SQLite restart without replaying it over a later generation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* diskDatabase();
        const environmentId = EnvironmentId.make("mobile-environment");
        const layer = SpacesService.layerFromPath(
          NodePath.join(NodePath.dirname(fixture.file), "spaces.sqlite"),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(environmentId),
              }),
              ServerSettings.layerTest({ spacesEnabled: true }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const run = yield* promiseRunner();
          const library = yield* service.listSpaces({ environmentId });
          const page = yield* service.createPage({
            environmentId,
            receiptEpoch: library.mutationAdmission.epoch,
            mutationId: "create-mobile-page",
            spaceId: library.defaultSpaceId,
            baseRootOrderRevision: 0,
            title: "Real mobile page",
          });
          if (page.status !== "saved") throw new Error("Expected a saved page");
          const key = { environmentId, pageId: page.page.id };
          const capability = yield* service.getCapability(environmentId);
          if (!capability) throw new Error("Expected Spaces capability");
          const limits = capability.limits;
          const first = yield* fixture.open();
          const committed = Promise.withResolvers();
          const loseReply = Promise.withResolvers();
          let applies = 0;
          let lookups = 0;
          function session(store, apply) {
            return new SpaceDocumentSession(key, {
              drafts: store,
              createMutationId: () => "actual-pending-mobile-intent",
              maxLoadedBlocks: 100,
              maxMutations: 100,
              adapter: createSpaceServiceSessionAdapter(key, {
                getPage: (input) => run(service.getPage(input)),
                limits: () => limits,
                applyBlockBatch: apply,
                lookupMutationReceipt: (input) => {
                  lookups++;
                  return run(service.lookupMutationReceipt(input));
                },
              }),
            });
          }
          const original = session(first.store, async (input) => {
            applies++;
            const result = await run(service.applyBlockBatch(input));
            committed.resolve(result);
            await loseReply.promise;
            throw new Error("The response was lost after the actual service committed");
          });
          const block = {
            id: SpaceBlockId.make("mobile-insert"),
            type: "paragraph",
            version: 1,
            parentId: null,
            order: "80000000000000000000000000000000",
            content: { runs: [{ text: "Sent generation", marks: [] }] },
          };
          const later = {
            ...block,
            content: { runs: [{ text: "Newer local generation", marks: [] }] },
          };
          const window = yield* service.readBlocks({ ...key, revision: page.page.revision });
          const retained = yield* Effect.promise(async () => {
            await original.hydrate(window);
            original.apply([{ kind: "insert", block }]);
            const saving = original.save();
            await committed.promise;
            original.apply([{ kind: "replace", block: later }]);
            loseReply.resolve();
            await expect(saving).rejects.toThrow("response was lost");
            const draft = await first.store.load(key);
            expect(draft).toMatchObject({
              generation: 2,
              baseRevision: page.page.revision,
              pending: {
                generation: 1,
                mutationId: "actual-pending-mobile-intent",
                receiptEpoch: library.mutationAdmission.epoch,
              },
              blocks: [later],
            });
            return draft;
          });
          const acknowledgement = yield* Effect.promise(() => committed.promise);
          if (acknowledgement.status !== "saved")
            throw new Error("Expected a real saved acknowledgement");
          yield* first.close;
          const reopened = yield* fixture.open();
          const recovered = session(reopened.store, async (input) => {
            applies++;
            return run(service.applyBlockBatch(input));
          });
          const current = yield* service.readBlocks({ ...key, revision: acknowledgement.revision });
          yield* Effect.promise(async () => {
            await recovered.hydrate(current);
            expect(recovered.getSnapshot().pending).toEqual(retained?.pending);
            await recovered.save();
            expect(applies).toBe(1);
            expect(lookups).toBe(1);
            expect(recovered.getSnapshot()).toMatchObject({
              baseRevision: acknowledgement.revision,
              generation: 2,
              pending: null,
              dirty: true,
              status: "draft",
              blocks: [later],
              memberIds: [block.id],
            });
            expect(await reopened.store.load(key)).toMatchObject({
              baseRevision: acknowledgement.revision,
              generation: 2,
              pending: null,
              blocks: [later],
              mutations: [{ kind: "replace", block: later }],
            });
          });
          const persisted = yield* service.readBlocks({
            ...key,
            revision: acknowledgement.revision,
          });
          expect(persisted.blocks).toEqual([block]);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
