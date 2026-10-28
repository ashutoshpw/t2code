import { createSpacesEnvironmentAtoms } from "./spaces.ts";
import {
  SpaceId,
  SpaceAssetUploadId,
  SpaceBlockId,
  SpacePageId,
  SpaceMutationId,
  SpaceReceiptEpoch,
  type SpaceCapability,
  type SpaceMoveBlocksInput,
} from "@t2code/contracts/spaces";
import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
  type PeerLinkSummary,
} from "@t2code/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { createPeerLinkEnvironmentAtoms } from "./peerLinks.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect(
    "uses destination operate grants for Spaces writes and revokes availability with the grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthOrchestrationReadScope],
              permissions: [AuthOrchestrationReadScope],
            }),
          );
          registry.set(sessions(other), AsyncResult.success(grant(true)));
          for (const tag of [
            WS_METHODS.spacesAssetsUploadCreate,
            WS_METHODS.spacesAssetsUploadFinalize,
            WS_METHODS.spacesCreate,
            WS_METHODS.spacesRename,
            WS_METHODS.spacesSetDefault,
            WS_METHODS.spacesPagesCreate,
            WS_METHODS.spacesPagesUpdate,
            WS_METHODS.spacesBlocksApply,
            WS_METHODS.spacesPagesCreateChild,
            WS_METHODS.spacesPagesMove,
            WS_METHODS.spacesBlocksMove,
            WS_METHODS.spacesPagesTrash,
            WS_METHODS.spacesPagesRestore,
            WS_METHODS.spacesPagesPermanentlyDelete,
          ]) {
            const permission = createCommandPermissions(runtime, tag);
            expect(registry.get(permission.permissionAtom(env))).toBe(false);
            expect((yield* permission.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
              "EnvironmentAuthorizationError",
            );
            expect(registry.get(permission.permissionAtom(other))).toBe(true);
            yield* permission.authorize(registry, other);
          }
          for (const tag of [WS_METHODS.spacesSearch, WS_METHODS.spacesReferencesResolve]) {
            const search = createCommandPermissions(runtime, tag);
            expect(registry.get(search.permissionAtom(env))).toBe(true);
            yield* search.authorize(registry, env);
            expect(registry.get(search.permissionAtom(other))).toBe(false);
            expect((yield* search.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
              "EnvironmentAuthorizationError",
            );
          }
          registry.set(sessions(env), AsyncResult.success(grant(false)));
          for (const tag of [WS_METHODS.spacesSearch, WS_METHODS.spacesReferencesResolve]) {
            expect(registry.get(createCommandPermissions(runtime, tag).permissionAtom(env))).toBe(
              false,
            );
          }
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          expect(
            registry.get(
              createCommandPermissions(runtime, WS_METHODS.spacesBlocksApply).permissionAtom(other),
            ),
          ).toBe(false);
        }),
      ),
  );

  it.effect("requires the destination preview grant to close a browser tab", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const close = createCommandPermissions(runtime, WS_METHODS.previewClose);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(close.permissionAtom(env))).toBe(false);
        expect((yield* close.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthPreviewOperateScope],
            permissions: [AuthPreviewOperateScope],
          }),
        );
        expect(registry.get(close.permissionAtom(env))).toBe(true);
        yield* close.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(close.permissionAtom(other))).toBe(false);
        expect((yield* close.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );

  it.effect("requires the destination settings grant to run storage cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const cleanup = createCommandPermissions(runtime, WS_METHODS.serverRunStorageCleanup);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(cleanup.permissionAtom(env))).toBe(false);
        expect((yield* cleanup.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(cleanup.permissionAtom(env))).toBe(true);
        yield* cleanup.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(cleanup.permissionAtom(other))).toBe(false);
      }),
    ),
  );

  it.effect("requires the destination settings grant to check OTLP endpoints", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const check = createCommandPermissions(runtime, WS_METHODS.serverCheckOtlpEndpoint);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(check.permissionAtom(env))).toBe(false);
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        expect(registry.get(check.permissionAtom(env))).toBe(true);
        yield* check.authorize(registry, env);
      }),
    ),
  );

  it.effect.each([WS_METHODS.scheduledTasksDelete, ORCHESTRATION_V2_WS_METHODS.stopWorkflow])(
    "uses the target grant for both availability and execution of %s",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const permissions = createCommandPermissions(runtime, method);
          registry.set(sessions(env), AsyncResult.success(grant(true)));
          expect(registry.get(permissions.permissionAtom(env))).toBe(true);
          expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
          yield* permissions.authorize(registry, env);
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          expect(registry.get(permissions.permissionAtom(other))).toBe(false);
          const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
          expect(denied._tag).toBe("EnvironmentAuthorizationError");
        }),
      ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect.each(["commit", "push", "commit_push", "create_pr", "commit_push_pr"] as const)(
  "%s needs thread read permission only when generating a PR from a thread",
  (action) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const command = createCommandPermissions(runtime, WS_METHODS.gitRunStackedAction);
        const input = { actionId: "action", cwd: "/repo", action };
        const withThread = { ...input, threadId: ThreadId.make("thread") };
        const session = {
          ...grant(false),
          scopes: [AuthSourceControlWriteScope],
          permissions: [AuthSourceControlWriteScope],
        };
        registry.set(sessions(env), AsyncResult.success(session));
        expect(registry.get(command.permissionAtom(env, input))).toBe(true);
        yield* command.authorize(registry, env, input);
        const readsThread = action === "create_pr" || action === "commit_push_pr";
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(!readsThread);
        if (readsThread) {
          expect(
            yield* command.authorize(registry, env, withThread).pipe(Effect.flip),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
        } else {
          yield* command.authorize(registry, env, withThread);
        }
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...session,
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationReadScope],
          }),
        );
        expect(registry.get(command.permissionAtom(env, withThread))).toBe(true);
        yield* command.authorize(registry, env, withThread);
      }),
    ),
);

it.effect(
  "refreshes linked environments after permitted writes and blocks a read-only session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const peer: PeerLinkSummary = {
          environmentId: EnvironmentId.make("peer"),
          label: "Box",
          urls: ["https://box.example.test"],
          access: "auto",
          linkedAt: DateTime.makeUnsafe("2026-10-01T12:00:00Z"),
          expiresAt: DateTime.makeUnsafe("2026-10-31T12:00:00Z"),
          lastReachedAt: null,
          lastError: null,
          status: "reachable",
        };
        let links: ReadonlyArray<PeerLinkSummary> = [];
        const client = {
          [WS_METHODS.peerLinksList]: () => Effect.sync(() => ({ links })),
          [WS_METHODS.peerLinksLink]: vi.fn(() =>
            Effect.sync(() => {
              links = [peer];
              return peer;
            }),
          ),
          [WS_METHODS.peerLinksUnlink]: vi.fn(() =>
            Effect.sync(() => {
              links = [];
              return { removed: true };
            }),
          ),
        };
        const supervisor = {
          target: { environmentId: env },
          session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
          state: yield* SubscriptionRef.make({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
          }),
        } as EnvironmentSupervisor["Service"];
        const peerRuntime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (id, effect) => {
              expect(id).toBe(env);
              return Effect.provideService(effect, EnvironmentSupervisor, supervisor);
            },
            followStream: (id, stream) => {
              expect(id).toBe(env);
              return Stream.provideService(stream, EnvironmentSupervisor, supervisor);
            },
          } as EnvironmentRegistry["Service"]),
        );
        const peerLinks = createPeerLinkEnvironmentAtoms(peerRuntime);
        const list = peerLinks.list({ environmentId: env, input: {} });
        registry.mount(list);
        const readLinks = AtomRegistry.getResult(registry, list, { suspendOnWaiting: true });
        const setAccess = (writable: boolean) =>
          registry.set(
            sessions(env),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthAccessReadScope, ...(writable ? [AuthAccessWriteScope] : [])],
              permissions: [AuthAccessReadScope, ...(writable ? [AuthAccessWriteScope] : [])],
            }),
          );
        registry.mount(sessions(other));
        registry.set(
          sessions(other),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthAccessWriteScope],
            permissions: [AuthAccessWriteScope],
          }),
        );
        setAccess(false);
        expect(yield* readLinks).toEqual({ links: [] });
        const linkInput = { url: peer.urls[0]!, pairingCode: "test-code", access: peer.access };
        const link = Effect.promise(() =>
          peerLinks.link.run(registry, { environmentId: env, input: linkInput }),
        );
        const unlink = Effect.promise(() =>
          peerLinks.unlink.run(registry, {
            environmentId: env,
            input: { environmentId: peer.environmentId },
          }),
        );
        expect(registry.get(peerLinks.link.permissionAtom(env))).toBe(false);
        const deniedLink = yield* link;
        expect(deniedLink._tag).toBe("Failure");
        if (deniedLink._tag === "Failure") {
          expect(Cause.squash(deniedLink.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthAccessWriteScope,
          });
        }
        expect(client[WS_METHODS.peerLinksLink]).not.toHaveBeenCalled();
        setAccess(true);
        expect(registry.get(peerLinks.link.permissionAtom(env))).toBe(true);
        expect((yield* link)._tag).toBe("Success");
        expect(client[WS_METHODS.peerLinksLink]).toHaveBeenCalledExactlyOnceWith(linkInput);
        expect(yield* readLinks).toEqual({ links: [peer] });

        setAccess(false);
        expect(registry.get(peerLinks.unlink.permissionAtom(env))).toBe(false);
        const deniedUnlink = yield* unlink;
        expect(deniedUnlink._tag).toBe("Failure");
        if (deniedUnlink._tag === "Failure") {
          expect(Cause.squash(deniedUnlink.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthAccessWriteScope,
          });
        }
        expect(client[WS_METHODS.peerLinksUnlink]).not.toHaveBeenCalled();
        expect(yield* readLinks).toEqual({ links: [peer] });
        setAccess(true);
        expect(registry.get(peerLinks.unlink.permissionAtom(env))).toBe(true);
        expect((yield* unlink)._tag).toBe("Success");
        expect(client[WS_METHODS.peerLinksUnlink]).toHaveBeenCalledExactlyOnceWith({
          environmentId: peer.environmentId,
        });
        expect(yield* readLinks).toEqual({ links: [] });
      }),
    ),
);

it.effect("requires access management to answer a link request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      registry.set(sessions(env), AsyncResult.success(grant(true)));
      const answer = createCommandPermissions(runtime, WS_METHODS.peerLinksAnswerRequest);
      expect(registry.get(answer.permissionAtom(env))).toBe(false);
      expect((yield* answer.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
        AuthAccessWriteScope,
      );
      registry.set(
        sessions(env),
        AsyncResult.success({
          ...grant(false),
          scopes: [AuthAccessWriteScope],
          permissions: [AuthAccessWriteScope],
        }),
      );
      expect(registry.get(answer.permissionAtom(env))).toBe(true);
      yield* answer.authorize(registry, env);
    }),
  ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

it.effect.each([
  "moveBlocks",
  "createSpace",
  "renameSpace",
  "setDefaultSpace",
  "createPage",
  "updatePage",
  "trashPage",
  "restorePage",
  "createChild",
  "permanentlyDeletePage",
] as const)(
  "checks the latest %s capability after destination authorization before reaching the transport",
  (operation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        let calls = 0;
        const reachedTransport = () =>
          Effect.sync(() => {
            calls++;
            throw new Error("Transport reached");
          });
        const transport = {
          client: {
            [WS_METHODS.spacesBlocksMove]: reachedTransport,
            [WS_METHODS.spacesCreate]: reachedTransport,
            [WS_METHODS.spacesRename]: reachedTransport,
            [WS_METHODS.spacesSetDefault]: reachedTransport,
            [WS_METHODS.spacesPagesCreate]: reachedTransport,
            [WS_METHODS.spacesPagesUpdate]: reachedTransport,
            [WS_METHODS.spacesPagesCreateChild]: reachedTransport,
            [WS_METHODS.spacesPagesTrash]: reachedTransport,
            [WS_METHODS.spacesPagesRestore]: reachedTransport,
            [WS_METHODS.spacesPagesPermanentlyDelete]: reachedTransport,
          },
        } as unknown as RpcSession;
        const supervisor = {
          target: { environmentId: env, label: "destination" },
          session: yield* SubscriptionRef.make(Option.some(transport)),
        } as unknown as EnvironmentSupervisor["Service"];
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (_id: EnvironmentId, operation: Effect.Effect<unknown>) =>
              Effect.provideService(operation, EnvironmentSupervisor, supervisor),
          } as unknown as EnvironmentRegistry["Service"]),
        );
        const capability = Atom.make<SpaceCapability | undefined>(undefined);
        const spaces = createSpacesEnvironmentAtoms(runtime, { capabilityAtom: () => capability });
        const input: SpaceMoveBlocksInput = {
          environmentId: env,
          sourcePageId: SpacePageId.make("source"),
          blockIds: [SpaceBlockId.make("root")],
          destination: {
            pageId: SpacePageId.make("destination"),
            parentId: null,
            beforeBlockId: null,
          },
          guards: { pages: [], roots: [] },
          mutationId: SpaceMutationId.make("move"),
          receiptEpoch: SpaceReceiptEpoch.make("epoch"),
        };
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const run = () =>
          Effect.promise(async () => {
            const metadata = {
              environmentId: env,
              mutationId: input.mutationId,
              receiptEpoch: input.receiptEpoch,
            };
            const spaceId = SpaceId.make("selected");
            if (operation === "createSpace")
              return spaces.createSpace.run(registry, {
                environmentId: env,
                input: { ...metadata, title: "New" },
              });
            if (operation === "renameSpace")
              return spaces.renameSpace.run(registry, {
                environmentId: env,
                input: { ...metadata, spaceId, baseRevision: 0, title: "Rename" },
              });
            if (operation === "setDefaultSpace")
              return spaces.setDefaultSpace.run(registry, {
                environmentId: env,
                input: {
                  ...metadata,
                  spaceId,
                  baseRevision: 0,
                  defaultSpaceId: SpaceId.make("default"),
                  baseDefaultRevision: 0,
                },
              });
            if (operation === "createPage")
              return spaces.createPage.run(registry, {
                environmentId: env,
                input: { ...metadata, spaceId, baseRootOrderRevision: 0, title: "Root" },
              });
            if (operation === "updatePage")
              return spaces.updatePage.run(registry, {
                environmentId: env,
                input: {
                  ...metadata,
                  pageId: input.sourcePageId,
                  baseRevision: 0,
                  title: "Rename",
                },
              });
            if (operation === "moveBlocks")
              return spaces.moveBlocks.run(registry, { environmentId: env, input });
            if (operation === "createChild")
              return spaces.createChild.run(registry, {
                environmentId: env,
                input: {
                  environmentId: env,
                  mutationId: input.mutationId,
                  receiptEpoch: input.receiptEpoch,
                  guards: input.guards,
                  title: "Child",
                  placement: input.destination,
                },
              });
            return spaces[operation].run(registry, {
              environmentId: env,
              input: {
                environmentId: env,
                mutationId: input.mutationId,
                receiptEpoch: input.receiptEpoch,
                guards: input.guards,
                pageId: input.sourcePageId,
              },
            });
          });
        const missing = yield* run();
        expect(missing._tag).toBe("Failure");
        if (missing._tag === "Failure")
          expect(Cause.squash(missing.cause)).toMatchObject({
            _tag: "SpacesUnavailableError",
            stage: "settings",
          });
        const old = { version: 2, limits: {} } as SpaceCapability;
        registry.set(capability, { ...old, version: 1 });
        yield* run();
        const library = [
          "createSpace",
          "renameSpace",
          "setDefaultSpace",
          "createPage",
          "updatePage",
        ].includes(operation);
        expect(calls).toBe(library ? 1 : 0);
        calls = 0;
        registry.set(capability, old);
        yield* run();
        expect(calls).toBe(operation === "createChild" || library ? 1 : 0);
        calls = 0;
        registry.set(capability, {
          ...old,
          version: 3,
          features: { blockMoves: true, recovery: true },
        });
        yield* run();
        expect(calls).toBe(0);
        registry.set(capability, { ...old, features: { blockMoves: true, recovery: true } });
        const reached = yield* run();
        expect(reached._tag).toBe("Failure");
        expect(calls).toBe(1);
        registry.set(capability, undefined);
        yield* run();
        expect(calls).toBe(1);
        registry.set(capability, { ...old, features: { blockMoves: true, recovery: true } });
        registry.set(sessions(env), AsyncResult.success(grant(false)));
        yield* run();
        expect(calls).toBe(1);
      }),
    ),
);

it.effect.each(["search", "resolve", "createImageUpload", "finalizeImageUpload"] as const)(
  "uses the latest destination grant and exact %s capability at the real command boundary",
  (operation) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const image = operation === "createImageUpload" || operation === "finalizeImageUpload";
        let calls = 0;
        const reached = () =>
          Effect.sync(() => {
            calls++;
            throw Error("Transport reached");
          });
        const transport = {
          client: {
            [WS_METHODS.spacesSearch]: reached,
            [WS_METHODS.spacesReferencesResolve]: reached,
            [WS_METHODS.spacesAssetsUploadCreate]: reached,
            [WS_METHODS.spacesAssetsUploadFinalize]: reached,
          },
        } as unknown as RpcSession;
        const supervisor = {
          target: { environmentId: env, label: "destination" },
          session: yield* SubscriptionRef.make(Option.some(transport)),
        } as unknown as EnvironmentSupervisor["Service"];
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
              Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          } as unknown as EnvironmentRegistry["Service"]),
        );
        const capability = Atom.make<SpaceCapability | undefined>(undefined),
          spaces = createSpacesEnvironmentAtoms(runtime, { capabilityAtom: () => capability });
        const run = () =>
          Effect.promise(async () =>
            operation === "createImageUpload"
              ? spaces.createImageUpload.run(registry, {
                  environmentId: env,
                  input: {
                    environmentId: env,
                    requestId: "image",
                    expectedBytes: 68,
                    mimeType: "image/png",
                    mediaKind: "image",
                    name: "image.png",
                  },
                })
              : operation === "finalizeImageUpload"
                ? spaces.finalizeImageUpload.run(registry, {
                    environmentId: env,
                    input: { environmentId: env, uploadId: SpaceAssetUploadId.make("upload") },
                  })
                : operation === "search"
                  ? spaces.search.run(registry, {
                      environmentId: env,
                      input: { environmentId: env, query: "word" },
                    })
                  : spaces.resolve.run(registry, {
                      environmentId: env,
                      input: {
                        environmentId: env,
                        target: { kind: "page", pageId: SpacePageId.make("page") },
                      },
                    }),
          );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthOrchestrationReadScope],
            permissions: [AuthOrchestrationReadScope],
          }),
        );
        if (image) registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* run();
        registry.set(capability, { version: 1, limits: {} } as SpaceCapability);
        yield* run();
        registry.set(capability, { version: 2, limits: {} } as SpaceCapability);
        yield* run();
        expect(calls).toBe(0);
        registry.set(capability, {
          version: 2,
          features: { search: true, referenceResolution: true, assets: true },
          limits: { assets: {} },
        } as SpaceCapability);
        yield* run();
        expect(calls).toBe(1);
        registry.set(capability, undefined);
        yield* run();
        expect(calls).toBe(1);
        registry.set(capability, {
          version: 3,
          features: { search: true, referenceResolution: true, assets: true },
          limits: { assets: {} },
        } as SpaceCapability);
        yield* run();
        expect(calls).toBe(1);
        registry.set(capability, {
          version: 2,
          features: { search: true, referenceResolution: true, assets: true },
          limits: { assets: {} },
        } as SpaceCapability);
        registry.set(
          sessions(env),
          AsyncResult.success(
            image
              ? {
                  ...grant(false),
                  scopes: [AuthOrchestrationReadScope],
                  permissions: [AuthOrchestrationReadScope],
                }
              : grant(true),
          ),
        );
        yield* run();
        expect(calls).toBe(1);
      }),
    ),
);
