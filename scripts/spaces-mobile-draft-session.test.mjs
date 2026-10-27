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

import { MobileSpaceEditing } from "../apps/mobile/src/features/spaces/editing.ts";
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
  "publishes rich native edits to mobile SQLite and recovers the actual receipt without losing later input",
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
          let nextRequest = 0;
          let applies = 0;
          let admissions = 0;
          let availability = "writable";
          let discardReads = 0;
          let lookups = 0;
          function session(store, apply) {
            return new SpaceDocumentSession(key, {
              drafts: store,
              createMutationId: () => `native-request-${++nextRequest}`,
              maxLoadedBlocks: 100,
              maxMutations: 100,
              adapter: createSpaceServiceSessionAdapter(key, {
                getPage: (input) => {
                  admissions++;
                  return run(service.getPage(input));
                },
                limits: () => limits,
                applyBlockBatch: apply,
                lookupMutationReceipt: (input) => {
                  lookups++;
                  return run(service.lookupMutationReceipt(input));
                },
              }),
            });
          }
          const marks = [
            { type: "bold", version: 1 },
            { type: "italic", version: 1 },
            { type: "code", version: 1 },
            { type: "link", version: 1, href: "https://t2.codes/native" },
          ];
          const block = {
            id: SpaceBlockId.make("native-heading"),
            type: "heading",
            version: 1,
            parentId: null,
            order: "20000000000000000000000000000000",
            content: { level: 2, runs: [{ text: "Initial😀", marks }] },
          };
          const todo = {
            id: SpaceBlockId.make("native-todo"),
            type: "todo_item",
            version: 1,
            parentId: null,
            order: "40000000000000000000000000000000",
            content: { checked: false, runs: [{ text: "Keep task", marks: [] }] },
          };
          const code = {
            id: SpaceBlockId.make("readonly-code"),
            type: "code",
            version: 1,
            parentId: null,
            order: "60000000000000000000000000000000",
            content: { language: "ts", text: "const untouched = true;" },
          };
          const hidden = {
            ...block,
            id: SpaceBlockId.make("unloaded"),
            order: "80000000000000000000000000000000",
          };
          const seeded = yield* service.applyBlockBatch({
            ...key,
            mutationId: "seed-native-blocks",
            receiptEpoch: library.mutationAdmission.epoch,
            baseRevision: page.page.revision,
            generation: 1,
            mutations: [block, todo, code, hidden].map((value) => ({
              kind: "insert",
              block: value,
            })),
          });
          if (seeded.status !== "saved") throw new Error("Expected saved seed");
          const window = yield* service.readBlocks({ ...key, revision: seeded.revision, limit: 3 });
          expect(window.nextCursor).not.toBeNull();
          function controller(document) {
            return new MobileSpaceEditing({
              session: document,
              access: () => ({ availability, capability, current: () => true }),
              readWindow: async () => {
                discardReads++;
                const current = await run(service.getPage(key));
                return run(
                  service.readBlocks({ ...key, revision: current.page.revision, limit: 3 }),
                );
              },
            });
          }
          function native(text, revision) {
            return {
              version: 1,
              revision,
              composing: false,
              selection: { start: 0, end: 0 },
              runs: [
                { text, bold: true, italic: true, code: true, link: "https://t2.codes/native" },
              ],
              typing: { bold: true, italic: true, code: true, link: "https://t2.codes/native" },
            };
          }
          const sent = { ...block, content: { level: 2, runs: [{ text: "Sent😀", marks }] } };
          const later = {
            ...block,
            content: { level: 2, runs: [{ text: "Newer local😀", marks }] },
          };
          const original = session(first.store, async (input) => {
            applies++;
            expect(await first.store.load(key)).toMatchObject({
              pending: {
                generation: 1,
                mutationId: "native-request-1",
                receiptEpoch: library.mutationAdmission.epoch,
                baseRevision: seeded.revision,
                mutations: [{ kind: "replace", block: sent }],
              },
            });
            const result = await run(service.applyBlockBatch(input));
            committed.resolve(result);
            await loseReply.promise;
            throw new Error("The response was lost after the actual service committed");
          });
          const editing = controller(original);
          const owner = Symbol();
          const retained = yield* Effect.promise(async () => {
            await original.hydrate(window);
            const focus = editing.focus(owner, block.id);
            focus.publication.receive(native("Sent😀", 1), true);
            await editing.finish(owner, focus.token);
            const saving = editing.save();
            await committed.promise;
            const laterFocus = editing.focus(owner, block.id);
            laterFocus.publication.receive(native("Newer local😀", 1), true);
            loseReply.resolve();
            await saving;
            expect(editing.getSnapshot().error).toContain("response was lost");
            await editing.discardInput(owner, laterFocus.token);
            expect(editing.getSnapshot().error).toContain("pending receipt");
            expect(editing.getSnapshot().focus?.token).toBe(laterFocus.token);
            await editing.finish(owner, laterFocus.token);
            await editing.discard();
            expect(editing.getSnapshot().error).toContain("pending receipt");
            expect(discardReads).toBe(0);
            const draft = await first.store.load(key);
            expect(draft).toMatchObject({
              generation: 2,
              baseRevision: seeded.revision,
              pending: {
                generation: 1,
                mutationId: "native-request-1",
                receiptEpoch: library.mutationAdmission.epoch,
              },
              blocks: [later, todo, code],
            });
            return draft;
          });
          const acknowledgement = yield* Effect.promise(() => committed.promise);
          if (acknowledgement.status !== "saved")
            throw new Error("Expected a real saved acknowledgement");
          yield* first.close;
          const reopened = yield* fixture.open();
          const conflictReady = Promise.withResolvers();
          const conflictReply = Promise.withResolvers();
          const recovered = session(reopened.store, async (input) => {
            applies++;
            const result = await run(service.applyBlockBatch(input));
            if (result.status === "conflict") {
              conflictReady.resolve();
              await conflictReply.promise;
            }
            return result;
          });
          const current = yield* service.readBlocks({
            ...key,
            revision: acknowledgement.revision,
            limit: 3,
          });
          const recoveredEditing = controller(recovered);
          yield* Effect.promise(async () => {
            await recovered.hydrate(current);
            expect(recovered.getSnapshot().pending).toEqual(retained?.pending);
            await recoveredEditing.save();
            expect(recoveredEditing.getSnapshot().error).toBeNull();
            expect(applies).toBe(1);
            expect(lookups).toBe(1);
            expect(admissions).toBe(1);
            expect(recovered.getSnapshot()).toMatchObject({
              baseRevision: acknowledgement.revision,
              generation: 2,
              pending: null,
              dirty: true,
              status: "draft",
              blocks: [later, todo, code],
              memberIds: [block.id, todo.id, code.id],
            });
            expect(await reopened.store.load(key)).toMatchObject({
              baseRevision: acknowledgement.revision,
              generation: 2,
              pending: null,
              blocks: [later, todo, code],
              mutations: [{ kind: "replace", block: later }],
            });
          });
          const persisted = yield* service.readBlocks({
            ...key,
            revision: acknowledgement.revision,
          });
          expect(persisted.blocks).toEqual([sent, todo, code, hidden]);
          availability = "read-only";
          expect(() => recoveredEditing.focus(Symbol(), block.id)).toThrow("permission");
          yield* Effect.promise(() => recoveredEditing.save());
          expect(recoveredEditing.getSnapshot().error).toContain("permission");
          expect(applies).toBe(1);
          expect(admissions).toBe(1);
          availability = "writable";
          expect(() => recoveredEditing.focus(Symbol(), code.id)).toThrow("read-only");
          recoveredEditing.toggleTodo(todo.id);
          yield* Effect.promise(() => recovered.persistDraft());
          const toggled = yield* Effect.promise(() => reopened.store.load(key));
          expect(toggled.blocks).toEqual([
            later,
            { ...todo, content: { ...todo.content, checked: true } },
            code,
          ]);
          expect(toggled.memberIds).toEqual([block.id, todo.id, code.id]);
          expect(toggled.mutations.map((value) => value.kind)).toEqual(["replace", "replace"]);
          expect(toggled.mutations.map((value) => value.block.id)).toEqual([block.id, todo.id]);
          fixture.control.beforeCommit = async () => {
            throw new Error("SQLite commit refused");
          };
          yield* Effect.promise(() => recoveredEditing.save());
          expect(recovered.getSnapshot().persistenceError).not.toBeNull();
          expect(recovered.getSnapshot().dirty).toBe(true);
          expect(applies).toBe(1);
          expect((yield* Effect.promise(() => reopened.store.load(key))).blocks).toEqual(
            toggled.blocks,
          );
          fixture.control.beforeCommit = null;
          yield* Effect.promise(() => recoveredEditing.retryPersistence());
          expect(recovered.getSnapshot().persistenceError).toBeNull();
          const remoteHidden = {
            ...hidden,
            content: {
              level: 2,
              runs: [{ text: "Remote change outside loaded membership", marks: [] }],
            },
          };
          const external = yield* service.applyBlockBatch({
            ...key,
            mutationId: "remote-change",
            receiptEpoch: library.mutationAdmission.epoch,
            baseRevision: acknowledgement.revision,
            generation: 1,
            mutations: [{ kind: "replace", block: remoteHidden }],
          });
          if (external.status !== "saved") throw new Error("Expected actual remote change");
          yield* Effect.promise(async () => {
            const saving = recoveredEditing.save();
            await conflictReady.promise;
            const input = recoveredEditing.focus(owner, block.id);
            input.publication.receive(
              { ...native("Unpublished composition", 1), composing: true },
              true,
            );
            conflictReply.resolve();
            await saving;
            expect(input.publication.getSnapshot().observed.composing).toBe(true);
            await recoveredEditing.discardInput(owner, input.token);
            expect(recoveredEditing.getSnapshot().error).toBeNull();
            expect(recoveredEditing.getSnapshot().focus).toBeNull();
          });
          expect(recovered.getSnapshot()).toMatchObject({
            status: "conflict",
            dirty: true,
            pending: null,
            blocks: toggled.blocks,
          });
          expect(() => recoveredEditing.focus(Symbol(), block.id)).toThrow("conflict");
          expect((yield* Effect.promise(() => reopened.store.load(key))).blocks).toEqual(
            toggled.blocks,
          );
          yield* Effect.promise(() => recoveredEditing.discard());
          expect(recoveredEditing.getSnapshot().error).toBeNull();
          expect(recovered.getSnapshot()).toMatchObject({
            status: "saved",
            dirty: false,
            blocks: [sent, todo, code],
            memberIds: [block.id, todo.id, code.id],
          });
          const allSaved = yield* service.readBlocks({ ...key, revision: external.revision });
          expect(allSaved.blocks).toEqual([sent, todo, code, remoteHidden]);
          expect(discardReads).toBe(1);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
