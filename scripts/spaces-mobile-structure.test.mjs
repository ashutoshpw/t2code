import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as Effect from "effect/Effect";
import { EnvironmentId } from "../packages/contracts/src/index.ts";
import { SpaceBlockId } from "../packages/contracts/src/spaces.ts";
import {
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
} from "../packages/client-runtime/src/spaces/index.ts";
import { createMobileSpaceStructure } from "../apps/mobile/src/features/spaces/structure.ts";
import {
  MobileSpaceDocuments,
  acquireHydratedSpacesPageReader,
} from "../apps/mobile/src/features/spaces/documents.ts";
import { SpacesPageReader } from "../apps/mobile/src/features/spaces/reader.ts";
import { diskDatabase } from "../apps/mobile/src/persistence/mobile-database.test-support.ts";
import * as SpacesService from "../apps/server/src/spaces/SpacesService.ts";
import { mobileSpacesServiceLayer, promiseRunner } from "./spaces-mobile.test-support.mjs";
import { SpacesPageRouteScreen } from "../apps/mobile/src/features/spaces/SpacesScreens.tsx";

const pageView = vi.hoisted(() => ({ access: null, acquire: null }));
vi.mock("../apps/mobile/src/state/spaces.ts", () => ({
  acquireSpacesPageReader: (...args) => pageView.acquire(...args),
  useSpacesReadAccess: () => pageView.access,
  spacesEnvironment: {},
}));
vi.mock("../apps/mobile/src/state/atom-registry.ts", () => ({ appAtomRegistry: {} }));
vi.mock("../apps/mobile/src/state/environments.ts", () => ({ useEnvironments: () => ({}) }));
vi.mock("../apps/mobile/src/state/query.ts", () => ({ useEnvironmentQuery: () => ({}) }));
vi.mock("../apps/mobile/node_modules/react-native", () => ({
  View: ({ children }) => children,
  FlatList: () => null,
}));
vi.mock("../apps/mobile/node_modules/@react-navigation/native", () => ({
  useNavigation: () => ({}),
  usePreventRemove: () => {},
}));
vi.mock("../apps/mobile/src/components/ui/AppText.tsx", () => ({
  AppText: ({ children }) => children,
}));
vi.mock("../apps/mobile/src/components/ui/ControlPill.tsx", async () => {
  const { createElement } = await import("../apps/mobile/node_modules/react/index.js");
  return {
    ControlPill: ({ label, onPress, disabled }) =>
      createElement("button", { onClick: onPress, disabled }, label),
  };
});
vi.mock("../apps/mobile/src/components/ui/ListRow.tsx", () => ({ ListRow: () => null }));
vi.mock("../apps/mobile/src/components/ui/Dialog.tsx", () => ({}));
vi.mock("../apps/mobile/src/features/settings/components/SettingsScreen.tsx", () => ({
  SettingsScreen: ({ children }) => children,
}));
vi.mock("../apps/mobile/src/native/NativeScrollViewMarker.tsx", () => ({
  NativeScrollView: () => null,
}));
vi.mock("../apps/mobile/src/features/spaces/SpacesLibraryActions.tsx", () => ({
  SpacesLibraryActions: () => null,
}));
vi.mock("../apps/mobile/src/features/spaces/SpaceBlockReader.tsx", () => ({
  SpaceBlockReader: () => null,
}));
vi.mock("../apps/mobile/src/features/spaces/SpacesNativeBlockEditor.tsx", () => ({
  SpacesNativeBlockEditor: () => null,
  spacesNativeEditorAvailable: () => false,
}));

const requireFromMobile = NodeModule.createRequire(
  new URL("../apps/mobile/package.json", import.meta.url),
);
const { act, createElement } = requireFromMobile("react");
const { createRoot } = requireFromMobile("react-dom/client");
const { JSDOM } = requireFromMobile("jsdom");

function pageScreen(target) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    render: () =>
      act(() => root.render(createElement(SpacesPageRouteScreen, { route: { params: target } }))),
    [Symbol.dispose]() {
      act(() => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    },
  };
}

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

it.effect(
  "moves a bounded subtree into a cross-space child placement, refuses hidden drafts/cycles/stale guards, and renests with fresh markers",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const source = await root(context, runtime, space, "Moving subtree");
        const descendant = await child(context, runtime, source, "Descendant");
        const cycle = {
          kind: "child",
          placement: { pageId: descendant.id, parentId: null, beforeBlockId: null },
        };
        await prepareMove(context, runtime, source.id, cycle);
        const requestsBeforeCycle = runtime.control.requests.length;
        await expect(runtime.owner.moveTo(source.id, cycle)).rejects.toMatchObject({
          reason: "cycle",
        });
        expect(runtime.control.requests).toHaveLength(requestsBeforeCycle);
        expect((await pageMetadata(context, source.id)).page.location.kind).toBe("root");
        await runtime.owner.createSpace("Other space");
        const other = runtime.owner.getSnapshot().libraryResult.space;
        const destination = await root(context, runtime, other, "Destination");
        const text = paragraph("nested-anchor");
        await seedBlock(context, destination, text);
        const placement = {
          kind: "child",
          placement: { pageId: destination.id, parentId: null, beforeBlockId: text.id },
        };
        const key = { environmentId: context.environmentId, pageId: destination.id };
        const window = await pageWindow(context, destination.id);
        const hidden = new SpaceDocumentSession(key, {
          drafts: context.db.store,
          maxLoadedBlocks: 100,
          maxMutations: 100,
          createMutationId: () => NodeCrypto.randomUUID(),
          adapter: createSpaceServiceSessionAdapter(key, {
            limits: () => context.capability.limits,
            getPage: (input) => context.run(context.service.getPage(input)),
            applyBlockBatch: (input) => context.run(context.service.applyBlockBatch(input)),
            lookupMutationReceipt: (input) =>
              context.run(context.service.lookupMutationReceipt(input)),
          }),
        });
        await hidden.hydrate(window);
        hidden.apply([
          {
            kind: "replace",
            block: {
              ...text,
              content: { runs: [{ text: "Unresolved hidden destination", marks: [] }] },
            },
          },
        ]);
        await hidden.persistDraft();
        await prepareMove(context, runtime, source.id, placement);
        const beforeDirty = runtime.control.requests.length;
        await expect(runtime.owner.moveTo(source.id, placement)).rejects.toThrow("retained draft");
        expect(runtime.control.draftReads).toContain(destination.id);
        expect(runtime.control.requests).toHaveLength(beforeDirty);
        expect((await context.db.store.load(key)).mutations).toHaveLength(1);
        await hidden.discardDraft(window);
        await prepareMove(context, runtime, source.id, placement);
        await expect(
          runtime.owner.moveTo(source.id, {
            ...placement,
            placement: {
              ...placement.placement,
              beforeBlockId: SpaceBlockId.make("unavailable-anchor"),
            },
          }),
        ).rejects.toThrow("known list placement");
        await runtime.owner.moveTo(source.id, placement);
        const nested = (await pageMetadata(context, source.id)).page;
        expect(nested.id).toBe(source.id);
        expect(nested.location).toMatchObject({ kind: "child", parentPageId: destination.id });
        expect(nested.spaceId).toBe(other.id);
        expect((await pageMetadata(context, descendant.id)).page.spaceId).toBe(other.id);
        const firstMarker = nested.location.ownerBlockId;
        expect(runtime.owner.getSnapshot().journal.history.guards.pages.length).toBeLessThanOrEqual(
          8,
        );
        await runtime.owner.compensate("undo");
        expect((await pageMetadata(context, source.id)).page.location.kind).toBe("root");
        expect(
          await context.run(
            context.service.resolveReference({
              environmentId: context.environmentId,
              target: { kind: "block", blockId: firstMarker },
            }),
          ),
        ).toEqual({ status: "deleted" });
        await runtime.owner.compensate("redo");
        const redone = (await pageMetadata(context, source.id)).page;
        expect(redone.location.ownerBlockId).not.toBe(firstMarker);
        const sameSpaceParent = await root(context, runtime, other, "Same-space parent");
        const list = { ...paragraph("destination-list"), type: "bulleted_item" };
        await seedBlock(context, sameSpaceParent, list);
        const sameSpacePlacement = {
          kind: "child",
          placement: { pageId: sameSpaceParent.id, parentId: list.id, beforeBlockId: null },
        };
        await prepareMove(context, runtime, source.id, sameSpacePlacement);
        await runtime.owner.moveTo(source.id, sameSpacePlacement);
        const renested = (await pageMetadata(context, source.id)).page;
        expect(renested.id).toBe(source.id);
        expect(renested.location.parentPageId).toBe(sameSpaceParent.id);
        expect(renested.location.ownerBlockId).toBe(redone.location.ownerBlockId);
        expect(
          (await pageWindow(context, sameSpaceParent.id)).blocks.find(
            (block) => block.id === renested.location.ownerBlockId,
          ).parentId,
        ).toBe(list.id);
        const staleSource = await root(context, runtime, space, "Stale source");
        await prepareMove(context, runtime, staleSource.id, placement);
        runtime.control.afterStore = async (journal) => {
          if (journal.pending?.request.operation !== "movePage") return;
          runtime.control.afterStore = null;
          await seedBlock(context, destination, paragraph("remote-destination-change"));
        };
        await runtime.owner.moveTo(staleSource.id, placement);
        expect(runtime.owner.getSnapshot().journal.pending.conflict).toBe(true);
        const frozen = await context.db.structure.load(context.environmentId);
        expect(
          frozen.pending.request.input.guards.pages.find((row) => row.pageId === destination.id)
            .revision,
        ).toBeLessThan((await pageMetadata(context, destination.id)).page.revision);
        expect((await pageMetadata(context, staleSource.id)).page).toEqual(staleSource);
        const sends = runtime.control.requests.length;
        await expect(runtime.owner.recover()).rejects.toThrow("No uncertain placement");
        expect(runtime.control.requests).toHaveLength(sends);
        expect((await context.db.structure.load(context.environmentId)).pending).toEqual(
          frozen.pending,
        );
      }),
    ),
);

it.effect(
  "browses empty continuing Trash windows and restores by current ownership while preserving independent batches and proven visibility inverse",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const parent = await root(context, runtime, space, "Trash parent");
        const nested = await child(context, runtime, parent, "Trash child");
        const grandchild = await child(context, runtime, nested, "Independent child");
        await runtime.owner.previewRecovery(parent.id, "trash");
        const preview = runtime.owner.getSnapshot().recoveryPreview;
        runtime.control.writable = false;
        const beforeDenied = runtime.control.requests.length;
        await expect(runtime.owner.confirmRecovery(preview)).rejects.toThrow("permission");
        expect(runtime.control.requests).toHaveLength(beforeDenied);
        runtime.control.writable = true;
        await runtime.owner.confirmRecovery(preview);
        runtime.control.maxRows = 1;
        await runtime.owner.browseTrash();
        let emptyContinuation = false;
        const found = [];
        for (let index = 0; index < 3; index++) {
          const listed = runtime.owner.getSnapshot().trash;
          found.push(...listed.items.map((item) => item.pageId));
          emptyContinuation ||= listed.items.length === 0 && listed.nextCursor !== null;
          if (listed.nextCursor === null) break;
          await runtime.owner.browseTrash(true);
        }
        expect(found).toEqual([parent.id]);
        expect(emptyContinuation).toBe(true);
        expect(runtime.owner.getSnapshot().trash.nextCursor).toBeNull();
        await recoverPage(runtime, parent.id, "restore");
        await recoverPage(runtime, grandchild.id, "trash");
        const independent = (await trashedPage(context, grandchild.id)).trash;
        const batchPreview = await recoverPage(runtime, parent.id, "trash");
        expect(new Set(batchPreview.inspection.recovery.pageIds)).toEqual(
          new Set([parent.id, nested.id]),
        );
        const batch = (await trashedPage(context, nested.id)).trash;
        expect(batch.batchId).not.toBe(independent.batchId);
        const currentPlacement = {
          kind: "root",
          spaceId: space.id,
          beforePageId: null,
        };
        const inspection = await context.run(
          context.service.inspectStructure({
            environmentId: context.environmentId,
            target: { kind: "page", pageId: nested.id },
            destination: currentPlacement,
          }),
        );
        const admission = await context.run(
          context.service.listSpaces({ environmentId: context.environmentId, limit: 1 }),
        );
        const movedResult = await context.run(
          context.service.movePage({
            environmentId: context.environmentId,
            pageId: nested.id,
            destination: currentPlacement,
            guards: inspection.guards,
            mutationId: NodeCrypto.randomUUID(),
            receiptEpoch: admission.mutationAdmission.epoch,
          }),
        );
        expect(movedResult.status).toBe("saved");
        const moved = movedResult.page;
        const restoreParent = await recoverPage(runtime, parent.id, "restore");
        expect(restoreParent.inspection.recovery.pageIds).toEqual([parent.id]);
        expect((await trashedPage(context, nested.id)).trash).toEqual(batch);
        await runtime.owner.previewRecovery(nested.id, "restore");
        const current = runtime.owner.getSnapshot().recoveryPreview;
        expect(current.placement).toContain("current root placement");
        expect(current.inspection.recovery.pageIds).toEqual([nested.id]);
        await runtime.owner.confirmRecovery(current);
        expect((await pageMetadata(context, nested.id)).page.location).toEqual(moved.location);
        expect((await trashedPage(context, grandchild.id)).trash).toEqual(independent);
        expect(runtime.owner.getSnapshot().journal.history.operation).toBe("trashPage");
        await runtime.owner.compensate("undo");
        expect((await trashedPage(context, nested.id)).trash.batchId).not.toBe(batch.batchId);
        await runtime.owner.compensate("redo");
        expect((await pageMetadata(context, nested.id)).page.trash).toBeUndefined();
        await recoverPage(runtime, grandchild.id, "restore");
        expect((await pageMetadata(context, grandchild.id)).page.location.parentPageId).toBe(
          nested.id,
        );
      }),
    ),
);

it.effect(
  "recovers exact Trash and Restore receipts across SQLite reopen after final journal commit failure and lost reply without resending or releasing an unaffected editor",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const initial = client(context);
        const space = await defaultSpace(context);
        const page = await root(context, initial, space, "Recover visibility");
        const unaffected = await root(context, initial, space, "Unaffected editor");
        const text = paragraph("unaffected-focus");
        await seedBlock(context, unaffected, text);
        const lease = initial.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: unaffected.id,
        });
        await lease.reader.first();
        const focus = lease.reader.editing.focus(Symbol("unaffected input"), text.id);
        initial.control.afterSend = async (request, result) => {
          if (request.operation === "trashPage" && result.status === "saved")
            context.fixture.control.beforeCommit = async () => {
              throw new Error("Final journal COMMIT refused");
            };
        };
        await expect(recoverPage(initial, page.id, "trash")).rejects.toBeDefined();
        const pendingTrash = await context.db.structure.load(context.environmentId);
        expect(pendingTrash.pending.request.operation).toBe("trashPage");
        expect((await trashedPage(context, page.id)).trash).toBeDefined();
        expect(lease.reader.editing.getSnapshot().focus).toBe(focus);
        expect(() =>
          initial.documents.acquire({
            environmentId: context.environmentId,
            spaceId: space.id,
            pageId: page.id,
          }),
        ).toThrow("reserved");
        context.fixture.control.beforeCommit = null;
        lease.release();
        await context.run(context.db.close);
        const reopened = await context.run(context.fixture.open());
        const restarted = client(context, reopened);
        await restarted.owner.recover();
        expect(restarted.control.receipts).toEqual(["found"]);
        expect(restarted.control.requests).toEqual([]);
        expect((await reopened.structure.load(context.environmentId)).pending).toBeNull();
        restarted.control.afterSend = async (request, result) => {
          if (request.operation === "restorePage" && result.status === "saved")
            throw new Error("Lost Restore reply");
        };
        await expect(recoverPage(restarted, page.id, "restore")).rejects.toThrow(
          "Lost Restore reply",
        );
        const pendingRestore = await reopened.structure.load(context.environmentId);
        expect(pendingRestore.pending.request.operation).toBe("restorePage");
        await context.run(reopened.close);
        const again = await context.run(context.fixture.open());
        const recovered = client(context, again);
        await recovered.owner.hydrate();
        expect(recovered.owner.getSnapshot().journal.pending).toEqual(pendingRestore.pending);
        await recovered.owner.recover();
        expect(recovered.control.receipts).toEqual(["found"]);
        expect(recovered.control.requests).toEqual([]);
        expect(recovered.control.ids).toBe(0);
        expect((await again.structure.load(context.environmentId)).pending).toBeNull();
        expect((await pageMetadata(context, page.id)).page.trash).toBeUndefined();
        expect(pendingTrash.pending.request.input.receiptEpoch).toBe(
          pendingRestore.pending.request.input.receiptEpoch,
        );
      }),
    ),
);

it.effect(
  "retries the mounted page after real journal receipt recovery and preserves its healthy editing lease",
  () =>
    withFixture((context) =>
      Effect.gen(function* () {
        const initial = client(context);
        const space = yield* Effect.promise(() => defaultSpace(context));
        const page = yield* Effect.promise(() => root(context, initial, space, "Before rename"));
        const block = paragraph("retry-page-text");
        yield* Effect.promise(() => seedBlock(context, page, block));
        const metadata = yield* context.service.getPage({
          environmentId: context.environmentId,
          pageId: page.id,
        });
        initial.control.afterSend = async () => {
          throw new Error("Lost rename ACK");
        };
        yield* Effect.promise(() =>
          expect(initial.owner.renamePage(metadata.page, "Recovered rename")).rejects.toThrow(
            "Lost rename ACK",
          ),
        );
        yield* context.db.close;
        const reopened = yield* context.fixture.open();
        const restarted = client(context, reopened);
        yield* Effect.promise(async () => {
          const attempts = [];
          const leases = [];
          let releases = 0;
          pageView.access = restarted.access();
          pageView.acquire = (target, access, signal) => {
            const attempt = acquireHydratedSpacesPageReader(target, access, signal, {
              documents: restarted.documents,
              hydrate: () => restarted.owner.hydrate(),
            });
            attempts.push(attempt);
            return attempt.then((lease) => {
              leases.push(lease);
              return {
                ...lease,
                release: () => {
                  releases++;
                  lease.release();
                },
              };
            });
          };
          using screen = pageScreen({
            environmentId: context.environmentId,
            spaceId: space.id,
            pageId: page.id,
          });
          screen.render();
          await act(async () => {
            await expect(attempts[0]).rejects.toThrow("reserved");
          });
          expect(screen.container.textContent).toContain("reserved");
          expect(restarted.owner.getSnapshot().journal.pending.request.operation).toBe(
            "updatePage",
          );
          await act(async () => {
            await restarted.owner.recover();
          });
          expect(restarted.control.receipts).toEqual(["found"]);
          expect(restarted.control.requests).toEqual([]);
          expect((await reopened.structure.load(context.environmentId)).pending).toBeNull();
          const retry = [...screen.container.querySelectorAll("button")].find(
            (button) => button.textContent === "Retry opening page",
          );
          expect(retry).toBeDefined();
          act(() => retry.click());
          await act(async () => {
            await attempts[1];
          });
          expect(attempts).toHaveLength(2);
          expect(leases).toHaveLength(1);
          const reader = leases[0].reader;
          await act(async () => {
            await reader.first();
          });
          expect(reader.getSnapshot().location.page.title).toBe("Recovered rename");
          let focus;
          act(() => {
            focus = reader.editing.focus(Symbol("retained input"), block.id);
          });
          pageView.access = restarted.access();
          screen.render();
          await act(async () => {
            await reader.first();
          });
          expect(attempts).toHaveLength(2);
          expect(releases).toBe(0);
          expect(reader.editing.getSnapshot().focus).toBe(focus);
        });
      }),
    ),
);

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
    maxRows: capability.limits.maxListRows,
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
    maxRows: () => control.maxRows,
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
  return { owner, documents, control, access: accessSnapshot };
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
  const admission = await context.run(
    context.service.listPages({
      environmentId: context.environmentId,
      spaceId: space.id,
      limit: 1,
    }),
  );
  await runtime.owner.createRootPage(admission.space, title);
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
async function pageMetadata(context, pageId) {
  return context.run(context.service.getPage({ environmentId: context.environmentId, pageId }));
}
async function trashedPage(context, pageId) {
  const inspection = await context.run(
    context.service.inspectStructure({
      environmentId: context.environmentId,
      target: { kind: "page", pageId },
      recovery: "restore",
    }),
  );
  return inspection.pages.find((page) => page.id === pageId);
}
async function pageWindow(context, pageId) {
  const metadata = await pageMetadata(context, pageId);
  return context.run(
    context.service.readBlocks({
      environmentId: context.environmentId,
      pageId,
      revision: metadata.page.revision,
    }),
  );
}
async function child(context, runtime, parent, title) {
  await runtime.owner.loadBody(parent.id);
  await runtime.owner.createChild(title, {
    pageId: parent.id,
    parentId: null,
    beforeBlockId: null,
  });
  return (await pageMetadata(context, runtime.owner.getSnapshot().journal.history.pageId)).page;
}
async function prepareMove(context, runtime, pageId, destination) {
  const metadata = await pageMetadata(context, pageId);
  await runtime.owner.loadSource(pageId);
  if (metadata.page.location.kind === "root")
    await runtime.owner.browse(metadata.page.spaceId, pageId);
  if (destination.kind === "root") await runtime.owner.browse(destination.spaceId, pageId);
  else await runtime.owner.loadBody(destination.placement.pageId);
}
async function recoverPage(runtime, pageId, operation) {
  await runtime.owner.previewRecovery(pageId, operation);
  const preview = runtime.owner.getSnapshot().recoveryPreview;
  await runtime.owner.confirmRecovery(preview);
  return preview;
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
