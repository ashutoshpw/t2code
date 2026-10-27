import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { EnvironmentId } from "../packages/contracts/src/index.ts";
import { SpaceBlockId } from "../packages/contracts/src/spaces.ts";
import {
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
} from "../packages/client-runtime/src/spaces/index.ts";
import {
  createMobileSpaceStructure,
  selectMobileSpacesBlockMove,
} from "../apps/mobile/src/features/spaces/structure.ts";
import {
  MobileSpaceDocuments,
  acquireHydratedSpacesPageReader,
} from "../apps/mobile/src/features/spaces/documents.ts";
import {
  createMobileSpaceReferenceController,
  MobileSpaceReferenceNavigation,
} from "../apps/mobile/src/features/spaces/references.ts";
import { SpacesPageReader } from "../apps/mobile/src/features/spaces/reader.ts";
import { diskDatabase } from "../apps/mobile/src/persistence/mobile-database.test-support.ts";
import * as SpacesService from "../apps/server/src/spaces/SpacesService.ts";
import { mobileSpacesServiceLayer, promiseRunner } from "./spaces-mobile.test-support.mjs";
import { SpacesPageRouteScreen } from "../apps/mobile/src/features/spaces/SpacesScreens.tsx";

const pageView = vi.hoisted(() => ({ access: null, acquire: null }));
vi.mock("../apps/mobile/src/state/spaces.ts", () => ({
  acquireSpacesPageReader: (...args) => pageView.acquire(...args),
  createSpacesImageViewer: () => null,
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
vi.mock("../apps/mobile/src/features/spaces/SpacesHeavyMediaViewer.tsx", () => ({
  SpacesHeavyMediaViewer: () => null,
}));
vi.mock("../apps/mobile/src/features/spaces/SpacesImageViewer.tsx", () => ({
  SpacesImageViewer: () => null,
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

function acquiringPageScreen(context, runtime, page) {
  const attempts = [];
  const leases = [];
  let releases = 0;
  pageView.access = runtime.access();
  pageView.acquire = (target, access, signal) => {
    const attempt = acquireHydratedSpacesPageReader(target, access, signal, {
      documents: runtime.documents,
      hydrate: () => runtime.owner.hydrate(),
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
  return {
    ...pageScreen({ environmentId: context.environmentId, spaceId: page.spaceId, pageId: page.id }),
    attempts,
    leases,
    get releases() {
      return releases;
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
  "resolves actual moved/merged/deleted search references while retaining a dirty mounted native reader and latest selected identity",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const source = await root(context, runtime, space, "Source title snapshot");
        const destination = await root(context, runtime, space, "Current destination title");
        const a = {
          ...paragraph("native-ref-merged"),
          order: "20000000000000000000000000000000",
          content: { runs: [{ text: "nativeuniquereference", marks: [] }] },
        };
        const b = {
          ...paragraph("native-ref-survivor"),
          order: "40000000000000000000000000000000",
          content: { runs: [{ text: "nativeuniquereference", marks: [] }] },
        };
        const kept = {
          ...paragraph("native-ref-dirty"),
          order: "60000000000000000000000000000000",
        };
        await seedBlocks(context, source, [a, b, kept]);
        const session = {};
        const references = await createMobileSpaceReferenceController({
          environmentId: context.environmentId,
          captureSession: async () => () => (runtime.control.connected ? session : null),
          access: () => ({
            sourceVersion: 0,
            canRead: runtime.control.connected,
            capability: context.capability,
          }),
          search: (input) => context.run(context.service.search(input)),
          resolve: (input) => context.run(context.service.resolveReference(input)),
        });
        expect((await references.search("nativeuniquereference")).status).toBe("building");
        const window = await references.search("nativeuniquereference");
        expect(window.status).toBe("ready");
        const target = window.target(window.result.items.findIndex((hit) => hit.blockId === a.id));
        expect(target).toEqual({ kind: "block", blockId: a.id });
        const proof = await selectMobileSpacesBlockMove(
          runtime.owner,
          (await pageMetadata(context, source.id)).page,
          await pageWindow(context, source.id),
          [a.id, b.id],
        );
        await runtime.owner.loadBody(destination.id);
        await runtime.owner.moveSelectedBlocks(proof, {
          pageId: destination.id,
          parentId: null,
          beforeBlockId: null,
        });
        const metadata = await pageMetadata(context, destination.id);
        const joined = await context.run(
          context.service.applyBlockBatch({
            environmentId: context.environmentId,
            pageId: destination.id,
            baseRevision: metadata.page.revision,
            receiptEpoch: metadata.mutationAdmission.epoch,
            mutationId: "native-ref-merge",
            generation: 1,
            mutations: [{ kind: "delete", blockId: a.id, mergedInto: b.id }],
          }),
        );
        expect(joined.status).toBe("saved");
        const lease = runtime.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: source.id,
        });
        const stop = lease.reader.subscribe(() => {});
        await lease.reader.first();
        const opened = [];
        const navigator = new MobileSpaceReferenceNavigation({
          current: () =>
            lease.reader.editing.getSnapshot().focus === null &&
            lease.reader.getSnapshot().location?.current() != null,
          open: (next) => opened.push(next),
        });
        navigator.select({ environmentId: context.environmentId, target }, () => true);
        const focus = lease.reader.editing.focus(Symbol(), kept.id);
        focus.publication.receive(
          {
            ...focus.publication.getSnapshot().observed,
            revision: 1,
            runs: [
              { text: "Retained unpublished native text", bold: false, italic: true, code: false },
            ],
          },
          true,
        );
        await navigator.open(references, context.environmentId);
        expect(opened).toEqual([]);
        expect(lease.reader.editing.getSnapshot().focus).toBe(focus);
        await lease.reader.editing.finish(focus.owner, focus.token);
        const draft = await context.db.store.load({
          environmentId: context.environmentId,
          pageId: source.id,
        });
        const before = lease.reader.getSnapshot().session;
        expect(before.dirty).toBe(true);
        expect(draft.mutations).toHaveLength(1);
        await navigator.open(references, context.environmentId);
        expect(opened).toEqual([
          {
            environmentId: context.environmentId,
            spaceId: space.id,
            pageId: destination.id,
            blockId: b.id,
          },
        ]);
        expect(navigator.getSnapshot().title).toBe("Current destination title");
        expect(window.result.items.find((hit) => hit.blockId === a.id).page.title).toBe(
          "Source title snapshot",
        );
        expect(lease.reader.getSnapshot().session).toBe(before);
        expect(
          await context.db.store.load({ environmentId: context.environmentId, pageId: source.id }),
        ).toEqual(draft);
        await recoverPage(runtime, destination.id, "trash");
        await navigator.open(references, context.environmentId);
        expect(navigator.getSnapshot().error).toContain("unavailable");
        expect(opened).toHaveLength(1);
        await recoverPage(runtime, destination.id, "permanentlyDelete", true);
        expect(await references.resolve(target)).toBeNull();
        expect(lease.reader.getSnapshot().session.dirty).toBe(true);
        navigator.dispose();
        references.dispose();
        stop();
        lease.release();
      }),
    ),
);

it.effect(
  "publishes selection-scoped native formatting and saves/reopens replacement-only Undo/Redo while retaining a failed compensation and newer suffix after ACK",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const page = await root(context, runtime, space, "Formatted saved history");
        const original = {
          ...paragraph("saved-rich-heading"),
          type: "heading",
          content: {
            level: 2,
            runs: [
              {
                text: "ab",
                marks: [
                  { type: "bold", version: 1 },
                  { type: "link", version: 1, href: "https://t2.codes/one" },
                ],
              },
              {
                text: "😀",
                marks: [
                  { type: "italic", version: 1 },
                  { type: "link", version: 1, href: "https://t2.codes/one" },
                ],
              },
              {
                text: "cd",
                marks: [
                  { type: "code", version: 1 },
                  { type: "link", version: 1, href: "https://t2.codes/two" },
                ],
              },
            ],
          },
        };
        const readonly = {
          ...paragraph("unchanged-saved-code"),
          type: "code",
          order: "90000000000000000000000000000000",
          content: { language: "ts", text: "untouched" },
        };
        const todo = {
          ...paragraph("saved-todo-check"),
          type: "todo_item",
          order: "a0000000000000000000000000000000",
          content: { checked: false, runs: [{ text: "Saved task", marks: [] }] },
        };
        await seedBlocks(context, page, [original, readonly, todo]);
        const lease = runtime.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: page.id,
        });
        await lease.reader.first();
        const editing = lease.reader.editing;
        const focus = editing.focus(Symbol(), original.id);
        const publication = focus.publication;
        const initial = publication.getSnapshot().observed;
        publication.receive({ ...initial, selection: { start: 0, end: 6 } }, false);
        const selected = publication.getSnapshot().observed;
        expect(publication.markState("bold")).toBe("mixed");
        expect(JSON.parse(publication.formatCommand("bold", selected))).toEqual({
          revision: 0,
          selection: { start: 0, end: 6 },
          mark: "bold",
          enabled: true,
        });
        expect(lease.reader.session.getSnapshot().generation).toBe(0);
        const nativeRuns = [
          { text: "ab", bold: true, italic: false, code: false, link: "https://t2.codes/one" },
          { text: "😀", bold: true, italic: true, code: false, link: "https://t2.codes/one" },
          { text: "cd", bold: true, italic: false, code: true, link: "https://t2.codes/two" },
        ];
        publication.receive({ ...selected, revision: 1, runs: nativeRuns }, true);
        expect(publication.markState("bold")).toBe(true);
        const formatted = lease.reader.session
          .getSnapshot()
          .blocks.find((block) => block.id === original.id);
        expect(formatted.content.runs[1].marks).toEqual([
          { type: "bold", version: 1 },
          { type: "italic", version: 1 },
          { type: "link", version: 1, href: "https://t2.codes/one" },
        ]);
        expect(formatted.content.runs[2].marks).toEqual([
          { type: "bold", version: 1 },
          { type: "code", version: 1 },
          { type: "link", version: 1, href: "https://t2.codes/two" },
        ]);
        publication.receive(initial, true);
        expect(
          lease.reader.session.getSnapshot().blocks.find((block) => block.id === original.id),
        ).toEqual(formatted);
        await editing.finish(focus.owner, focus.token);
        await editing.save();
        expect(editing.getSnapshot().error).toBeNull();
        expect((await pageWindow(context, page.id)).blocks).toEqual([formatted, readonly, todo]);
        lease.release();
        await context.run(context.db.close);
        const reopened = await context.run(context.fixture.open());
        const restarted = client(context, reopened);
        await restarted.owner.hydrate();
        const opened = restarted.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: page.id,
        });
        try {
          await opened.reader.first();
          const controller = opened.reader.editing;
          const session = opened.reader.session;
          expect(controller.compensationAvailability("undo")).toBeNull();
          await controller.compensate("undo");
          expect(controller.getSnapshot().error).toBeNull();
          expect((await pageWindow(context, page.id)).blocks).toEqual([original, readonly, todo]);
          await controller.compensate("redo");
          expect((await pageWindow(context, page.id)).blocks).toEqual([formatted, readonly, todo]);
          const sendsBeforeFailure = restarted.control.contentRequests.length;
          restarted.control.beforeDraftWrite = async (_key, draft) => {
            if (draft?.pending && draft.history?.action === "undo") {
              restarted.control.beforeDraftWrite = null;
              context.fixture.control.beforeCommit = async () => {
                throw new Error("Saved compensation COMMIT refused");
              };
            }
          };
          await controller.compensate("undo");
          expect(controller.getSnapshot().error).not.toBeNull();
          expect(restarted.control.contentRequests).toHaveLength(sendsBeforeFailure);
          const frozen = structuredClone(session.getSnapshot().pending);
          expect(frozen).not.toBeNull();
          expect(session.getSnapshot().history.action).toBe("undo");
          context.fixture.control.beforeCommit = null;
          await controller.retryPersistence();
          expect(
            (await reopened.store.load({ environmentId: context.environmentId, pageId: page.id }))
              .pending,
          ).toEqual(frozen);
          const committed = Promise.withResolvers();
          const reply = Promise.withResolvers();
          restarted.control.afterContentSend = async () => {
            committed.resolve();
            await reply.promise;
          };
          const saving = controller.save();
          await committed.promise;
          const later = controller.focus(Symbol(), original.id);
          const laterState = later.publication.getSnapshot().observed;
          later.publication.receive(
            {
              ...laterState,
              revision: 1,
              runs: [
                {
                  text: "New suffix😀",
                  bold: true,
                  italic: true,
                  code: true,
                  link: "https://t2.codes/later",
                },
              ],
              selection: { start: 0, end: 0 },
            },
            true,
          );
          const generation = session.getSnapshot().generation;
          reply.resolve();
          await saving;
          expect(controller.getSnapshot().error).toBeNull();
          expect(restarted.control.contentRequests.at(-1)).toMatchObject({
            mutationId: frozen.mutationId,
            receiptEpoch: frozen.receiptEpoch,
            baseRevision: frozen.baseRevision,
            generation: frozen.generation,
            mutations: frozen.mutations,
          });
          expect(generation).toBeGreaterThan(frozen.generation);
          expect(session.getSnapshot()).toMatchObject({ generation, dirty: true, pending: null });
          expect(
            session.getSnapshot().blocks.find((block) => block.id === original.id).content.runs[0]
              .text,
          ).toBe("New suffix😀");
          const stored = await reopened.store.load({
            environmentId: context.environmentId,
            pageId: page.id,
          });
          expect(stored.mutations).toHaveLength(1);
          expect(stored.generation).toBe(generation);
          later.publication.receive(laterState, true);
          expect(session.getSnapshot().generation).toBe(generation);
          await controller.finish(later.owner, later.token);
          restarted.control.afterContentSend = null;
          await controller.save();
          expect(
            (await pageWindow(context, page.id)).blocks.find((block) => block.id === original.id)
              .content.runs[0].text,
          ).toBe("New suffix😀");
          expect(
            (await pageWindow(context, page.id)).blocks.find((block) => block.id === readonly.id),
          ).toEqual(readonly);
          controller.toggleTodo(todo.id);
          await controller.save();
          expect(
            (await pageWindow(context, page.id)).blocks.find((block) => block.id === todo.id)
              .content.checked,
          ).toBe(true);
          await controller.compensate("undo");
          expect(
            (await pageWindow(context, page.id)).blocks.find((block) => block.id === todo.id),
          ).toEqual(todo);
          await controller.compensate("redo");
          expect(
            (await pageWindow(context, page.id)).blocks.find((block) => block.id === todo.id)
              .content.checked,
          ).toBe(true);
        } finally {
          opened.release();
        }
      }),
    ),
);

it.effect(
  "reloads a lost saved Undo receipt as exact uncertain content and refuses admission renewal after real receipt expiry",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const page = await root(context, runtime, space, "Expired saved history receipt");
        const original = paragraph("expired-content");
        await seedBlocks(context, page, [original]);
        const lease = runtime.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: page.id,
        });
        await lease.reader.first();
        const editing = lease.reader.editing;
        const focus = editing.focus(Symbol(), original.id);
        const state = focus.publication.getSnapshot().observed;
        focus.publication.receive(
          {
            ...state,
            revision: 1,
            runs: [{ text: "Saved italic", bold: false, italic: true, code: false }],
            selection: { start: 0, end: 0 },
          },
          true,
        );
        await editing.finish(focus.owner, focus.token);
        await editing.save();
        runtime.control.afterContentSend = async () => {
          throw new Error("Lost real saved Undo reply");
        };
        await editing.compensate("undo");
        expect(editing.getSnapshot().error).toContain("Lost real saved Undo reply");
        const key = { environmentId: context.environmentId, pageId: page.id };
        const pending = await context.db.store.load(key);
        expect(pending.pending).not.toBeNull();
        expect(pending.history.action).toBe("undo");
        lease.release();
        await context.run(context.db.close);
        await context.run(TestClock.adjust("10 days"));
        await context.run(
          context.service.listSpaces({ environmentId: context.environmentId, limit: 1 }),
        );
        const reopened = await context.run(context.fixture.open());
        const restarted = client(context, reopened);
        await restarted.owner.hydrate();
        const current = restarted.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: page.id,
        });
        try {
          await current.reader.first();
          expect(current.reader.session.getSnapshot().status).toBe("uncertain");
          expect(current.reader.editing.compensationAvailability("undo")).not.toBeNull();
          await current.reader.editing.save();
          expect(restarted.control.contentReceipts).toEqual(["unknown"]);
          expect(restarted.control.contentAdmissions).toBe(0);
          expect(restarted.control.contentRequests).toEqual([]);
          expect(restarted.control.ids).toBe(0);
          expect((await reopened.store.load(key)).pending).toEqual(pending.pending);
          expect(current.reader.session.getSnapshot()).toMatchObject({
            status: "uncertain",
            pending: pending.pending,
          });
          expect((await pageWindow(context, page.id)).blocks).toEqual([original]);
        } finally {
          current.release();
        }
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "refuses saved content compensation for readonly blocks, unsupported marks and heading attributes while retaining opaque rows without conversion",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const page = await root(context, runtime, space, "Readonly saved history");
        const heading = {
          ...paragraph("history-heading"),
          type: "heading",
          order: "20000000000000000000000000000000",
          content: {
            level: 2,
            runs: [{ text: "Heading", marks: [] }],
          },
        };
        const code = {
          ...paragraph("history-code"),
          type: "code",
          order: "40000000000000000000000000000000",
          content: { language: "ts", text: "Original code" },
        };
        const strike = {
          ...paragraph("history-strike"),
          order: "60000000000000000000000000000000",
          content: { runs: [{ text: "Strike", marks: [{ type: "strike", version: 1 }] }] },
        };
        const opaque = {
          ...paragraph("history-opaque"),
          order: "80000000000000000000000000000000",
          content: { futureLayout: { keep: true }, runs: [{ text: "Opaque original", marks: [] }] },
        };
        await seedBlocks(context, page, [heading, code, strike, opaque]);
        const lease = runtime.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: page.id,
        });
        try {
          await lease.reader.first();
          expect(() => lease.reader.editing.focus(Symbol(), opaque.id)).toThrow("read-only");
          expect(() =>
            lease.reader.session.apply([
              {
                kind: "replace",
                block: { ...opaque, content: { runs: [{ text: "Do not strip", marks: [] }] } },
              },
            ]),
          ).toThrow("Opaque blocks are read-only");
          for (const change of [
            {
              id: code.id,
              update: (current) => ({
                ...current,
                content: { ...current.content, text: "Changed code" },
              }),
            },
            {
              id: heading.id,
              update: (current) => ({ ...current, content: { ...current.content, level: 3 } }),
            },
            {
              id: strike.id,
              update: (current) => ({
                ...current,
                content: {
                  runs: [{ text: "Changed strike", marks: [{ type: "strike", version: 1 }] }],
                },
              }),
            },
          ]) {
            const current = lease.reader.session
              .getSnapshot()
              .blocks.find((block) => block.id === change.id);
            lease.reader.session.apply([{ kind: "replace", block: change.update(current) }]);
            await lease.reader.session.save();
            const sends = runtime.control.contentRequests.length;
            expect(lease.reader.editing.compensationAvailability("undo")).toContain("read-only");
            await lease.reader.editing.compensate("undo");
            expect(lease.reader.editing.getSnapshot().error).toContain("read-only");
            expect(runtime.control.contentRequests).toHaveLength(sends);
            expect(lease.reader.session.getSnapshot().history.action).toBeNull();
            expect(lease.reader.session.getSnapshot().pending).toBeNull();
            expect(
              (await pageWindow(context, page.id)).blocks.find((block) => block.id === opaque.id),
            ).toEqual(opaque);
          }
        } finally {
          lease.release();
        }
      }),
    ),
);

it.effect(
  "moves requested block roots separately from their opaque/owned-page closure and recovers the real receipt across reopen before guarded inverse",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const source = await root(context, runtime, space, "Block source");
        await runtime.owner.createSpace("Block destination space");
        const other = runtime.owner.getSnapshot().libraryResult.space;
        const destination = await root(context, runtime, other, "Block destination");
        const container = {
          ...paragraph("move-container"),
          type: "bulleted_item",
          order: "20000000000000000000000000000000",
        };
        const leaf = {
          ...paragraph("move-opaque"),
          parentId: container.id,
          order: "40000000000000000000000000000000",
        };
        const tail = { ...paragraph("move-tail"), order: "60000000000000000000000000000000" };
        const anchor = { ...paragraph("move-anchor"), order: "80000000000000000000000000000000" };
        await seedBlocks(context, source, [container, leaf, tail, anchor]);
        const opaque = {
          ...leaf,
          type: "future_widget",
          version: 9,
          content: { untouched: ["界", { future: true }] },
          futureEnvelope: { original: true },
        };
        legacyOpaque(context, source.id, opaque);
        await runtime.owner.loadBody(source.id);
        await runtime.owner.createChild("Owned child", {
          pageId: source.id,
          parentId: container.id,
          beforeBlockId: null,
        });
        const ownedId = runtime.owner.getSnapshot().journal.history.pageId;
        const metadata = await pageMetadata(context, source.id);
        const proof = await selectMobileSpacesBlockMove(
          runtime.owner,
          metadata.page,
          await pageWindow(context, source.id),
          [container.id, tail.id],
        );
        expect(proof.blockIds).toEqual([container.id, tail.id]);
        expect(proof.selectedIds).toContain(opaque.id);
        expect(proof.selectedIds.length).toBeGreaterThan(proof.blockIds.length);
        await runtime.owner.loadBody(destination.id);
        runtime.control.afterSend = async (request, result) => {
          if (request.operation === "moveBlocks" && result.status === "saved")
            throw new Error("Lost block move reply");
        };
        await expect(
          runtime.owner.moveSelectedBlocks(proof, {
            pageId: destination.id,
            parentId: null,
            beforeBlockId: null,
          }),
        ).rejects.toThrow("Lost block move reply");
        const exact = await context.db.structure.load(context.environmentId);
        expect(exact.pending.request.operation).toBe("moveBlocks");
        expect(exact.pending.request.input.blockIds).toEqual([container.id, tail.id]);
        expect(exact.pending.observed.pages.length).toBeLessThanOrEqual(8);
        expect(
          (await pageWindow(context, destination.id)).blocks.find(
            (block) => block.id === opaque.id,
          ),
        ).toEqual(opaque);
        expect((await pageMetadata(context, ownedId)).page.spaceId).toBe(other.id);
        await context.run(context.db.close);
        const reopened = await context.run(context.fixture.open());
        const restarted = client(context, reopened);
        await restarted.owner.hydrate();
        expect(restarted.owner.getSnapshot().journal.pending).toEqual(exact.pending);
        await restarted.owner.recover();
        expect(restarted.control.requests).toEqual([]);
        expect(restarted.control.receipts).toEqual(["found"]);
        expect(restarted.control.ids).toBe(0);
        expect(restarted.owner.getSnapshot().journal.history.operation).toBe("moveBlocks");
        await restarted.owner.compensate("undo");
        expect(
          (await pageWindow(context, source.id)).blocks
            .filter((block) => block.parentId === null)
            .map((block) => block.id),
        ).toEqual([container.id, tail.id, anchor.id]);
        expect((await pageMetadata(context, ownedId)).page.spaceId).toBe(space.id);
        await restarted.owner.compensate("redo");
        const current = await pageWindow(context, destination.id);
        expect(
          current.blocks.filter((block) => block.parentId === null).map((block) => block.id),
        ).toEqual([container.id, tail.id]);
        expect(current.blocks.find((block) => block.id === opaque.id)).toEqual(opaque);
        expect((await reopened.structure.load(context.environmentId)).pending).toBeNull();
      }),
    ),
);

it.effect(
  "refuses mobile mixed/partial/stale/cyclic block contexts, live feature/permission withdrawal and hidden edits, then retains stale closure conflict exactly",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const source = await root(context, runtime, space, "Refused block source");
        const destination = await root(context, runtime, space, "Refused block destination");
        const deepDestination = await root(context, runtime, space, "Depth boundary destination");
        const chain = Array.from({ length: context.capability.limits.maxDepth }, (_, index) => ({
          ...paragraph(`depth-list-${index}`),
          type: "bulleted_item",
          parentId: index === 0 ? null : SpaceBlockId.make(`depth-list-${index - 1}`),
          order: (index + 1).toString(16).padStart(32, "0"),
        }));
        await seedBlocks(context, deepDestination, chain);
        const list = {
          ...paragraph("guard-list"),
          type: "bulleted_item",
          order: "20000000000000000000000000000000",
        };
        const nested = {
          ...paragraph("guard-nested-list"),
          type: "bulleted_item",
          parentId: list.id,
          order: "40000000000000000000000000000000",
        };
        const middle = { ...paragraph("guard-middle"), order: "60000000000000000000000000000000" };
        const tail = { ...paragraph("guard-tail"), order: "80000000000000000000000000000000" };
        await seedBlocks(context, source, [list, nested, middle, tail]);
        const destinationText = paragraph("dirty-block-destination");
        await seedBlocks(context, destination, [destinationText]);
        let metadata = await pageMetadata(context, source.id);
        let window = await pageWindow(context, source.id);
        const before = runtime.control.requests.length;
        await expect(
          selectMobileSpacesBlockMove(runtime.owner, metadata.page, window, [list.id, tail.id]),
        ).rejects.toThrow("Mixed or noncontiguous");
        await expect(
          selectMobileSpacesBlockMove(runtime.owner, metadata.page, window, [list.id, nested.id]),
        ).rejects.toThrow("ancestor and descendant");
        const partial = await context.run(
          context.service.readBlocks({
            environmentId: context.environmentId,
            pageId: source.id,
            revision: metadata.page.revision,
            limit: 1,
          }),
        );
        await expect(
          selectMobileSpacesBlockMove(runtime.owner, metadata.page, partial, [list.id]),
        ).rejects.toThrow("complete loaded window");
        runtime.control.capability = {
          ...context.capability,
          features: { ...context.capability.features, blockMoves: undefined },
        };
        await expect(
          selectMobileSpacesBlockMove(runtime.owner, metadata.page, window, [list.id]),
        ).rejects.toThrow("does not advertise block moves");
        runtime.control.capability = context.capability;
        const cyclic = await selectMobileSpacesBlockMove(runtime.owner, metadata.page, window, [
          list.id,
        ]);
        await expect(
          runtime.owner.moveSelectedBlocks(cyclic, {
            pageId: source.id,
            parentId: nested.id,
            beforeBlockId: null,
          }),
        ).rejects.toThrow("intersects the selected subtree");
        await runtime.owner.loadBody(deepDestination.id);
        await expect(
          runtime.owner.moveSelectedBlocks(cyclic, {
            pageId: deepDestination.id,
            parentId: chain.at(-1).id,
            beforeBlockId: null,
          }),
        ).rejects.toMatchObject({ _tag: "SpaceLimitExceededError", limit: "maxDepth" });
        await seedBlocks(context, source, [
          { ...paragraph("changed-source"), order: "90000000000000000000000000000000" },
        ]);
        await expect(
          selectMobileSpacesBlockMove(runtime.owner, metadata.page, window, [list.id]),
        ).rejects.toThrow("current complete source window");
        metadata = await pageMetadata(context, source.id);
        window = await pageWindow(context, source.id);
        const proof = await selectMobileSpacesBlockMove(runtime.owner, metadata.page, window, [
          list.id,
        ]);
        await runtime.owner.loadBody(destination.id);
        runtime.control.writable = false;
        await expect(
          runtime.owner.moveSelectedBlocks(proof, {
            pageId: destination.id,
            parentId: null,
            beforeBlockId: null,
          }),
        ).rejects.toThrow("permission");
        runtime.control.writable = true;
        expect(runtime.control.requests).toHaveLength(before);
        const lease = runtime.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: destination.id,
        });
        await lease.reader.first();
        lease.reader.session.apply([
          {
            kind: "replace",
            block: {
              ...destinationText,
              content: { runs: [{ text: "Hidden move draft", marks: [] }] },
            },
          },
        ]);
        await lease.reader.session.persistDraft();
        lease.release();
        await context.run(context.db.close);
        const reopened = await context.run(context.fixture.open());
        const restarted = client(context, reopened);
        const fresh = await selectMobileSpacesBlockMove(restarted.owner, metadata.page, window, [
          list.id,
        ]);
        await restarted.owner.loadBody(destination.id);
        await expect(
          restarted.owner.moveSelectedBlocks(fresh, {
            pageId: destination.id,
            parentId: null,
            beforeBlockId: null,
          }),
        ).rejects.toThrow("retained draft");
        expect(restarted.control.draftReads).toContain(destination.id);
        expect(restarted.control.requests).toEqual([]);
        const draftOwner = restarted.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: destination.id,
        });
        await draftOwner.reader.first();
        await draftOwner.reader.session.discardDraft(await pageWindow(context, destination.id));
        draftOwner.release();
        await restarted.owner.loadBody(destination.id);
        await expect(
          restarted.owner.moveSelectedBlocks(fresh, {
            pageId: destination.id,
            parentId: null,
            beforeBlockId: SpaceBlockId.make("missing-block-anchor"),
          }),
        ).rejects.toThrow("known list placement");
        restarted.control.afterStore = async (journal) => {
          if (journal.pending?.request.operation !== "moveBlocks") return;
          restarted.control.afterStore = null;
          const inspection = await context.run(
            context.service.inspectStructure({
              environmentId: context.environmentId,
              target: { kind: "blocks", pageId: source.id, blockIds: [] },
              destination: {
                kind: "child",
                placement: { pageId: source.id, parentId: list.id, beforeBlockId: null },
              },
            }),
          );
          const admission = await context.run(
            context.service.listSpaces({ environmentId: context.environmentId, limit: 1 }),
          );
          const created = await context.run(
            context.service.createChildPage({
              environmentId: context.environmentId,
              title: "Remote closure change",
              placement: { pageId: source.id, parentId: list.id, beforeBlockId: null },
              guards: inspection.guards,
              mutationId: NodeCrypto.randomUUID(),
              receiptEpoch: admission.mutationAdmission.epoch,
            }),
          );
          expect(created.status).toBe("saved");
        };
        await restarted.owner.moveSelectedBlocks(fresh, {
          pageId: destination.id,
          parentId: null,
          beforeBlockId: null,
        });
        const retained = await reopened.structure.load(context.environmentId);
        expect(retained.pending.conflict).toBe(true);
        expect(retained.pending.request.input.blockIds).toEqual([list.id]);
        expect(
          (await pageWindow(context, source.id)).blocks.some((block) => block.id === list.id),
        ).toBe(true);
        expect((await pageWindow(context, destination.id)).blocks.map((block) => block.id)).toEqual(
          [destinationText.id],
        );
        await expect(restarted.owner.recover()).rejects.toThrow("No uncertain placement");
        expect((await reopened.structure.load(context.environmentId)).pending).toEqual(
          retained.pending,
        );
      }),
    ),
);

it.effect(
  "requires exact irreversible purge confirmation and rejects replaced previews, withdrawn access and changed batches with frozen guards",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const page = await root(context, runtime, space, "Purge named parent");
        const nested = await child(context, runtime, page, "Independent purge child");
        await recoverPage(runtime, nested.id, "trash");
        await recoverPage(runtime, page.id, "trash");
        await runtime.owner.previewRecovery(page.id, "permanentlyDelete");
        const first = runtime.owner.getSnapshot().recoveryPreview;
        expect(new Set(first.inspection.recovery.pageIds)).toEqual(new Set([page.id, nested.id]));
        const before = runtime.control.requests.length;
        await expect(runtime.owner.confirmRecovery(first)).rejects.toThrow(
          "explicit irreversible confirmation",
        );
        await runtime.owner.previewRecovery(nested.id, "restore");
        await expect(runtime.owner.confirmRecovery(first, true)).rejects.toThrow(
          "Inspect the current recovery selection",
        );
        await runtime.owner.previewRecovery(page.id, "permanentlyDelete");
        const frozen = runtime.owner.getSnapshot().recoveryPreview;
        runtime.control.writable = false;
        await expect(runtime.owner.confirmRecovery(frozen, true)).rejects.toThrow("permission");
        runtime.control.writable = true;
        expect(runtime.control.requests).toHaveLength(before);
        await externalRecovery(context, page.id, "restore");
        await externalRecovery(context, page.id, "trash");
        await runtime.owner.confirmRecovery(frozen, true);
        const journal = await context.db.structure.load(context.environmentId);
        expect(journal.pending.conflict).toBe(true);
        expect(journal.pending.request.operation).toBe("permanentlyDeletePage");
        expect(journal.pending.request.input.guards).toEqual(frozen.inspection.guards);
        expect((await trashedPage(context, page.id)).id).toBe(page.id);
        expect((await trashedPage(context, nested.id)).id).toBe(nested.id);
        expect(
          (
            await context.run(
              context.service.resolveReference({
                environmentId: context.environmentId,
                target: { kind: "page", pageId: page.id },
              }),
            )
          ).status,
        ).toBe("trashed");
      }),
    ),
);

it.effect(
  "keeps deleted resident content readonly only after authoritative tombstone proof and recovers a failed final purge journal across reopen without resend",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const page = await root(context, runtime, space, "Mounted purge page");
        const block = paragraph("purged-resident-text");
        await seedBlock(context, page, block);
        {
          using screen = acquiringPageScreen(context, runtime, page);
          screen.render();
          await act(async () => {
            await screen.attempts[0];
          });
          const reader = screen.leases[0].reader;
          await act(async () => {
            await reader.first();
            await recoverPage(runtime, page.id, "trash");
          });
          runtime.control.failDeletionProof = true;
          await act(async () => {
            await expect(recoverPage(runtime, page.id, "permanentlyDelete", true)).rejects.toThrow(
              "Some affected pages could not refresh",
            );
          });
          expect(reader.getSnapshot().unavailable).not.toBe("deleted");
          expect(reader.getSnapshot().error).toContain("Deletion proof delivery failed");
          expect((await context.db.structure.load(context.environmentId)).pending).toBeNull();
          runtime.control.failDeletionProof = false;
          await act(async () => {
            await reader.first();
          });
          expect(reader.getSnapshot().unavailable).toBe("deleted");
          expect(reader.getSnapshot().error).toBeNull();
          expect(reader.session.getSnapshot().blocks).toEqual([block]);
          expect(() => reader.editing.focus(Symbol(), block.id)).toThrow("permanently deleted");
          expect(screen.releases).toBe(0);
          expect(screen.attempts).toHaveLength(1);
        }
        const exactPage = await root(context, runtime, space, "Purge journal recovery");
        const nested = await child(context, runtime, exactPage, "Purge subtree");
        await recoverPage(runtime, exactPage.id, "trash");
        runtime.control.afterSend = async (request, result) => {
          if (request.operation === "permanentlyDeletePage" && result.status === "saved")
            context.fixture.control.beforeCommit = async () => {
              throw new Error("Final purge journal COMMIT failed");
            };
        };
        await expect(
          recoverPage(runtime, exactPage.id, "permanentlyDelete", true),
        ).rejects.toBeDefined();
        const pending = await context.db.structure.load(context.environmentId);
        expect(pending.pending.request.operation).toBe("permanentlyDeletePage");
        expect(pending.pending.recoveryPageIds).toEqual(
          expect.arrayContaining([exactPage.id, nested.id]),
        );
        context.fixture.control.beforeCommit = null;
        await context.run(context.db.close);
        const reopened = await context.run(context.fixture.open());
        const restarted = client(context, reopened);
        await restarted.owner.hydrate();
        expect(restarted.owner.getSnapshot().journal.pending).toEqual(pending.pending);
        await restarted.owner.recover();
        expect(restarted.control.receipts).toEqual(["found"]);
        expect(restarted.control.requests).toEqual([]);
        expect(restarted.control.ids).toBe(0);
        expect((await reopened.structure.load(context.environmentId)).pending).toBeNull();
        expect(restarted.owner.getSnapshot().journal.history).toBeNull();
        for (const pageId of [exactPage.id, nested.id])
          expect(
            await context.run(
              context.service.resolveReference({
                environmentId: context.environmentId,
                target: { kind: "page", pageId },
              }),
            ),
          ).toEqual({ status: "deleted" });
        const cold = await acquireHydratedSpacesPageReader(
          { environmentId: context.environmentId, spaceId: space.id, pageId: exactPage.id },
          restarted.access(),
          new AbortController().signal,
          { documents: restarted.documents, hydrate: () => restarted.owner.hydrate() },
        );
        try {
          await cold.reader.first();
          expect(cold.reader.getSnapshot().unavailable).toBe("deleted");
          expect(cold.reader.session.getSnapshot().hydrated).toBe(false);
        } finally {
          cold.release();
        }
      }),
    ),
);

it.effect(
  "restores and visibility-undoes an authoritatively trashed mounted reader while genuine refresh failures and dirty drafts stay gated",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const runtime = client(context);
        const space = await defaultSpace(context);
        const page = await root(context, runtime, space, "Mounted Trash recovery");
        const block = paragraph("mounted-trash-text");
        await seedBlock(context, page, block);
        using screen = acquiringPageScreen(context, runtime, page);
        screen.render();
        await act(async () => {
          await screen.attempts[0];
        });
        const reader = screen.leases[0].reader;
        await act(async () => {
          await reader.first();
        });
        const session = reader.session;
        let trashFailure = null;
        await act(async () => {
          try {
            await recoverPage(runtime, page.id, "trash");
          } catch (error) {
            trashFailure = error;
            expect(error.message).toContain("Some affected pages could not refresh");
          }
        });
        const afterTrash = reader.getSnapshot();
        expect((await trashedPage(context, page.id)).trash).toBeDefined();
        expect((await context.db.structure.load(context.environmentId)).pending).toBeNull();
        await act(async () => {
          await recoverPage(runtime, page.id, "restore");
        });
        expect(trashFailure).toBeNull();
        expect(afterTrash.unavailable).toBe("trashed");
        expect(afterTrash.error).toBeNull();
        expect(reader.getSnapshot().unavailable).toBeNull();
        expect(reader.getSnapshot().location.page.id).toBe(page.id);
        await act(async () => {
          await runtime.owner.compensate("undo");
        });
        expect(reader.getSnapshot().unavailable).toBe("trashed");
        expect(() => reader.editing.focus(Symbol(), block.id)).toThrow("Trash");
        await act(async () => {
          await runtime.owner.compensate("redo");
        });
        expect(reader.getSnapshot().unavailable).toBeNull();
        expect((await pageMetadata(context, page.id)).page.trash).toBeUndefined();
        expect(reader.session).toBe(session);
        expect(screen.attempts).toHaveLength(1);
        expect(screen.releases).toBe(0);
        runtime.control.failReads.add(page.id);
        await act(async () => {
          await expect(reader.refreshStructure()).rejects.toThrow("could not be delivered");
        });
        runtime.control.failReads.delete(page.id);
        const beforeFailure = runtime.control.requests.length;
        await runtime.owner.previewRecovery(page.id, "trash");
        await expect(
          runtime.owner.confirmRecovery(runtime.owner.getSnapshot().recoveryPreview),
        ).rejects.toThrow("affected page draft");
        expect(reader.getSnapshot().error).toContain("could not be delivered");
        expect(runtime.control.requests).toHaveLength(beforeFailure);
        expect((await context.db.structure.load(context.environmentId)).pending).toBeNull();
        await act(async () => {
          await reader.first();
        });
        await act(async () => {
          session.apply([
            {
              kind: "replace",
              block: {
                ...block,
                content: { runs: [{ text: "Retained dirty resident", marks: [] }] },
              },
            },
          ]);
          await session.persistDraft();
        });
        await runtime.owner.previewRecovery(page.id, "trash");
        await expect(
          runtime.owner.confirmRecovery(runtime.owner.getSnapshot().recoveryPreview),
        ).rejects.toThrow("affected page draft");
        expect(runtime.control.requests).toHaveLength(beforeFailure);
        expect(
          (await context.db.store.load({ environmentId: context.environmentId, pageId: page.id }))
            .mutations,
        ).toHaveLength(1);
        expect(session.getSnapshot().dirty).toBe(true);
        expect(screen.releases).toBe(0);
      }),
    ),
);

it.effect(
  "restores a pristine cold Trash reader but retains an unknown pending SQLite draft before hydration or admission",
  () =>
    withFixture((context) =>
      Effect.promise(async () => {
        const initial = client(context);
        const space = await defaultSpace(context);
        const clean = await root(context, initial, space, "Cold clean Trash page");
        const pendingPage = await root(context, initial, space, "Cold pending Trash page");
        const block = paragraph("cold-pending-text");
        await seedBlock(context, pendingPage, block);
        const old = initial.documents.acquire({
          environmentId: context.environmentId,
          spaceId: space.id,
          pageId: pendingPage.id,
        });
        await old.reader.first();
        old.reader.session.apply([
          {
            kind: "replace",
            block: {
              ...block,
              content: { runs: [{ text: "Unknown save must remain", marks: [] }] },
            },
          },
        ]);
        initial.control.afterContentSend = async () => {
          throw new Error("Lost actual content ACK");
        };
        await expect(old.reader.session.save()).rejects.toThrow("Lost actual content ACK");
        const key = { environmentId: context.environmentId, pageId: pendingPage.id };
        const retained = await context.db.store.load(key);
        expect(retained.pending).not.toBeNull();
        for (const page of [clean, pendingPage]) {
          const inspection = await context.run(
            context.service.inspectStructure({
              environmentId: context.environmentId,
              target: { kind: "page", pageId: page.id },
              recovery: "trash",
            }),
          );
          const admission = await context.run(
            context.service.listSpaces({ environmentId: context.environmentId, limit: 1 }),
          );
          const result = await context.run(
            context.service.trashPage({
              environmentId: context.environmentId,
              pageId: page.id,
              guards: inspection.guards,
              receiptEpoch: admission.mutationAdmission.epoch,
              mutationId: NodeCrypto.randomUUID(),
            }),
          );
          expect(result.status).toBe("saved");
        }
        old.release();
        await context.run(context.db.close);
        const reopened = await context.run(context.fixture.open());
        const restarted = client(context, reopened);
        const blocked = await acquireHydratedSpacesPageReader(
          { environmentId: context.environmentId, spaceId: space.id, pageId: pendingPage.id },
          restarted.access(),
          new AbortController().signal,
          { documents: restarted.documents, hydrate: () => restarted.owner.hydrate() },
        );
        const cold = await acquireHydratedSpacesPageReader(
          { environmentId: context.environmentId, spaceId: space.id, pageId: clean.id },
          restarted.access(),
          new AbortController().signal,
          { documents: restarted.documents, hydrate: () => restarted.owner.hydrate() },
        );
        try {
          await blocked.reader.first();
          expect(blocked.reader.getSnapshot().unavailable).toBe("trashed");
          expect(blocked.reader.session.getSnapshot().hydrated).toBe(false);
          await restarted.owner.previewRecovery(pendingPage.id, "restore");
          await expect(
            restarted.owner.confirmRecovery(restarted.owner.getSnapshot().recoveryPreview),
          ).rejects.toThrow("retained draft");
          expect(restarted.control.requests).toEqual([]);
          expect(restarted.control.ids).toBe(0);
          expect(await reopened.store.load(key)).toEqual(retained);
          expect(restarted.owner.getSnapshot().journal.pending).toBeNull();
          await cold.reader.first();
          expect(cold.reader.session.getSnapshot().hydrated).toBe(false);
          await recoverPage(restarted, clean.id, "restore");
          expect(cold.reader.getSnapshot().unavailable).toBeNull();
          expect(cold.reader.getSnapshot().location.page.id).toBe(clean.id);
          expect(cold.reader.session.getSnapshot().hydrated).toBe(true);
          expect(await reopened.store.load(key)).toEqual(retained);
        } finally {
          blocked.release();
          cold.release();
        }
      }),
    ),
);

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
          using screen = acquiringPageScreen(context, restarted, page);
          const { attempts, leases } = screen;
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
          expect(screen.releases).toBe(0);
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
    afterContentSend: null,
    beforeDraftWrite: null,
    contentRequests: [],
    contentAdmissions: 0,
    contentReceipts: [],
    failReads: new Set(),
    refreshed: [],
    changed: 0,
    draftReads: [],
    maxRows: capability.limits.maxListRows,
    capability,
    failDeletionProof: false,
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
      capability: control.capability,
      current: () => control.connected && control.generation === generation,
    };
  };
  let owner;
  const documents = new MobileSpaceDocuments((target) => {
    const key = { environmentId, pageId: target.pageId };
    let reader;
    const session = new SpaceDocumentSession(key, {
      drafts: {
        load: db.store.load,
        write: async (draftKey, draft) => {
          await control.beforeDraftWrite?.(draftKey, draft);
          await db.store.write(draftKey, draft);
        },
      },
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
        getPage: (input) => {
          control.contentAdmissions++;
          return read(service.getPage(input));
        },
        applyBlockBatch: async (input) => {
          const stored = await db.store.load(key);
          expect(stored.pending).toMatchObject({
            mutationId: input.mutationId,
            receiptEpoch: input.receiptEpoch,
            baseRevision: input.baseRevision,
            generation: input.generation,
            mutations: input.mutations,
          });
          control.contentRequests.push(structuredClone(input));
          const result = await run(service.applyBlockBatch(input));
          await control.afterContentSend?.(input, result);
          return result;
        },
        lookupMutationReceipt: async (input) => {
          const result = await read(service.lookupMutationReceipt(input));
          control.contentReceipts.push(result.status);
          return result;
        },
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
      confirmDeleted: async () => {
        const result = await read(
          service.resolveReference({
            environmentId,
            target: { kind: "page", pageId: target.pageId },
          }),
        );
        if (control.failDeletionProof) throw new Error("Deletion proof delivery failed");
        return result.status === "deleted";
      },
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
    capability: () => control.capability,
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
    moveBlocks: (input) => send({ operation: "moveBlocks", input }),
    purge: (input) => send({ operation: "permanentlyDeletePage", input }),
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
async function recoverPage(runtime, pageId, operation, confirmPermanentDeletion = false) {
  await runtime.owner.previewRecovery(pageId, operation);
  const preview = runtime.owner.getSnapshot().recoveryPreview;
  await runtime.owner.confirmRecovery(preview, confirmPermanentDeletion);
  return preview;
}
async function seedBlocks(context, page, blocks) {
  const metadata = await pageMetadata(context, page.id);
  const result = await context.run(
    context.service.applyBlockBatch({
      environmentId: context.environmentId,
      pageId: page.id,
      baseRevision: metadata.page.revision,
      receiptEpoch: metadata.mutationAdmission.epoch,
      mutationId: NodeCrypto.randomUUID(),
      generation: 1,
      mutations: blocks.map((block) => ({ kind: "insert", block })),
    }),
  );
  expect(result.status).toBe("saved");
}
async function externalRecovery(context, pageId, operation) {
  const inspection = await context.run(
    context.service.inspectStructure({
      environmentId: context.environmentId,
      target: { kind: "page", pageId },
      recovery: operation,
    }),
  );
  const admission = await context.run(
    context.service.listSpaces({ environmentId: context.environmentId, limit: 1 }),
  );
  return context.run(
    context.service[operation === "trash" ? "trashPage" : "restorePage"]({
      environmentId: context.environmentId,
      pageId,
      guards: inspection.guards,
      receiptEpoch: admission.mutationAdmission.epoch,
      mutationId: NodeCrypto.randomUUID(),
    }),
  );
}
function legacyOpaque(context, pageId, block) {
  const sql = new NodeSqlite.DatabaseSync(
    NodePath.join(NodePath.dirname(context.fixture.file), "spaces.sqlite"),
  );
  try {
    const previous = sql
      .prepare("SELECT logical_bytes FROM spaces_blocks WHERE block_id = ?")
      .get(block.id);
    const payload = JSON.stringify(block);
    const bytes = new TextEncoder().encode(payload).byteLength;
    sql.exec("BEGIN");
    sql
      .prepare("UPDATE spaces_blocks SET payload = ?, logical_bytes = ? WHERE block_id = ?")
      .run(payload, bytes, block.id);
    sql
      .prepare("UPDATE spaces_pages SET block_bytes = block_bytes + ? WHERE page_id = ?")
      .run(bytes - previous.logical_bytes, pageId);
    sql.exec("COMMIT");
  } finally {
    if (sql.isTransaction) sql.exec("ROLLBACK");
    sql.close();
  }
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
