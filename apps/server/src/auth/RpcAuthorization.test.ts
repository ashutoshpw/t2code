import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  EnvironmentId,
  ProviderInstanceId,
  SecretProviderId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t2code/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as C from "@t2code/contracts/spaces";
import * as SpacesRpc from "../spaces/Rpc.ts";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      yield* client[WS_METHODS.serverUpdateSettings]({
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("codex_work"),
          instance: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              {
                name: "OPENAI_API_KEY",
                sensitive: true,
                value: {
                  provider: SecretProviderId.make("personal"),
                  reference: "op://Private/OpenAI/credential",
                },
              },
            ],
          },
        },
      });
      expect(handled).toBe(2);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({ patch: { spacesEnabled: true } }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers or secret providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { secretProviders: { [SecretProviderId.make("personal")]: null } },
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("denies every Spaces mutation with read-only grants before its handler", () =>
  Effect.gen(function* () {
    let handled = 0;
    const deniedHandler = () =>
      Effect.sync(() => {
        handled++;
      }).pipe(Effect.andThen(Effect.fail(new C.SpaceValidationError({ reason: "invalid_input" }))));
    const group = SpacesRpc.group.omit(
      WS_METHODS.spacesList,
      WS_METHODS.spacesPagesList,
      WS_METHODS.spacesPagesGet,
      WS_METHODS.spacesBlocksRead,
      WS_METHODS.spacesReceiptsGet,
      WS_METHODS.spacesStructureInspect,
      WS_METHODS.spacesReferencesResolve,
      WS_METHODS.spacesTrashList,
      WS_METHODS.spacesSearch,
      WS_METHODS.spacesAssetsGet,
      WS_METHODS.spacesAssetsUploadGet,
    );
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          group.toLayer({
            "spaces.assets.upload.create": deniedHandler,
            "spaces.assets.upload.finalize": deniedHandler,
            "spaces.create": deniedHandler,
            "spaces.rename": deniedHandler,
            "spaces.setDefault": deniedHandler,
            "spaces.pages.create": deniedHandler,
            "spaces.pages.update": deniedHandler,
            "spaces.blocks.apply": deniedHandler,
            "spaces.pages.createChild": deniedHandler,
            "spaces.pages.move": deniedHandler,
            "spaces.blocks.move": deniedHandler,
            "spaces.pages.trash": deniedHandler,
            "spaces.pages.restore": deniedHandler,
            "spaces.pages.permanentlyDelete": deniedHandler,
          }),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const common = {
      environmentId: EnvironmentId.make("authorization"),
      mutationId: C.SpaceMutationId.make("write"),
      receiptEpoch: C.SpaceReceiptEpoch.make("epoch"),
    };
    const spaceId = C.SpaceId.make("space");
    const pageId = C.SpacePageId.make("page");
    for (const call of [
      client[WS_METHODS.spacesAssetsUploadCreate]({
        environmentId: common.environmentId,
        requestId: "upload",
        expectedBytes: 1,
        mediaKind: "pdf",
        mimeType: "application/pdf",
        name: "report.pdf",
      }),
      client[WS_METHODS.spacesAssetsUploadFinalize]({
        environmentId: common.environmentId,
        uploadId: C.SpaceAssetUploadId.make("upload"),
      }),
      client[WS_METHODS.spacesCreate]({ ...common, title: "" }),
      client[WS_METHODS.spacesRename]({ ...common, spaceId, baseRevision: 0, title: "" }),
      client[WS_METHODS.spacesSetDefault]({
        ...common,
        spaceId,
        baseRevision: 0,
        defaultSpaceId: spaceId,
        baseDefaultRevision: 0,
      }),
      client[WS_METHODS.spacesPagesCreate]({
        ...common,
        spaceId,
        baseRootOrderRevision: 0,
        title: "",
      }),
      client[WS_METHODS.spacesPagesUpdate]({ ...common, pageId, baseRevision: 0, title: "" }),
      client[WS_METHODS.spacesPagesCreateChild]({
        ...common,
        title: "",
        placement: { pageId, parentId: null, beforeBlockId: null },
        guards: { pages: [], roots: [] },
      }),
      client[WS_METHODS.spacesPagesMove]({
        ...common,
        pageId,
        destination: { kind: "root", spaceId, beforePageId: null },
        guards: { pages: [], roots: [] },
      }),
      client[WS_METHODS.spacesBlocksMove]({
        ...common,
        sourcePageId: pageId,
        blockIds: [C.SpaceBlockId.make("block")],
        destination: { pageId, parentId: null, beforeBlockId: null },
        guards: { pages: [], roots: [] },
      }),
      client[WS_METHODS.spacesPagesTrash]({ ...common, pageId, guards: { pages: [], roots: [] } }),
      client[WS_METHODS.spacesPagesRestore]({
        ...common,
        pageId,
        guards: { pages: [], roots: [] },
      }),
      client[WS_METHODS.spacesPagesPermanentlyDelete]({
        ...common,
        pageId,
        guards: { pages: [], roots: [] },
      }),
      client[WS_METHODS.spacesBlocksApply]({
        ...common,
        pageId,
        baseRevision: 0,
        generation: 0,
        mutations: [],
      }),
    ] as ReadonlyArray<
      Effect.Effect<
        unknown,
        C.SpaceServiceError | import("@t2code/contracts").EnvironmentAuthorizationError
      >
    >) {
      const failure = yield* call.pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
      );
      expect(failure).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
    }
    expect(handled).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("keeps Spaces reads behind read scope even for operate-only clients", () =>
  Effect.gen(function* () {
    let handled = 0;
    const deniedHandler = () =>
      Effect.sync(() => {
        handled++;
      }).pipe(Effect.andThen(Effect.fail(new C.SpaceValidationError({ reason: "invalid_input" }))));
    const group = SpacesRpc.group.omit(
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
      WS_METHODS.spacesAssetsUploadCreate,
      WS_METHODS.spacesAssetsUploadFinalize,
    );
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.merge(
          group.toLayer({
            "spaces.assets.get": deniedHandler,
            "spaces.assets.upload.get": deniedHandler,
            "spaces.list": deniedHandler,
            "spaces.pages.list": deniedHandler,
            "spaces.pages.get": deniedHandler,
            "spaces.blocks.read": deniedHandler,
            "spaces.receipts.get": deniedHandler,
            "spaces.structure.inspect": deniedHandler,
            "spaces.references.resolve": deniedHandler,
            "spaces.trash.list": deniedHandler,
            "spaces.search": deniedHandler,
          }),
          RpcAuthorization.layer([AuthOrchestrationOperateScope]),
        ),
      ),
    );
    const environmentId = EnvironmentId.make("authorization");
    const pageId = C.SpacePageId.make("page");
    for (const call of [
      client[WS_METHODS.spacesAssetsGet]({ environmentId, assetId: C.SpaceAssetId.make("asset") }),
      client[WS_METHODS.spacesAssetsUploadGet]({
        environmentId,
        uploadId: C.SpaceAssetUploadId.make("upload"),
      }),
      client[WS_METHODS.spacesList]({ environmentId }),
      client[WS_METHODS.spacesTrashList]({ environmentId }),
      client[WS_METHODS.spacesSearch]({ environmentId, query: "needle" }),
      client[WS_METHODS.spacesPagesList]({ environmentId, spaceId: C.SpaceId.make("space") }),
      client[WS_METHODS.spacesPagesGet]({ environmentId, pageId }),
      client[WS_METHODS.spacesReferencesResolve]({
        environmentId,
        target: { kind: "page", pageId },
      }),
      client[WS_METHODS.spacesStructureInspect]({
        environmentId,
        target: { kind: "page", pageId },
      }),
      client[WS_METHODS.spacesBlocksRead]({ environmentId, pageId, revision: 0 }),
      client[WS_METHODS.spacesReceiptsGet]({
        request: {
          operation: "createSpace",
          input: {
            environmentId,
            mutationId: C.SpaceMutationId.make("write"),
            receiptEpoch: C.SpaceReceiptEpoch.make("epoch"),
            title: "",
          },
        },
      }),
    ] as ReadonlyArray<
      Effect.Effect<
        unknown,
        C.SpaceServiceError | import("@t2code/contracts").EnvironmentAuthorizationError
      >
    >) {
      const failure = yield* call.pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: () => null }),
      );
      expect(failure).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationReadScope,
      });
    }
    expect(handled).toBe(0);
  }).pipe(Effect.scoped),
);
