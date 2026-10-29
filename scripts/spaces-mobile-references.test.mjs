import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  ComposerContextId,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "../packages/contracts/src/index.ts";
import { createSpacesEnvironmentAtoms } from "../packages/client-runtime/src/state/spaces.ts";
import { runAtomCommand } from "../packages/client-runtime/src/state/runtime.ts";
import { createEnvironmentSessionAtoms } from "../packages/client-runtime/src/state/session.ts";
import { EnvironmentRegistry } from "../packages/client-runtime/src/connection/registry.ts";
import { EnvironmentSupervisor } from "../packages/client-runtime/src/connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "../packages/client-runtime/src/connection/model.ts";
import { SpaceBlockId } from "../packages/contracts/src/spaces.ts";
import {
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
  prepareSpaceContextSend,
} from "../packages/client-runtime/src/spaces/index.ts";
import { formatComposerContextReference } from "../packages/shared/src/composerContextReferences.ts";
import { MobileSpaceDocuments } from "../apps/mobile/src/features/spaces/documents.ts";
import { SpacesPageReader } from "../apps/mobile/src/features/spaces/reader.ts";
import { MobileSpaceReferenceNavigation } from "../apps/mobile/src/features/spaces/references.ts";
import { createMobileSpaceReferenceController } from "../apps/mobile/src/features/spaces/references.ts";
import { diskDatabase } from "../apps/mobile/src/persistence/mobile-database.test-support.ts";
import { mobileSpacesServiceLayer, promiseRunner } from "./spaces-mobile.test-support.mjs";
import * as SpacesService from "../apps/server/src/spaces/SpacesService.ts";

vi.mock("../packages/client-runtime/src/state/session.ts", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const sessions = Atom.family(() => Atom.make(AsyncResult.initial()));
  return { createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }) };
});

const fixture = Effect.fn("MobileReferencesTest.fixture")(function* (use) {
  const disk = yield* diskDatabase();
  const environmentId = EnvironmentId.make("query-environment");
  yield* Effect.gen(function* () {
    const service = yield* SpacesService.SpacesService;
    const run = yield* promiseRunner();
    const db = yield* disk.open();
    const capability = yield* service.getCapability(environmentId);
    const state = yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
      generation: 1,
      attempt: 1,
    });
    const calls = [];
    const rpc = {
      client: {
        [WS_METHODS.spacesSearch]: (input) =>
          Effect.tryPromise({
            try: () => {
              calls.push(input);
              return run(service.search(input));
            },
            catch: (error) => error,
          }),
        [WS_METHODS.spacesContextCapture]: (input) =>
          Effect.tryPromise({
            try: () => {
              calls.push(input);
              return run(service.captureContextSnapshot(input));
            },
            catch: (error) => error,
          }),
        [WS_METHODS.spacesReferencesResolve]: (input) =>
          Effect.tryPromise({
            try: () => {
              calls.push(input);
              return run(service.resolveReference(input));
            },
            catch: (error) => error,
          }),
      },
    };
    const session = yield* SubscriptionRef.make(Option.some(rpc));
    const supervisor = {
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Query test",
        httpBaseUrl: "https://query.invalid",
        wsBaseUrl: "wss://query.invalid",
      }),
      state,
      session,
    };
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {
        run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      }),
    );
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const cap = Atom.make(capability);
    registry.mount(cap);
    const atoms = createSpacesEnvironmentAtoms(runtime, { capabilityAtom: () => cap });
    const grant = createEnvironmentSessionAtoms(runtime).sessionStateAtom(environmentId);
    registry.mount(grant);
    registry.mount(atoms.changed(environmentId));
    const permissions = (allowed) =>
      registry.set(
        grant,
        AsyncResult.success({
          authenticated: true,
          scopes: allowed ? [AuthOrchestrationReadScope] : [],
          permissions: allowed ? [AuthOrchestrationReadScope] : [],
        }),
      );
    permissions(true);
    const command = async (cmd, input) => {
      const result = await runAtomCommand(
        registry,
        cmd,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    };
    const inline = { value: false };
    const owner = () =>
      createMobileSpaceReferenceController({
        environmentId,
        captureSession: () => command(atoms.captureSession, undefined),
        access: () => ({
          inlineContext: inline.value,
          sourceVersion: registry.get(atoms.changed(environmentId)),
          canRead: registry.get(grant).value.permissions.includes(AuthOrchestrationReadScope),
          capability: registry.get(cap),
        }),
        search: (input) => command(atoms.search, input),
        resolve: (input) => command(atoms.resolve, input),
      });
    let id = 0;
    const root = async (title) => {
      const admission = await run(service.listSpaces({ environmentId }));
      const list = await run(
        service.listPages({ environmentId, spaceId: admission.defaultSpaceId }),
      );
      const result = await run(
        service.createPage({
          environmentId,
          spaceId: admission.defaultSpaceId,
          receiptEpoch: admission.mutationAdmission.epoch,
          mutationId: `root-${++id}`,
          title,
          baseRootOrderRevision: list.space.rootOrderRevision,
        }),
      );
      expect(result.status).toBe("saved");
      return result.page;
    };
    yield* use({
      service,
      run,
      db,
      disk,
      environmentId,
      capability,
      calls,
      registry,
      cap,
      atoms,
      permissions,
      session,
      state,
      rpc,
      owner,
      inline,
      command,
      root,
    });
  }).pipe(Effect.provide(mobileSpacesServiceLayer(disk.file, environmentId)));
}, Effect.scoped);

it.effect(
  "uses actual query commands and SQLite search cursors, revokes results on changed atom/reconnect and checks live optional flags/read grants at dispatch",
  () =>
    fixture((c) =>
      Effect.promise(async () => {
        const page = await c.root("nativesearchneedle");
        const second = await c.root("nativesearchneedle two");
        c.registry.set(c.cap, {
          ...c.capability,
          limits: { ...c.capability.limits, search: { ...c.capability.limits.search, maxRows: 1 } },
        });
        const owner = await c.owner();
        expect(owner.canCapture()).toBe(false);
        expect((await owner.search("nativesearchneedle")).status).toBe("building");
        const first = await owner.search("nativesearchneedle");
        expect(first.status).toBe("ready");
        expect(first.result.items).toHaveLength(1);
        const cursor = first.result.nextCursor;
        expect(cursor).not.toBeNull();
        await expect(
          c.run(
            c.service.search({ environmentId: c.environmentId, query: "other", limit: 1, cursor }),
          ),
        ).rejects.toMatchObject({ reason: "invalid_cursor" });
        const next = await first.next();
        expect(next.status).toBe("ready");
        expect(next.result.items).toHaveLength(1);
        expect(
          new Set([...first.result.items, ...next.result.items].map((hit) => hit.page.id)),
        ).toEqual(new Set([page.id, second.id]));
        c.registry.update(c.atoms.changed(c.environmentId), (value) => value + 1);
        expect(next.current()).toBe(false);
        const before = c.calls.length;
        expect((await next.next()).status).toBe("unavailable");
        expect(c.calls).toHaveLength(before);
        const connected = await c.owner();
        const fresh = await connected.search("nativesearchneedle");
        expect(fresh.status).toBe("ready");
        await c.run(
          SubscriptionRef.set(c.state, {
            ...SubscriptionRef.getUnsafe(c.state),
            generation: 2,
            attempt: 2,
          }),
        );
        expect(fresh.current()).toBe(false);
        const replacement = await c.owner();
        c.permissions(false);
        await expect(
          c.command(c.atoms.search, {
            environmentId: c.environmentId,
            query: "nativesearchneedle",
          }),
        ).rejects.toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(await replacement.resolve({ kind: "page", pageId: page.id })).toBeNull();
        expect(c.calls).toHaveLength(before + 1);
        c.permissions(true);
        c.registry.set(c.cap, { ...c.capability, features: { referenceResolution: true } });
        await expect(
          c.command(c.atoms.search, {
            environmentId: c.environmentId,
            query: "nativesearchneedle",
          }),
        ).rejects.toMatchObject({ _tag: "SpacesUnavailableError" });
        const resolver = await c.owner();
        expect((await resolver.resolve({ kind: "page", pageId: page.id })).current()).toMatchObject(
          { pageId: page.id },
        );
        await c.run(SubscriptionRef.set(c.session, Option.none()));
        expect(resolver.current()).toBe(false);
        owner.dispose();
        connected.dispose();
        replacement.dispose();
        resolver.dispose();
      }),
    ),
);

it.effect(
  "selects native Page/Block context through real capture and opens current identity without replacing a mounted dirty SQLite session",
  () =>
    fixture((c) =>
      Effect.promise(async () => {
        const page = await c.root("nativepickerneedle");
        const key = { environmentId: c.environmentId, pageId: page.id };
        const admission = await c.run(c.service.getPage(key));
        const block = {
          id: SpaceBlockId.make("picker-block"),
          type: "paragraph",
          version: 1,
          parentId: null,
          order: "40000000000000000000000000000000",
          content: { runs: [{ text: "nativepickerneedle saved source", marks: [] }] },
        };
        const seeded = await c.run(
          c.service.applyBlockBatch({
            ...key,
            receiptEpoch: admission.mutationAdmission.epoch,
            mutationId: "seed-picker-block",
            baseRevision: page.revision,
            generation: 1,
            mutations: [{ kind: "insert", block }],
          }),
        );
        expect(seeded.status).toBe("saved");
        c.inline.value = true;
        const owner = await c.owner();
        expect(owner.canCapture()).toBe(true);
        expect((await owner.search("nativepickerneedle")).status).toBe("building");
        const window = await owner.search("nativepickerneedle");
        expect(window.status).toBe("ready");
        const pageIndex = window.result.items.findIndex((item) => !item.blockId);
        const blockIndex = window.result.items.findIndex((item) => item.blockId === block.id);
        expect(pageIndex).toBeGreaterThanOrEqual(0);
        expect(blockIndex).toBeGreaterThanOrEqual(0);
        const pageSelector = window.select(pageIndex, ComposerContextId.make("pick-page"));
        const blockSelector = window.select(blockIndex, ComposerContextId.make("pick-block"), true);
        expect(pageSelector.includeChildPages).toBe(false);
        expect(blockSelector).toMatchObject({
          kind: "block",
          blockId: block.id,
          includeChildPages: true,
        });
        const session = new SpaceDocumentSession(key, {
          drafts: c.db.store,
          createMutationId: () => "reader-mutation",
          maxLoadedBlocks: 100,
          maxMutations: 100,
          adapter: createSpaceServiceSessionAdapter(key, {
            getPage: (input) => c.run(c.service.getPage(input)),
            limits: () => c.capability.limits,
            applyBlockBatch: (input) => c.run(c.service.applyBlockBatch(input)),
            lookupMutationReceipt: (input) => c.run(c.service.lookupMutationReceipt(input)),
          }),
        });
        const access = { availability: "writable", capability: c.capability, current: () => true };
        const documents = new MobileSpaceDocuments(
          (target) =>
            new SpacesPageReader(target, {
              session,
              access,
              locate: async () => {
                const result = await c.run(c.service.getPage(key));
                return { ...result, ancestors: [], current: () => result };
              },
              blocks: (input) => c.run(c.service.readBlocks(input)),
            }),
        );
        const target = { ...key, spaceId: page.spaceId };
        const mounted = documents.acquire(target);
        await mounted.reader.first();
        const dirty = {
          ...block,
          content: { runs: [{ text: "private unsent reader suffix", marks: [] }] },
        };
        session.apply([{ kind: "replace", block: dirty }]);
        await session.persistDraft();
        let captures = 0;
        const prepared = await prepareSpaceContextSend({
          environmentId: c.environmentId,
          text: [pageSelector, blockSelector].map(formatComposerContextReference).join(" "),
          selectors: [pageSelector, blockSelector],
          access: () => ({
            session: owner.current() ? c.rpc : null,
            canRead: owner.current(),
            supportsCapture: owner.canCapture(),
          }),
          isCurrentDraft: () => true,
          capture: (input) => {
            captures++;
            return c.command(c.atoms.capture, input);
          },
        });
        expect(captures).toBe(2);
        expect(prepared.records.map((entry) => entry.snapshot.includeChildPages)).toEqual([
          false,
          true,
        ]);
        expect(prepared.records[1].snapshot.text).toContain("saved source");
        expect(prepared.records[1].snapshot.text).not.toContain("private unsent");
        const opened = [];
        const navigation = new MobileSpaceReferenceNavigation({
          current: () => true,
          open: (destination) => opened.push(documents.acquire(destination)),
        });
        navigation.select(
          {
            environmentId: c.environmentId,
            target: { kind: "block", blockId: blockSelector.blockId },
          },
          () => true,
        );
        await navigation.open(owner, c.environmentId);
        expect(opened).toHaveLength(1);
        expect(opened[0].reader).toBe(mounted.reader);
        expect(session.getSnapshot().blocks).toContainEqual(dirty);
        expect((await c.db.store.load(key)).blocks).toContainEqual(dirty);
        opened[0].release();
        mounted.release();
        navigation.dispose();
        c.inline.value = false;
        expect(window.select(pageIndex, ComposerContextId.make("denied"))).toBeNull();
        expect(owner.current()).toBe(false);
        const library = await c.owner();
        expect(library.canSearch()).toBe(true);
        expect(library.canCapture()).toBe(false);
        const before = captures;
        await expect(
          prepareSpaceContextSend({
            environmentId: c.environmentId,
            text: formatComposerContextReference(pageSelector),
            selectors: [pageSelector],
            isCurrentDraft: () => true,
            access: () => ({
              session: c.rpc,
              canRead: true,
              supportsCapture: library.canCapture(),
            }),
            capture: (input) => {
              captures++;
              return c.command(c.atoms.capture, input);
            },
          }),
        ).rejects.toThrow("unavailable");
        expect(captures).toBe(before);
        const reopened = await c.run(c.disk.open());
        expect((await reopened.store.load(key)).blocks).toContainEqual(dirty);
        owner.dispose();
        library.dispose();
      }),
    ),
);
