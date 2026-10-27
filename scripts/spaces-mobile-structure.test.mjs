import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "../packages/contracts/src/index.ts";
import { SpaceBlockId } from "../packages/contracts/src/spaces.ts";
import {
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
} from "../packages/client-runtime/src/spaces/index.ts";
import { createMobileSpaceStructure } from "../apps/mobile/src/features/spaces/structure.ts";
import { MobileSpaceDocuments } from "../apps/mobile/src/features/spaces/documents.ts";
import { SpacesPageReader } from "../apps/mobile/src/features/spaces/reader.ts";
import { diskDatabase } from "../apps/mobile/src/persistence/mobile-database.test-support.ts";
import * as SpacesService from "../apps/server/src/spaces/SpacesService.ts";
import { mobileSpacesServiceLayer, promiseRunner } from "./spaces-mobile.test-support.mjs";

const withFixture = Effect.fn("MobileStructureTest.fixture")(function* (use) {
  const fixture = yield* diskDatabase();
  const environmentId = EnvironmentId.make("structure-environment");
  const layer = mobileSpacesServiceLayer(fixture.file, environmentId);
  yield* Effect.gen(function* () {
    const service = yield* SpacesService.SpacesService;
    const run = yield* promiseRunner();
    const db = yield* fixture.open();
    const capability = yield* service.getCapability(environmentId);
    if (!capability) throw new Error("Expected actual enabled service capability");
    yield* use({ fixture, environmentId, service, run, db, capability });
  }).pipe(Effect.provide(layer));
}, Effect.scoped);

function client(context, db = context.db) {
  const { environmentId, service, run, capability } = context;
  const clientId = NodeCrypto.randomUUID();
  const control = {
    writable: true,
    connected: true,
    generation: 1,
    ids: 0,
    requests: [],
    receipts: [],
    afterStore: null,
    afterSend: null,
    failReads: new Set(),
    refreshed: [],
    changed: 0,
    draftReads: [],
  };
  const access = (write) => {
    if (!control.connected || (write && !control.writable))
      throw new Error("Current read/operate permission unavailable");
  };
  const read = async (effect) => {
    access(false);
    const generation = control.generation;
    const result = await run(effect);
    access(false);
    if (generation !== control.generation) throw new Error("Connection changed during read");
    return result;
  };
  const send = async (request) => {
    access(true);
    expect((await db.structure.load(environmentId)).pending.request).toEqual(request);
    access(true);
    control.requests.push(structuredClone(request));
    const result = await run(service[request.operation](request.input));
    await control.afterSend?.(request, result);
    return result;
  };
  const accessSnapshot = () => {
    const generation = control.generation;
    return {
      availability: control.connected
        ? control.writable
          ? "writable"
          : "read-only"
        : "disconnected",
      capability,
      current: () => control.connected && control.generation === generation,
    };
  };
  let owner;
  const documents = new MobileSpaceDocuments((target) => {
    const key = { environmentId, pageId: target.pageId };
    let reader;
    const session = new SpaceDocumentSession(key, {
      drafts: db.store,
      maxLoadedBlocks: 100,
      maxMutations: 100,
      createMutationId: () => `${clientId}-content-${++control.ids}`,
      assertMutable: () => {
        access(true);
        owner.assertReady();
        documents.assertUnreserved(key);
        reader.assertContentReady();
      },
      adapter: createSpaceServiceSessionAdapter(key, {
        limits: () => capability.limits,
        getPage: (input) => read(service.getPage(input)),
        applyBlockBatch: (input) => run(service.applyBlockBatch(input)),
        lookupMutationReceipt: (input) => read(service.lookupMutationReceipt(input)),
      }),
    });
    reader = new SpacesPageReader(target, {
      session,
      get access() {
        return accessSnapshot();
      },
      beforeRead: () => owner.hydrate(),
      locate: async () => {
        control.refreshed.push(target.pageId);
        const metadata = await read(service.getPage(key));
        if (control.failReads.has(target.pageId))
          throw new Error("Actual document read could not be delivered");
        const source = control.generation;
        return {
          ...metadata,
          ancestors: [],
          current: () => (source === control.generation && control.connected ? metadata : null),
        };
      },
      blocks: (input) => read(service.readBlocks(input)),
    });
    return reader;
  });
  owner = createMobileSpaceStructure(environmentId, {
    documents,
    drafts: {
      load: (key) => {
        control.draftReads.push(key.pageId);
        return db.store.load(key);
      },
      write: db.store.write,
    },
    store: {
      load: db.structure.load,
      write: async (id, journal) => {
        await db.structure.write(id, journal);
        await control.afterStore?.(journal);
      },
    },
    newId: () => `${clientId}-structure-${++control.ids}`,
    assertAccess: access,
    libraryAccess: access,
    capability: () => capability,
    maxRows: () => capability.limits.maxListRows,
    maxMutationBytes: () => capability.limits.maxMutationBytes,
    getPage: (pageId) => read(service.getPage({ environmentId, pageId })),
    spaces: (input) => read(service.listSpaces(input)),
    list: (input) => read(service.listPages(input)),
    blocks: (input) => read(service.readBlocks(input)),
    inspect: (input) => read(service.inspectStructure(input)),
    receipt: async (input) => {
      const result = await read(service.lookupMutationReceipt(input));
      control.receipts.push(result.status);
      return result;
    },
    library: async (request) => ({ operation: request.operation, result: await send(request) }),
    createChild: (input) => send({ operation: "createChildPage", input }),
    move: (input) => send({ operation: "movePage", input }),
    recovery: (operation, input) => send({ operation, input }),
    trashList: (input) => read(service.listTrash(input)),
    moveBlocks: async () => {
      throw new Error("Block moves unavailable in this mobile slice");
    },
    purge: async () => {
      throw new Error("Permanent deletion unavailable in this mobile slice");
    },
    changed: () => {
      control.changed++;
    },
  });
  return { owner, documents, control };
}

async function defaultSpace(context) {
  const catalog = await context.run(
    context.service.listSpaces({ environmentId: context.environmentId }),
  );
  return (
    await context.run(
      context.service.listPages({
        environmentId: context.environmentId,
        spaceId: catalog.defaultSpaceId,
        limit: 1,
      }),
    )
  ).space;
}
async function root(context, runtime, space, title) {
  await runtime.owner.createRootPage(space, title);
  return runtime.owner.getSnapshot().libraryResult.page;
}
function paragraph(id) {
  return {
    id: SpaceBlockId.make(id),
    type: "paragraph",
    version: 1,
    parentId: null,
    order: "80000000000000000000000000000000",
    content: { runs: [{ text: "Saved content", marks: [] }] },
  };
}
async function seedBlock(context, page, block) {
  const metadata = await context.run(
    context.service.getPage({ environmentId: context.environmentId, pageId: page.id }),
  );
  await context.run(
    context.service.applyBlockBatch({
      environmentId: context.environmentId,
      pageId: page.id,
      baseRevision: metadata.page.revision,
      receiptEpoch: metadata.mutationAdmission.epoch,
      mutationId: `seed-${block.id}`,
      generation: 1,
      mutations: [{ kind: "insert", block }],
    }),
  );
}

it.effect(
  "creates the first empty default page and recovers its real lost ACK after SQLite reopen, then completes library CRUD",
  () =>
    withFixture((context) =>
      Effect.gen(function* () {
        const initial = client(context);
        const space = yield* Effect.promise(() => defaultSpace(context));
        const empty = yield* context.service.listPages({
          environmentId: context.environmentId,
          spaceId: space.id,
        });
        expect(empty.items).toEqual([]);
        initial.control.afterSend = async (request, result) => {
          if (request.operation === "createPage" && result.status === "saved")
            throw new Error("Lost root creation ACK");
        };
        yield* Effect.promise(async () => {
          await expect(initial.owner.createRootPage(space, "First page")).rejects.toThrow(
            "Lost root creation ACK",
          );
          expect(initial.control.requests).toHaveLength(1);
        });
        const pending = yield* Effect.promise(() =>
          context.db.structure.load(context.environmentId),
        );
        expect(pending.pending.request.operation).toBe("createPage");
        expect(pending.pending.observed).toEqual({
          pages: [],
          roots: [{ spaceId: space.id, rootOrderRevision: 0 }],
        });
        yield* context.db.close;
        const reopened = yield* context.fixture.open();
        const recovered = client(context, reopened);
        yield* Effect.promise(async () => {
          await recovered.owner.hydrate();
          expect(recovered.owner.getSnapshot().journal.pending.request).toEqual(
            pending.pending.request,
          );
          await recovered.owner.recover();
          expect(recovered.control.receipts).toEqual(["found"]);
          expect(recovered.control.requests).toEqual([]);
          expect(recovered.control.ids).toBe(0);
          const created = recovered.owner.getSnapshot().libraryResult.page;
          const actual = await context.run(
            context.service.listPages({ environmentId: context.environmentId, spaceId: space.id }),
          );
          expect(actual.items.map((p) => p.id)).toEqual([created.id]);
          expect(actual.space.rootOrderRevision).toBe(1);
          await recovered.owner.createSpace("Research");
          const fresh = recovered.owner.getSnapshot().libraryResult.space;
          await recovered.owner.renameSpace(fresh, "Renamed research");
          const renamed = recovered.owner.getSnapshot().libraryResult.space;
          const page = await root(context, recovered, renamed, "New root");
          await recovered.owner.renamePage(page, "Renamed root");
          const metadata = await context.run(
            context.service.getPage({ environmentId: context.environmentId, pageId: page.id }),
          );
          expect(metadata.page.title).toBe("Renamed root");
          expect(metadata.space.title).toBe("Renamed research");
          expect(recovered.owner.getSnapshot().journal).toMatchObject({
            pending: null,
            history: null,
          });
          expect(recovered.owner.getSnapshot().notice).toContain("Metadata Undo is unavailable");
          expect((await reopened.structure.load(context.environmentId)).pending).toBeNull();
        });
      }),
    ),
);

it.effect(
  "persists before sending, retains a commit failure and checks read-first known absence after permission withdrawal and restart",
  () =>
    withFixture((context) =>
      Effect.gen(function* () {
        const runtime = client(context);
        const space = yield* Effect.promise(() => defaultSpace(context));
        context.fixture.control.beforeCommit = async () => {
          throw new Error("Real SQLite commit refused");
        };
        yield* Effect.promise(() =>
          expect(runtime.owner.createSpace("Must wait for disk")).rejects.toBeDefined(),
        );
        expect(runtime.control.requests).toEqual([]);
        expect(
          yield* Effect.promise(() => context.db.structure.load(context.environmentId)),
        ).toBeNull();
        const unsent = runtime.owner.getSnapshot().journal.pending.request;
        context.fixture.control.beforeCommit = null;
        yield* Effect.promise(() => runtime.owner.recover());
        expect(runtime.control.requests).toEqual([unsent]);
        const currentSpace = yield* Effect.promise(() => defaultSpace(context));
        expect(currentSpace.id).toBe(space.id);
        const stored = Promise.withResolvers();
        const deliver = Promise.withResolvers();
        runtime.control.afterStore = async (journal) => {
          if (journal.pending?.request.operation === "createPage") {
            stored.resolve();
            await deliver.promise;
          }
        };
        yield* Effect.promise(async () => {
          const creating = runtime.owner.createRootPage(currentSpace, "Withdrawn permission");
          await stored.promise;
          runtime.control.writable = false;
          deliver.resolve();
          await expect(creating).rejects.toThrow("permission");
        });
        const exact = yield* Effect.promise(() => context.db.structure.load(context.environmentId));
        expect(runtime.control.requests).toHaveLength(1);
        yield* context.db.close;
        const reopened = yield* context.fixture.open();
        const restarted = client(context, reopened);
        restarted.control.writable = false;
        yield* Effect.promise(async () => {
          await expect(restarted.owner.recover()).rejects.toThrow("permission");
          expect(restarted.control.receipts).toEqual(["absent"]);
          expect(restarted.control.requests).toEqual([]);
          expect((await reopened.structure.load(context.environmentId)).pending.request).toEqual(
            exact.pending.request,
          );
          restarted.control.writable = true;
          await restarted.owner.recover();
          expect(restarted.control.receipts).toEqual(["absent", "absent"]);
          expect(restarted.control.requests).toEqual([exact.pending.request]);
          expect(restarted.control.ids).toBe(0);
          expect(restarted.owner.getSnapshot().journal.pending).toBeNull();
        });
      }),
    ),
);

it.effect(
  "interlocks dirty hidden and resident page drafts without scanning unrelated records",
  () =>
    withFixture((context) =>
      Effect.gen(function* () {
        const runtime = client(context);
        const firstSpace = yield* Effect.promise(() => defaultSpace(context));
        const resident = yield* Effect.promise(() =>
          root(context, runtime, firstSpace, "Resident"),
        );
        const space = yield* Effect.promise(() => defaultSpace(context));
        const hidden = yield* Effect.promise(() => root(context, runtime, space, "Hidden"));
        const residentBlock = paragraph("resident-text"),
          hiddenBlock = paragraph("hidden-text");
        yield* Effect.promise(async () => {
          await seedBlock(context, resident, residentBlock);
          await seedBlock(context, hidden, hiddenBlock);
          const lease = runtime.documents.acquire({
            environmentId: context.environmentId,
            pageId: resident.id,
            spaceId: resident.spaceId,
          });
          await lease.reader.first();
          const focus = lease.reader.editing.focus(Symbol(), residentBlock.id);
          focus.publication.receive(
            {
              version: 1,
              revision: 1,
              composing: false,
              selection: { start: 0, end: 0 },
              typing: { bold: false, italic: false, code: false },
              runs: [{ text: "Resident retained draft", bold: false, italic: false, code: false }],
            },
            true,
          );
          await lease.reader.editing.finish(focus.owner, focus.token);
          const hiddenMetadata = await context.run(
            context.service.getPage({ environmentId: context.environmentId, pageId: hidden.id }),
          );
          const hiddenWindow = await context.run(
            context.service.readBlocks({
              environmentId: context.environmentId,
              pageId: hidden.id,
              revision: hiddenMetadata.page.revision,
            }),
          );
          const hiddenSession = new SpaceDocumentSession(
            { environmentId: context.environmentId, pageId: hidden.id },
            {
              drafts: context.db.store,
              maxLoadedBlocks: 100,
              maxMutations: 100,
              createMutationId: () => "never-save-hidden",
              adapter: {
                getMutationAdmission: async () => {
                  throw new Error("Do not save hidden draft");
                },
                save: async () => {
                  throw new Error("Do not save hidden draft");
                },
                lookupReceipt: async () => {
                  throw new Error("Do not invent a receipt");
                },
              },
            },
          );
          await hiddenSession.hydrate(hiddenWindow);
          hiddenSession.apply([
            {
              kind: "replace",
              block: {
                ...hiddenBlock,
                content: { runs: [{ text: "Hidden retained draft", marks: [] }] },
              },
            },
          ]);
          await hiddenSession.persistDraft();
          const before = runtime.control.requests.length;
          await expect(runtime.owner.renamePage(resident, "Unsafe rename")).rejects.toThrow(
            "draft",
          );
          expect(runtime.control.requests).toHaveLength(before);
          runtime.control.draftReads.length = 0;
          await expect(
            runtime.owner.renamePage(hiddenMetadata.page, "Unsafe hidden rename"),
          ).rejects.toThrow("retained draft");
          expect(runtime.control.draftReads).toEqual([hidden.id]);
          expect(runtime.control.requests).toHaveLength(before);
          expect(runtime.owner.getSnapshot().journal.pending).toBeNull();
          expect(
            (
              await context.db.store.load({
                environmentId: context.environmentId,
                pageId: resident.id,
              })
            ).mutations,
          ).toHaveLength(1);
          expect(
            (
              await context.db.store.load({
                environmentId: context.environmentId,
                pageId: hidden.id,
              })
            ).mutations,
          ).toHaveLength(1);
          lease.release();
        });
      }),
    ),
);

it.effect(
  "creates a child, reserves its affected pages, refreshes every failed resident, and retains only a proven logical move inverse",
  () =>
    withFixture((context) =>
      Effect.gen(function* () {
        const runtime = client(context);
        const space = yield* Effect.promise(() => defaultSpace(context));
        const parent = yield* Effect.promise(() => root(context, runtime, space, "Parent"));
        yield* Effect.promise(async () => {
          await seedBlock(context, parent, paragraph("parent-text"));
          await runtime.owner.loadBody(parent.id);
          await runtime.owner.createChild("Nested child", {
            pageId: parent.id,
            parentId: null,
            beforeBlockId: null,
          });
        });
        const nested = runtime.owner.getSnapshot().journal.history.pageId;
        const child = (yield* context.service.getPage({
          environmentId: context.environmentId,
          pageId: nested,
        })).page;
        const originalMarker = child.location.ownerBlockId;
        yield* Effect.promise(() => seedBlock(context, child, paragraph("child-text")));
        yield* Effect.promise(() => runtime.owner.createSpace("Destination"));
        const destination = runtime.owner.getSnapshot().libraryResult.space;
        const parentLease = runtime.documents.acquire({
          environmentId: context.environmentId,
          spaceId: parent.spaceId,
          pageId: parent.id,
        });
        const childLease = runtime.documents.acquire({
          environmentId: context.environmentId,
          spaceId: child.spaceId,
          pageId: child.id,
        });
        yield* Effect.promise(async () => {
          await parentLease.reader.first();
          await childLease.reader.first();
          await runtime.owner.loadSource(child.id);
          await runtime.owner.browse(destination.id, child.id);
          const accepted = Promise.withResolvers();
          const deliver = Promise.withResolvers();
          runtime.control.afterSend = async (request, result) => {
            if (request.operation === "movePage" && result.status === "saved") {
              accepted.resolve();
              await deliver.promise;
            }
          };
          const moving = runtime.owner.move(child.id, destination.id, null);
          await accepted.promise;
          expect(() =>
            parentLease.reader.editing.focus(Symbol(), SpaceBlockId.make("parent-text")),
          ).toThrow("reserved");
          expect(() =>
            runtime.documents.acquire({
              environmentId: context.environmentId,
              spaceId: child.spaceId,
              pageId: child.id,
            }),
          ).toThrow("reserved");
          runtime.control.failReads.add(parent.id);
          runtime.control.failReads.add(child.id);
          runtime.control.refreshed.length = 0;
          deliver.resolve();
          await expect(moving).rejects.toThrow("could not refresh");
          expect(new Set(runtime.control.refreshed)).toEqual(new Set([parent.id, child.id]));
          expect(runtime.owner.getSnapshot().journal.pending).toBeNull();
          expect((await context.db.structure.load(context.environmentId)).pending).toBeNull();
          expect(() =>
            parentLease.reader.editing.focus(Symbol(), SpaceBlockId.make("parent-text")),
          ).toThrow("Refresh");
          expect(() =>
            childLease.reader.editing.focus(Symbol(), SpaceBlockId.make("child-text")),
          ).toThrow("Refresh");
          runtime.control.failReads.clear();
          runtime.control.afterSend = null;
          await parentLease.reader.first();
          await childLease.reader.first();
          expect(parentLease.reader.getSnapshot().error).toBeNull();
          expect(childLease.reader.getSnapshot().location.page.spaceId).toBe(destination.id);
          const ready = parentLease.reader.editing.focus(
            Symbol(),
            SpaceBlockId.make("parent-text"),
          );
          await parentLease.reader.editing.finish(ready.owner, ready.token);
          expect(runtime.owner.getSnapshot().journal.history.direction).toBe("undo");
          await runtime.owner.compensate("undo");
          const restored = await context.run(
            context.service.getPage({ environmentId: context.environmentId, pageId: child.id }),
          );
          expect(restored.page.location.kind).toBe("child");
          expect(restored.page.location.parentPageId).toBe(parent.id);
          expect(restored.page.location.ownerBlockId).not.toBe(originalMarker);
          const parentMetadata = await context.run(
            context.service.getPage({ environmentId: context.environmentId, pageId: parent.id }),
          );
          const parentBody = await context.run(
            context.service.readBlocks({
              environmentId: context.environmentId,
              pageId: parent.id,
              revision: parentMetadata.page.revision,
            }),
          );
          expect(parentBody.blocks.map((b) => b.id)).not.toContain(originalMarker);
          await runtime.owner.compensate("redo");
          const redone = await context.run(
            context.service.getPage({ environmentId: context.environmentId, pageId: child.id }),
          );
          expect(redone.page.location.kind).toBe("root");
          expect(redone.page.spaceId).toBe(destination.id);
          parentLease.release();
          childLease.release();
        });
      }),
    ),
);
