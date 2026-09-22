import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { HostProcessEnvironment, HostProcessPlatform } from "@t2code/shared/hostProcess";

import {
  type DeviceServiceState,
  AuthAccessTokenType,
  AuthStandardClientScopes,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  type DpopFailureReason,
  EnvironmentId,
  EventId,
  GitCommandError,
  KeybindingRule,
  MessageId,
  ExternalLauncherCommandNotFoundError,
  OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  TerminalNotRunningError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  type PreviewEvent,
  ProjectId,
  type ProviderAuthState,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  ProviderSetupError,
  ResolvedKeybindingRule,
  type ServerLifecycleStreamEvent,
  ThreadId,
  TurnId,
  UsageLimitSourceId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
  WorktreeSetupSnapshot,
  type WorktreeSetupStageId,
} from "@t2code/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t2code/shared/dpop";
import { RELAY_HEALTH_REQUEST_TYP, RELAY_MINT_REQUEST_TYP } from "@t2code/shared/relayJwt";
import * as RelayClient from "@t2code/shared/relayClient";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as Socket from "effect/unstable/socket/Socket";
import { vi } from "vite-plus/test";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const SUCCESSFUL_GIT_EXECUTION = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
const decodeTransferThreadSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
);
const decodeTransferShellSnapshot = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationShellSnapshot),
);
const encodeTestJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as ServerConfig from "./config.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { HTTP_ROUTER_CONFIG, makeRoutesLayer } from "./server.ts";
import {
  isThreadDetailEvent,
  resolveAvailableEditorsForConfig,
  resolveFileManagerRevealKindForConfig,
} from "./ws.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationThreadSettleBlockedError } from "./orchestration/Errors.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import * as PullRequestSyncReactor from "./orchestration/PullRequestSyncReactor.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "./persistence/Services/OrchestrationEventStore.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import { ProviderAuthService } from "./provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import {
  AntigravityInstallation,
  AntigravityInstallationError,
} from "./provider/AntigravityInstallation.ts";
import type { ProviderInstance } from "./provider/ProviderDriver.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import { ProviderAdapterRequestError } from "./provider/Errors.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./provider/providerMaintenance.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T2ProjectFileLoader from "./project/T2ProjectFileLoader.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriver from "./vcs/VcsDriver.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as CloudManagedEndpointRuntime from "./cloud/ManagedEndpointRuntime.ts";
import * as CloudCliTokenManager from "./cloud/CliTokenManager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as Data from "effect/Data";

import { makeOrchestrationIntegrationHarness } from "../integration/OrchestrationEngineHarness.integration.ts";
import {
  measureHttpGet,
  openMeasuredWsClient,
  transferDelta,
} from "../integration/NetworkTransferMeasurement.integration.ts";
import { makeSqlStatementCounter } from "../integration/SqlStatementCounter.integration.ts";
import {
  awaitSubscriptionSynchronized,
  collectQueueUntil,
  expectedMeasuredAssistantText,
  queueMeasuredTransferTurn,
  seedTransferBudgetHistory,
  subscribeShellItems,
  subscribeThreadItems,
  TRANSFER_HISTORY_TURN_COUNT,
  TRANSFER_MEASURED_TURN_CREATED_AT,
  TRANSFER_MEASURED_TURN_INDEX,
  TRANSFER_THREAD_ID,
  transferModelSelection,
  waitForTurnQuiesced,
} from "../integration/TransferBudgetScenario.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  type TransferBudgetRun,
  transferBudgetViolations,
} from "../integration/TransferBudgetReport.integration.ts";
import { symlinksSupported } from "@t2code/shared/testing/symlinks";
import { DEFAULT_SIGNAL_EXPORT, otlpSerializationLayer } from "@t2code/shared/observability";

const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const providerSetupInstanceId = ProviderInstanceId.make("antigravity-custom-profile");
const providerSetupDriver = ProviderDriverKind.make("antigravity");
const providerSetupInstallState: ProviderInstallState = {
  driver: providerSetupDriver,
  operationId: "install-operation",
  phase: "downloading",
  downloadedBytes: 128,
  totalBytes: 256,
  version: "test-release",
  installedVersion: null,
  canRemove: false,
  message: null,
};
const providerSetupAuthState: ProviderAuthState = {
  instanceId: providerSetupInstanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const providerSetupInstance: ProviderInstance = {
  instanceId: providerSetupInstanceId,
  driverKind: providerSetupDriver,
  enabled: false,
  displayName: "Google account",
  continuationIdentity: {
    driverKind: providerSetupDriver,
    continuationKey: providerSetupInstanceId,
  },
  get adapter(): never {
    throw new Error("Provider setup must not start a chat session.");
  },
  get snapshot(): never {
    throw new Error("Installation routing must not probe the provider.");
  },
  get textGeneration(): never {
    throw new Error("Provider setup must not generate text.");
  },
};

const makeLiveToolActivityEvent = (
  sequence: number,
  kind: "tool.updated" | "tool.completed" = "tool.updated",
  options: {
    readonly toolCallId?: string;
    readonly title?: string;
    readonly path?: string;
  } = {},
): Extract<OrchestrationEvent, { type: "thread.activity-appended" }> => {
  const { toolCallId = "call-edit", title = "Editing app.ts", path = "src/app.ts" } = options;
  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`activity-${sequence}`),
    tone: "tool",
    kind,
    summary: title,
    payload: {
      itemType: "file_change",
      title,
      data: { toolCallId, path },
    },
    turnId: TurnId.make("turn-edit"),
    createdAt: "2026-01-01T00:00:01.000Z",
  };
  return {
    sequence,
    eventId: EventId.make(`event-tool-${sequence}`),
    aggregateKind: "thread",
    aggregateId: defaultThreadId,
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: { threadId: defaultThreadId, activity },
  };
};
const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const makeDefaultOrchestrationReadModel = () => {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        pullRequests: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

const makeDefaultOrchestrationThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: defaultThreadId,
    projectId: defaultProjectId,
    title: "Default Thread",
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
};

const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const makeAuthTestLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironmentIdentity)({
        getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
      }),
    ),
  );

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;
          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected TCP collector address"));
              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);
                      return;
                    }
                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    // The exporter's batch fiber is forked while the layer builds and ticks on
    // a wall-clock interval, so the whole tracer runs on the live clock.
    yield* Layer.build(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "t3-web",
          attributes: {
            "service.runtime": "t3-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    ).pipe(
      Effect.flatMap((tracing) =>
        Effect.void.pipe(Effect.withSpan(spanName), Effect.provideContext(tracing)),
      ),
      TestClock.withLive,
    );

    const request = yield* Effect.raceFirst(
      Effect.promise(() => collector.firstRequest).pipe(Effect.orDie),
      Effect.sleep(Duration.seconds(1)).pipe(
        Effect.andThen(Effect.die(new Error("Timed out waiting for OTLP trace export"))),
      ),
    );
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });

const buildAppUnderTest = (options?: {
  onPairingChangesSubscribed?: Effect.Effect<void>;
  config?: Partial<ServerConfig.ServerConfig["Service"]>;
  layers?: {
    keybindings?: Partial<Keybindings.Keybindings["Service"]>;
    environmentTheme?: Partial<EnvironmentTheme.EnvironmentThemeService["Service"]>;
    providerRegistry?: Partial<ProviderRegistry.ProviderRegistry["Service"]>;
    usageLimitSources?: Partial<UsageLimitSources.UsageLimitSources["Service"]>;
    providerService?: Partial<ProviderService.ProviderService["Service"]>;
    providerAuth?: Partial<ProviderAuthService["Service"]>;
    providerInstanceRegistry?: Partial<ProviderInstanceRegistry["Service"]>;
    antigravityInstallation?: Partial<AntigravityInstallation["Service"]>;
    serverSettings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncher["Service"]>;
    vcsDriver?: Partial<VcsDriver.VcsDriver["Service"]>;
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistry["Service"]>;
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
    gitManager?: Partial<GitManager.GitManager["Service"]>;
    sourceControlRepositoryService?: Partial<
      SourceControlRepositoryService.SourceControlRepositoryService["Service"]
    >;
    reviewService?: Partial<ReviewService.ReviewService["Service"]>;
    vcsStatusBroadcaster?: Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>;
    projectSetupScriptRunner?: Partial<
      ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]
    >;
    providerSessionDirectory?: Partial<
      ProviderSessionDirectory.ProviderSessionDirectory["Service"]
    >;
    terminalManager?: Partial<TerminalManager.TerminalManager["Service"]>;
    orchestrationEngine?: Partial<OrchestrationEngine.OrchestrationEngineService["Service"]>;
    threadDeletionReactor?: Partial<ThreadDeletionReactor["Service"]>;
    analyticsService?: Partial<AnalyticsService.AnalyticsService["Service"]>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]>;
    checkpointDiffQuery?: Partial<CheckpointDiffQuery.CheckpointDiffQuery["Service"]>;
    browserTraceCollector?: Partial<BrowserTraceCollector.BrowserTraceCollector["Service"]>;
    serverLifecycleEvents?: Partial<ServerLifecycleEvents.ServerLifecycleEvents["Service"]>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartup.ServerRuntimeStartup["Service"]>;
    serverEnvironment?: Partial<ServerEnvironment.ServerEnvironment["Service"]>;
    repositoryIdentityResolver?: Partial<
      RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]
    >;
    cloudManagedEndpointRuntime?: Partial<
      CloudManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"]
    >;
    relayClient?: Partial<RelayClient.RelayClient["Service"]>;
    cloudCliTokenManager?: Partial<CloudCliTokenManager.CloudCliTokenManager["Service"]>;
    nativeTelemetryClient?: Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>;
    desktopTelemetryReceiver?: Partial<
      DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]
    >;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
      otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
      otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
      otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
      otlpServiceName: "t3-server",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...options?.config,
    };
    const layerConfig = ServerConfig.layer(config);
    const defaultVcsDriver: VcsDriver.VcsDriver["Service"] = {
      capabilities: {
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      },
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      detectRepository: () => Effect.succeed(null),
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      listRemotes: () =>
        Effect.succeed({
          remotes: [],
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      initRepository: () => Effect.void,
      ...options?.layers?.vcsDriver,
    };
    const vcsDriverRegistryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(defaultVcsDriver),
      detect: (input) =>
        defaultVcsDriver.detectRepository(input.cwd).pipe(
          Effect.flatMap((repository) =>
            repository
              ? Effect.succeed(repository)
              : defaultVcsDriver.isInsideWorkTree(input.cwd).pipe(
                  Effect.map((isInsideWorkTree) =>
                    isInsideWorkTree
                      ? {
                          kind: "git" as const,
                          rootPath: input.cwd,
                          metadataPath: null,
                          freshness: {
                            source: "live-local" as const,
                            observedAt: TEST_EPOCH,
                            expiresAt: Option.none(),
                          },
                        }
                      : null,
                  ),
                ),
          ),
          Effect.map((repository) =>
            repository
              ? ({
                  kind: repository.kind,
                  repository,
                  driver: defaultVcsDriver,
                } satisfies VcsDriverRegistry.VcsDriverHandle)
              : null,
          ),
        ),
      resolve: (input) =>
        Effect.succeed({
          kind:
            input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
          repository: {
            kind:
              input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
            rootPath: input.cwd,
            metadataPath: null,
            freshness: {
              source: "live-local",
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: defaultVcsDriver,
        }),
      ...options?.layers?.vcsDriverRegistry,
    });
    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      ...options?.layers?.gitVcsDriver,
    });
    const gitManagerLayer = Layer.mock(GitManager.GitManager)({
      ...options?.layers?.gitManager,
    });
    const workspaceEntriesLayer = WorkspaceEntries.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provideMerge(vcsDriverRegistryLayer),
    );
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePaths.layer,
      workspaceEntriesLayer,
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(workspaceEntriesLayer),
      ),
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T2ProjectFileLoader.layer),
      ),
      NativeAppIconResolver.layer,
    );
    const gitWorkflowLayer = GitWorkflowService.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitVcsDriverLayer),
      Layer.provideMerge(gitManagerLayer),
    );
    const vcsProvisioningLayer = VcsProvisioningService.layer.pipe(
      Layer.provide(vcsDriverRegistryLayer),
    );
    const reviewLayer = options?.layers?.reviewService
      ? Layer.mock(ReviewService.ReviewService)({
          ...options.layers.reviewService,
        })
      : ReviewService.layer.pipe(
          Layer.provideMerge(gitVcsDriverLayer),
          Layer.provide(vcsDriverRegistryLayer),
        );
    const vcsStatusBroadcasterLayer = options?.layers?.vcsStatusBroadcaster
      ? Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          ...options.layers.vcsStatusBroadcaster,
        })
      : VcsStatusBroadcaster.layer.pipe(Layer.provide(gitWorkflowLayer));
    const resourceTelemetryLayer = ResourceTelemetry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NativeTelemetryClient.layerTest(options?.layers?.nativeTelemetryClient),
          DesktopTelemetryReceiver.layerTest(options?.layers?.desktopTelemetryReceiver),
          ResourceAttribution.layer,
        ),
      ),
    );
    const serviceLauncherClientLayer = ServiceLauncherClient.layer.pipe(
      Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
    );

    const servedRoutesLayer = HttpRouter.serve(
      // Viewed-file marks for a host that keeps none of its own are rows, so the routes want a
      // database. Its own, in memory: nothing here shares a table with the auth store.
      makeRoutesLayer.pipe(
        Layer.provide(Layer.mergeAll(serviceLauncherClientLayer, SqlitePersistenceMemory)),
      ),
      {
        disableListenLog: true,
        disableLogger: true,
        routerConfig: HTTP_ROUTER_CONFIG,
      },
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Keybindings.Keybindings)({
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
            ...options?.layers?.keybindings,
          }),
          Layer.mock(EnvironmentTheme.EnvironmentThemeService)({
            current: Effect.succeed([]),
            streamChanges: Stream.empty,
            ...options?.layers?.environmentTheme,
          }),
          Layer.mock(UsageLimitSources.UsageLimitSources)({
            current: Effect.succeed([]),
            streamChanges: Stream.make([]),
            refresh: Effect.void,
            ...options?.layers?.usageLimitSources,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
            refresh: () => Effect.succeed([]),
            refreshInstance: () => Effect.succeed([]),
            getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
              Effect.succeed(
                makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
              ),
            setProviderMaintenanceActionState: () => Effect.succeed([]),
            streamChanges: Stream.empty,
            ...options?.layers?.providerRegistry,
          }),
          Layer.mock(ProviderService.ProviderService)({
            uploadFeedback: () => Effect.die("Provider feedback is not stubbed in this test"),
            ...options?.layers?.providerService,
          }),
          Layer.mock(ProviderAuthService)({
            ...options?.layers?.providerAuth,
          }),
          Layer.mock(ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(undefined),
            listInstances: Effect.succeed([]),
            ...options?.layers?.providerInstanceRegistry,
          }),
          Layer.mock(AntigravityInstallation)({
            managedDirectory: "unused-test-antigravity-runtime",
            ...options?.layers?.antigravityInstallation,
          }),
          Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
            upsert: () => Effect.void,
            getBinding: () => Effect.succeed(Option.none()),
            listThreadIds: () => Effect.succeed([]),
            listBindings: () => Effect.succeed([]),
            ...options?.layers?.providerSessionDirectory,
          }),
          Layer.mock(DeviceService.DeviceService)({
            state: Effect.succeed(EMPTY_DEVICE_STATE),
            currentReadiness: () => Effect.succeed(null),
            sessionsForThread: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ExternalLauncher.ExternalLauncher)({
            resolveAvailableEditors: () => Effect.succeed([]),
            resolveFileManagerRevealKind: () => Effect.sync((): undefined => undefined),
            ...options?.layers?.externalLauncher,
          }),
          Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
            resolveTargets: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
          read: Effect.succeed({
            serverPid: process.pid,
            readAt: TEST_EPOCH,
            processCount: 0,
            totalRssBytes: 0,
            totalCpuPercent: 0,
            processes: [],
            error: Option.none(),
          }),
          signal: (input) =>
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              signaled: true,
              message: Option.none(),
            }),
        }),
      ),
      Layer.provide([
        HostResources.layer,
        Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
          readHistory: (input) =>
            Effect.succeed({
              readAt: TEST_EPOCH,
              windowMs: input.windowMs,
              bucketMs: input.bucketMs,
              sampleIntervalMs: 5_000,
              retainedSampleCount: 0,
              totalCpuSecondsApprox: 0,
              buckets: [],
              topProcesses: [],
              error: Option.none(),
            }),
        }),
      ]),
      Layer.provide(
        Layer.mock(TraceDiagnostics.TraceDiagnostics)({
          read: () =>
            Effect.succeed({
              traceFilePath: "",
              scannedFilePaths: [],
              readAt: TEST_EPOCH,
              recordCount: 0,
              parseErrorCount: 0,
              firstSpanAt: Option.none(),
              lastSpanAt: Option.none(),
              failureCount: 0,
              interruptionCount: 0,
              slowSpanThresholdMs: 1_000,
              slowSpanCount: 0,
              logLevelCounts: {},
              topSpansByCount: [],
              slowestSpans: [],
              commonFailures: [],
              latestFailures: [],
              latestWarningAndErrorLogs: [],
              partialFailure: Option.none(),
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(gitManagerLayer),
      Layer.provide(gitVcsDriverLayer),
      Layer.provide(gitWorkflowLayer),
      Layer.provide(reviewLayer),
      Layer.provide(vcsProvisioningLayer),
      Layer.provide(
        Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
          ...options?.layers?.sourceControlRepositoryService,
        }),
      ),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(TerminalManager.TerminalManager)({
            ...options?.layers?.terminalManager,
          }),
          WorktreeSetupTracker.layer,
          ProjectCloneTracker.layer.pipe(
            Layer.provide(
              Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
                ...options?.layers?.sourceControlRepositoryService,
              }),
            ),
          ),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PreviewManager.PreviewManager)({
            open: () => Effect.die("PreviewManager not stubbed in this test"),
            navigate: () => Effect.die("PreviewManager not stubbed in this test"),
            resize: () => Effect.die("PreviewManager not stubbed in this test"),
            reportStatus: () => Effect.void,
            refresh: () => Effect.void,
            close: () => Effect.void,
            list: () => Effect.succeed({ sessions: [], serverEpoch: "test-server", revision: 0 }),
            events: Stream.empty,
            subscribeEvents: Effect.flatMap(PubSub.unbounded<PreviewEvent>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
          }),
          Layer.mock(PortScanner.PortDiscovery)({
            scan: () => Effect.succeed([]),
            subscribe: () => Effect.void,
            retain: Effect.void,
            registerTerminalProcesses: () => Effect.void,
            unregisterTerminal: () => Effect.void,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            readThreadEvents: () => Stream.empty,
            getThreadReplayStats: () =>
              Effect.succeed({
                eventCount: 0,
                payloadBytes: 0,
                hasCreateEvent: false,
              }),
            dispatch: () => Effect.succeed({ sequence: 0 }),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
            ...options?.layers?.orchestrationEngine,
          }),
          Layer.mock(ThreadDeletionReactor)({
            start: () => Effect.void,
            drainThrough: () => Effect.void,
            ...options?.layers?.threadDeletionReactor,
          }),
          Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({
            start: () => Effect.void,
            drain: Effect.void,
            requestSync: () => Effect.void,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getUserInputActivity: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "1970-01-01T00:00:00.000Z",
            }),
          getArchivedShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: "1970-01-01T00:00:00.000Z",
            }),
          searchThreads: () => Effect.succeed({ matches: [] }),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getEventReplayStats: ({ fromSequenceExclusive, toSequenceInclusive }) =>
            Effect.succeed({
              eventCount: Math.max(0, toSequenceInclusive - fromSequenceExclusive),
              payloadBytes: 0,
            }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getImportedAgentSessionSources: () => Effect.succeed([]),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          ...options?.layers?.projectionSnapshotQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
    );

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(resourceTelemetryLayer),
      Layer.provide(UsageService.layerTest),
      Layer.provide(
        Layer.mock(AnalyticsService.AnalyticsService)({
          record: () => Effect.void,
          flush: Effect.void,
          ...options?.layers?.analyticsService,
        }),
      ),
      Layer.provide(
        Layer.mock(BrowserTraceCollector.BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(otlpSerializationLayer(config.otlpTracesExport.protocol)),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          markRunningProviderSessionsForContinuation: Effect.succeed([]),
          clearProviderSessionContinuationMarkers: () => Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          reportClientActivity: () => Effect.void,
          removeRpcClient: () => Effect.void,
          reportHostPowerState: () => Effect.void,
          snapshot: Effect.succeed({
            hostPower: {
              source: "unknown",
              idle: "unknown",
              idleSeconds: null,
              locked: "unknown",
              suspended: false,
              onBattery: "unknown",
              lowPowerMode: "unknown",
              thermalState: "unknown",
              stale: true,
              updatedAt: TEST_EPOCH,
            },
            leases: [],
            activeForegroundLeaseCount: 0,
            activeScopeKeys: [],
            shouldRunOpportunisticWork: false,
            updatedAt: TEST_EPOCH,
          }),
          streamChanges: Stream.empty,
          subscribe: Effect.succeed({
            latest: {
              hostPower: {
                source: "unknown",
                idle: "unknown",
                idleSeconds: null,
                locked: "unknown",
                suspended: false,
                onBattery: "unknown",
                lowPowerMode: "unknown",
                thermalState: "unknown",
                stale: true,
                updatedAt: TEST_EPOCH,
              },
              leases: [],
              activeForegroundLeaseCount: 0,
              activeScopeKeys: [],
              shouldRunOpportunisticWork: false,
              updatedAt: TEST_EPOCH,
            },
            changes: Stream.empty,
          }),
          hasDemand: () => Effect.succeed(false),
          shouldRunScopeWork: () => Effect.succeed(false),
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provide(
        Layer.succeed(
          CloudManagedEndpointRuntime.CloudManagedEndpointRuntime,
          CloudManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: () => Effect.succeed({ status: "disabled" }),
            ...options?.layers?.cloudManagedEndpointRuntime,
          }),
        ),
      ),
      Layer.provide(
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.die("unused relay-client install"),
            installWithProgress: () => Effect.die("unused relay-client install"),
            ...options?.layers?.relayClient,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(CloudCliTokenManager.CloudCliTokenManager)({
          get: Effect.die(new Error("Unexpected T2 Connect CLI authorization request.")),
          getExisting: Effect.succeed(Option.none()),
          hasCredential: Effect.succeed(false),
          clear: Effect.void,
          ...options?.layers?.cloudCliTokenManager,
        }),
      ),
      Layer.updateService(PairingGrantStore.PairingGrantStore, (grants) => {
        const subscribed = options?.onPairingChangesSubscribed;
        if (!subscribed) return grants;
        return {
          ...grants,
          streamChanges: Stream.unwrap(
            Effect.gen(function* () {
              const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
              yield* grants.streamChanges.pipe(
                Stream.runForEach((change) => Queue.offer(changes, change)),
                Effect.forkScoped({ startImmediately: true }),
              );
              yield* subscribed;
              return Stream.fromQueue(changes);
            }),
          ),
        };
      }),
      Layer.provideMerge(makeAuthTestLayer()),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(GitHubCli.layer.pipe(Layer.provideMerge(VcsProcess.layer))),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const cookie = next.hash.startsWith("#cookie=")
    ? decodeURIComponent(next.hash.slice("#cookie=".length))
    : null;
  next.hash = "";
  return {
    cookie,
    url: next.toString(),
  };
};

const wsRpcProtocolLayer = (wsUrl: string, onMessage?: (message: string) => void) => {
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl);
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) => {
      // Socket.makeWebSocket only ever passes its `protocols` option here.
      const socket = new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols as string | string[] | undefined,
        cookie ? { headers: { cookie } } : undefined,
      );
      if (onMessage) socket.on("message", (data) => onMessage(data.toString()));
      return socket as unknown as globalThis.WebSocket;
    },
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
  onMessage?: (message: string) => void,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl, onMessage)));

const withFirstWsAckHeld = (
  wsUrl: string,
  held: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) => {
  let holdNextAck = true;
  return Layer.effect(RpcClient.Protocol)(
    Effect.map(RpcClient.Protocol, (protocol) =>
      RpcClient.Protocol.of({
        ...protocol,
        send: (clientId, request, transferables) => {
          const send = protocol.send(clientId, request, transferables);
          if (request._tag !== "Ack" || !holdNextAck) {
            return send;
          }
          holdNextAck = false;
          return Deferred.succeed(held, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(send),
          );
        },
      }),
    ),
  ).pipe(Layer.provide(wsRpcProtocolLayer(wsUrl)));
};

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as NetAddress.InetAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/browser-session");
    const response = yield* fetchEffect(bootstrapUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options?.headers,
      },
      body: jsonRequestBody({
        credential,
      }),
    });
    const body = yield* responseJsonEffect<{
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
    }>(response);
    return {
      response,
      body,
      cookie: response.headers["set-cookie"],
    };
  });

const exchangeAccessToken = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
    readonly scope?: string;
    readonly clientMetadata?: {
      readonly label?: string;
      readonly deviceType?: string;
      readonly os?: string;
    };
  },
) =>
  Effect.gen(function* () {
    const tokenUrl = yield* getHttpServerUrl("/oauth/token");
    const response = yield* fetchEffect(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...options?.headers,
      },
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        scope:
          options?.scope ??
          "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write",
        ...(options?.clientMetadata?.label ? { client_label: options.clientMetadata.label } : {}),
        ...(options?.clientMetadata?.deviceType
          ? { client_device_type: options.clientMetadata.deviceType }
          : {}),
        ...(options?.clientMetadata?.os ? { client_os: options.clientMetadata.os } : {}),
      }).toString(),
    });
    const body = yield* responseJsonEffect<{
      readonly access_token?: string;
      readonly issued_token_type?: string;
      readonly token_type?: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly _tag?: string;
      readonly code?: string;
      readonly reason?: string;
      readonly dpopFailureReason?: DpopFailureReason;
      readonly traceId?: string;
    }>(response);
    return {
      response,
      body,
    };
  });

const makeDpopProof = (input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly accessToken?: string;
  readonly jti?: string;
  readonly privateKey?: NodeCrypto.KeyObject;
  readonly publicJwk?: DpopPublicJwk;
}) => {
  const keyPair =
    input.privateKey && input.publicJwk
      ? { privateKey: input.privateKey, publicJwk: input.publicJwk }
      : (() => {
          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
            namedCurve: "P-256",
          });
          return { privateKey, publicJwk: publicKey.export({ format: "jwk" }) as DpopPublicJwk };
        })();
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti ?? "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    proof: `${header}.${payload}.${signature}`,
    thumbprint: computeDpopJwkThumbprint(keyPair.publicJwk),
    privateKey: keyPair.privateKey,
    publicJwk: keyPair.publicJwk,
  };
};

const makeCloudMintCredentialRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly clientProofKeyThumbprint: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:connect">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t2-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-mint-jti-1",
    environmentId: input.environmentId,
    clientProofKeyThumbprint: input.clientProofKeyThumbprint,
    cnf: {
      jkt: input.clientProofKeyThumbprint,
    },
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:connect"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_MINT_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const makeCloudEnvironmentHealthRequest = (input: {
  readonly privateKey: string;
  readonly environmentId: EnvironmentId;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly jti?: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly scope?: ReadonlyArray<"environment:status">;
}) => {
  const payload = {
    iss: input.issuer ?? "https://relay.example.test",
    aud: input.audience ?? `t2-env:${input.environmentId}`,
    sub: input.subject ?? "user_123",
    jti: input.jti ?? "cloud-health-jti-1",
    environmentId: input.environmentId,
    nonce: input.nonce,
    iat: Math.floor(DateTime.makeUnsafe(input.issuedAt).epochMilliseconds / 1_000),
    exp: Math.floor(DateTime.makeUnsafe(input.expiresAt).epochMilliseconds / 1_000),
    scope: input.scope ?? ["environment:status"],
  } as const;
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: RELAY_HEALTH_REQUEST_TYP }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return {
    proof: `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), input.privateKey).toString("base64url")}`,
  };
};

const decodeCompactJwtPayload = <A>(token: string): A => {
  const encodedPayload = token.split(".")[1];
  if (!encodedPayload) {
    throw new Error("JWT does not contain a payload.");
  }
  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as A;
};

class AuthenticationGetterError extends Data.TaggedError("AuthenticationGetterError")<{
  readonly message: string;
}> {}

class TestHttpRequestError extends Data.TaggedError("TestHttpRequestError")<{
  readonly cause: unknown;
}> {}

const testRequestUrl = (input: Parameters<typeof fetch>[0]): string => {
  const value = input.toString();
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
};

const fetchEffect = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = HttpClientRequest.make((init?.method ?? "GET") as "GET" | "POST")(
    testRequestUrl(input),
    {
      headers: init?.headers as Record<string, string> | undefined,
    },
  ).pipe(
    typeof init?.body === "string"
      ? HttpClientRequest.bodyText(
          init.body,
          (init.headers as Record<string, string> | undefined)?.["content-type"] ??
            "application/json",
        )
      : (request) => request,
  );
  const effect = HttpClient.execute(request);
  return (
    init?.redirect === "manual"
      ? effect.pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
      : effect
  ).pipe(Effect.mapError((cause) => new TestHttpRequestError({ cause })));
};

const jsonRequestBody = (value: unknown): string => {
  return JSON.stringify(value);
};

const responseJsonEffect = <A>(response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((json) => json as A),
    Effect.mapError((cause) => new TestHttpRequestError({ cause })),
  );

const responseOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, cookie } = yield* bootstrapBrowserSession(credential);
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bootstrap session response to succeed, got ${response.status}`,
      });
    }

    if (!cookie) {
      return yield* new AuthenticationGetterError({
        message: "Expected bootstrap session response to set a cookie.",
      });
    }

    return cookie.split(";")[0] ?? cookie;
  });

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* exchangeAccessToken(credential);
    if (!responseOk(response)) {
      return yield* new AuthenticationGetterError({
        message: `Expected bearer bootstrap response to succeed, got ${response.status}`,
      });
    }

    if (!body.access_token) {
      return yield* new AuthenticationGetterError({
        message: "Expected token exchange response to include an access token.",
      });
    }

    return body.access_token;
  });

const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

const splitHeaderTokens = (value: string | null | undefined) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

const assertBrowserApiCorsResponseHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assert.equal(headers["access-control-allow-origin"], options?.origin ?? "*");
  assert.equal(
    headers["access-control-allow-credentials"],
    options?.credentials ? "true" : undefined,
  );
};

const assertBrowserApiCorsPreflightHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
  options?: {
    readonly origin?: string;
    readonly credentials?: boolean;
  },
) => {
  assertBrowserApiCorsResponseHeaders(headers, options);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-methods"] ?? null), [
    "GET",
    "OPTIONS",
    "POST",
  ]);
  assert.deepEqual(splitHeaderTokens(headers["access-control-allow-headers"]), [
    "authorization",
    "b3",
    "content-type",
    "dpop",
    "traceparent",
  ]);
};
const crossOriginClientOrigin = "http://remote-client.test:3772";

const getWsServerUrl = (
  pathname = "",
  options?: { authenticated?: boolean; credential?: string },
) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as NetAddress.InetAddress;
    const baseUrl = `ws://127.0.0.1:${address.port}${pathname}`;
    if (options?.authenticated === false) {
      return baseUrl;
    }
    return appendSessionCookieToWsUrl(
      baseUrl,
      yield* getAuthenticatedSessionCookieHeader(options?.credential),
    );
  });

// Mirrors NodeHttpServer.layerTest, which does not expose server options,
// with the production `websocket: { perMessageDeflate: true }` setting.
const NodeHttpServerTestWithWsDeflate = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(
    Layer.unwrap(
      Effect.map(
        Effect.promise(() => import("node:http")),
        (NodeHttp) =>
          NodeHttpServer.layer(NodeHttp.createServer, {
            port: 0,
            websocket: { perMessageDeflate: true },
          }),
      ),
    ),
  ),
);

const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [],
  hostStatus: "disabled",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: DeviceService.DEVICE_HUB_ROUTE_PREFIX,
  revision: 0,
};

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("serves draft workspace files without a thread", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wsUrl = yield* getWsServerUrl("/ws");
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-draft-media-" });
      yield* fileSystem.writeFileString(path.join(directory, "note.html"), "<p>draft</p>");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "draft-workspace-file", cwd: directory, path: "note.html" },
            });
            const response = yield* HttpClient.get(issued.relativeUrl);
            assert.equal(response.status, 200);
            assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
            assert.equal(yield* response.text, "<p>draft</p>");
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("uploads image bytes through a signed URL issued by websocket rpc", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            const rejected = yield* HttpClient.post(issued.relativeUrl, {
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3]), "image/png"),
            });
            assert.equal(rejected.status, 400);

            const response = yield* HttpClient.post(issued.relativeUrl, {
              headers: { origin: crossOriginClientOrigin },
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
            });
            assert.equal(response.status, 204);
            assertBrowserApiCorsResponseHeaders(response.headers);

            const attachmentPath = path.join(config.attachmentsDir, `${issued.attachmentId}.png`);
            assert.isTrue(yield* fileSystem.exists(attachmentPath));

            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: issued.attachmentId });
            assert.isFalse(yield* fileSystem.exists(attachmentPath));

            const streamed = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "streamed.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            const streamedResponse = yield* HttpClient.post(streamed.relativeUrl, {
              body: HttpBody.stream(Stream.make(new Uint8Array([1, 2, 3, 4, 5, 6])), "image/png"),
            });
            assert.equal(streamedResponse.status, 204);
            yield* client[WS_METHODS.attachmentsDelete]({ attachmentId: streamed.attachmentId });

            const uploadedFile = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              type: "file",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 6,
            });
            const fileResponse = yield* HttpClient.post(uploadedFile.relativeUrl, {
              body: HttpBody.stream(
                Stream.make(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])),
                "application/pdf",
              ),
            });
            assert.equal(fileResponse.status, 204);
            const uploadedFilePath = path.join(
              config.attachmentsDir,
              `${uploadedFile.attachmentId}.pdf`,
            );
            assert.isTrue(yield* fileSystem.exists(uploadedFilePath));

            // A mint that carries the attachment's display name and mime
            // serves a real download filename and Content-Type.
            const download = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: {
                _tag: "attachment",
                attachmentId: uploadedFile.attachmentId,
                fileName: "report.pdf",
                mimeType: "application/pdf",
              },
            });
            const downloadResponse = yield* HttpClient.get(download.relativeUrl);
            assert.equal(downloadResponse.status, 200);
            assert.equal(
              downloadResponse.headers["content-disposition"],
              'attachment; filename="report.pdf"',
            );
            assert.equal(downloadResponse.headers["content-type"], "application/pdf");

            // Old clients mint without name or mime and still get a download.
            const bareDownload = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: { _tag: "attachment", attachmentId: uploadedFile.attachmentId },
            });
            const bareResponse = yield* HttpClient.get(bareDownload.relativeUrl);
            assert.equal(bareResponse.status, 200);
            assert.equal(bareResponse.headers["content-disposition"], "attachment");
            assert.equal(bareResponse.headers["content-type"], "application/octet-stream");

            yield* client[WS_METHODS.attachmentsDelete]({
              attachmentId: uploadedFile.attachmentId,
            });
            assert.isFalse(yield* fileSystem.exists(uploadedFilePath));
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects an over-limit chunked upload through the route without hanging", () =>
    Effect.gen(function* () {
      const config = yield* buildAppUnderTest();
      const fileSystem = yield* FileSystem.FileSystem;
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const issued = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              type: "file",
              name: "big.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 6,
            });
            const NodeHttp = yield* Effect.promise(() => import("node:http"));
            const uploadUrl = new URL(issued.relativeUrl, yield* getHttpServerUrl());
            const status = yield* Effect.callback<number, Error>((resume) => {
              let completed = false;
              const complete = (result: Effect.Effect<number, Error>) => {
                if (completed) return;
                completed = true;
                resume(result);
              };
              const request = NodeHttp.request(
                uploadUrl,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/octet-stream",
                    "transfer-encoding": "chunked",
                  },
                },
                (response) => {
                  request.end();
                  response.resume();
                  response.once("end", () => complete(Effect.succeed(response.statusCode ?? 0)));
                  response.once("error", (error) => complete(Effect.fail(error)));
                },
              );
              request.once("error", (error) => complete(Effect.fail(error)));
              request.flushHeaders();
              request.write(new Uint8Array(4), () => {
                request.write(new Uint8Array(4));
              });

              return Effect.sync(() => request.destroy());
            });
            assert.equal(status, 400);
            assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), []);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps feedback errors structured across websocket rpc", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-feedback-failure");
      yield* buildAppUnderTest({
        layers: {
          providerService: {
            uploadFeedback: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "feedback/upload",
                  detail: "private provider detail",
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.providerUploadFeedback]({ threadId }).pipe(Effect.flip),
        ),
      );

      assert.strictEqual(error._tag, "ProviderUploadFeedbackError");
      if (error._tag === "ProviderUploadFeedbackError") {
        assert.strictEqual(error.threadId, threadId);
        assert.strictEqual(error.message, `Failed to upload feedback for thread ${threadId}.`);
        assert.isDefined(error.cause);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("shares one preview automation broker across websocket sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const firstConnected = yield* Deferred.make<string>();
        const firstClosed = yield* Deferred.make<void>();
        const host = {
          clientId: "shared-preview-host",
          environmentId: testEnvironmentDescriptor.environmentId,
        } as const;

        yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(
            Stream.tap((event) =>
              event.type === "connected"
                ? Deferred.succeed(firstConnected, event.connectionId)
                : Effect.void,
            ),
            Stream.runDrain,
            Effect.ensuring(Deferred.succeed(firstClosed, undefined)),
          ),
        ).pipe(Effect.forkScoped);

        const firstConnectionId = yield* Deferred.await(firstConnected);
        const replacementEvent = yield* withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.previewAutomationConnect](host).pipe(Stream.runHead),
        ).pipe(Effect.map(Option.getOrThrow));
        const firstStreamClosed = yield* Deferred.await(firstClosed).pipe(
          Effect.timeoutOption("2 seconds"),
        );

        assert.equal(replacementEvent.type, "connected");
        assert.notEqual(replacementEvent.connectionId, firstConnectionId);
        assert.isTrue(Option.isSome(firstStreamClosed));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      const failureMessage = String(result.failure);
      assertTrue(
        failureMessage.includes("SocketOpenError") || failureMessage.includes("SocketCloseError"),
      );
      assertTrue(
        failureMessage.includes("Unauthorized") ||
          failureMessage.includes("An error occurred during Open"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provider setup lets read-only clients observe installation but not change setup", () =>
    Effect.gen(function* () {
      let installStarts = 0;
      let authCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          providerInstanceRegistry: {
            getInstance: (instanceId) =>
              Effect.succeed(
                instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
              ),
          },
          antigravityInstallation: {
            start: Effect.sync(() => {
              installStarts += 1;
              return providerSetupInstallState;
            }),
            changes: Stream.succeed(providerSetupInstallState),
          },
          providerAuth: {
            start: () =>
              Effect.sync(() => {
                authCalls += 1;
                return providerSetupAuthState;
              }),
            subscribe: () =>
              Stream.fromEffect(
                Effect.sync(() => {
                  authCalls += 1;
                  return providerSetupAuthState;
                }),
              ),
          },
        },
      });
      const token = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });
      assert.equal(token.response.status, 200);
      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${token.body.access_token ?? ""}` },
      });
      const { ticket } = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticket)}`;
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
              instanceId: providerSetupInstanceId,
            }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
            assert.deepEqual(observed, providerSetupInstallState);
            const errors = [
              yield* client[WS_METHODS.providerInstallStart]({
                instanceId: providerSetupInstanceId,
              }).pipe(Effect.flip),
              yield* client[WS_METHODS.providerAuthStart]({
                instanceId: providerSetupInstanceId,
              }).pipe(Effect.flip),
              yield* client[WS_METHODS.providerAuthSubscribe]({
                instanceId: providerSetupInstanceId,
              }).pipe(Stream.runHead, Effect.flip),
            ];
            for (const error of errors) {
              assert.equal(error._tag, "EnvironmentAuthorizationError");
              if (error._tag === "EnvironmentAuthorizationError") {
                assert.equal(error.requiredScope, "orchestration:operate");
              }
            }
          }),
        ),
      );
      assert.equal(installStarts, 0);
      assert.equal(authCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provider setup binds private sign-in to the authenticated websocket session", () =>
    Effect.gen(function* () {
      const flowId = "private-sign-in-flow";
      const callbackUrl = "http://127.0.0.1:51234/?state=test-state&code=test-code";
      const waiting: ProviderAuthState = {
        ...providerSetupAuthState,
        phase: "waiting",
        flowId,
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-state",
        expiresAt: "2026-09-02T00:05:00.000Z",
      };
      const calls: Array<{
        readonly operation: string;
        readonly instanceId: ProviderInstanceId;
        readonly ownerSessionId: string;
      }> = [];
      const forwardedCallbacks: string[] = [];
      const logoutInstances: ProviderInstanceId[] = [];
      let flowOwner = "";
      yield* buildAppUnderTest({
        layers: {
          providerAuth: {
            start: (input, ownerSessionId) =>
              Effect.sync(() => {
                flowOwner = ownerSessionId;
                calls.push({ operation: "start", instanceId: input.instanceId, ownerSessionId });
                return waiting;
              }),
            subscribe: (input, ownerSessionId) =>
              Stream.fromEffect(
                Effect.sync(() => {
                  calls.push({
                    operation: "subscribe",
                    instanceId: input.instanceId,
                    ownerSessionId,
                  });
                  return ownerSessionId === flowOwner
                    ? waiting
                    : { ...waiting, flowId: null, authorizationUrl: null, expiresAt: null };
                }),
              ),
            complete: (input, ownerSessionId) =>
              Effect.gen(function* () {
                calls.push({ operation: "complete", instanceId: input.instanceId, ownerSessionId });
                if (ownerSessionId !== flowOwner) {
                  return yield* new ProviderSetupError({
                    instanceId: input.instanceId,
                    operation: "complete",
                    detail: "This sign-in belongs to another client.",
                  });
                }
                assert.equal(input.flowId, flowId);
                forwardedCallbacks.push(input.callbackUrl);
                return { ...waiting, phase: "verifying" as const, authorizationUrl: null };
              }),
            cancel: (input, ownerSessionId) =>
              Effect.sync(() => {
                assert.equal(input.flowId, flowId);
                calls.push({ operation: "cancel", instanceId: input.instanceId, ownerSessionId });
                return { ...providerSetupAuthState, phase: "cancelled" as const, flowId };
              }),
            logout: (input) =>
              Effect.sync(() => {
                logoutInstances.push(input.instanceId);
                return providerSetupAuthState;
              }),
          },
        },
      });
      const firstCookie = yield* getAuthenticatedSessionCookieHeader();
      const secondCookie = yield* getAuthenticatedSessionCookieHeader();
      const firstClients = yield* HttpClient.get("/api/auth/clients", {
        headers: { cookie: firstCookie },
      }).pipe(
        Effect.flatMap(
          responseJsonEffect<
            ReadonlyArray<{ readonly sessionId: string; readonly current: boolean }>
          >,
        ),
      );
      const secondClients = yield* HttpClient.get("/api/auth/clients", {
        headers: { cookie: secondCookie },
      }).pipe(
        Effect.flatMap(
          responseJsonEffect<
            ReadonlyArray<{ readonly sessionId: string; readonly current: boolean }>
          >,
        ),
      );
      const firstOwner = firstClients.find((session) => session.current)?.sessionId;
      const secondOwner = secondClients.find((session) => session.current)?.sessionId;
      assert.isString(firstOwner);
      assert.isString(secondOwner);
      assert.notEqual(firstOwner, secondOwner);
      const baseWsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const target = {
        instanceId: providerSetupInstanceId,
        ownerSessionId: "client-supplied-owner",
      };
      yield* Effect.scoped(
        withWsRpcClient(appendSessionCookieToWsUrl(baseWsUrl, firstCookie), (client) =>
          Effect.gen(function* () {
            const started = yield* client[WS_METHODS.providerAuthStart](target);
            assert.equal(started.flowId, flowId);
            const ownState = yield* client[WS_METHODS.providerAuthSubscribe](target).pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            assert.equal(ownState.authorizationUrl, waiting.authorizationUrl);
            yield* Effect.scoped(
              withWsRpcClient(appendSessionCookieToWsUrl(baseWsUrl, secondCookie), (otherClient) =>
                Effect.gen(function* () {
                  const otherState = yield* otherClient[WS_METHODS.providerAuthSubscribe](
                    target,
                  ).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
                  assert.isNull(otherState.authorizationUrl);
                  assert.isNull(otherState.flowId);
                  const forged = { ...target, ownerSessionId: firstOwner, flowId, callbackUrl };
                  const denied = yield* otherClient[WS_METHODS.providerAuthComplete](forged).pipe(
                    Effect.flip,
                  );
                  assert.equal(denied._tag, "ProviderSetupError");
                  assert.deepEqual(forwardedCallbacks, []);
                }),
              ),
            );
            const completed = yield* client[WS_METHODS.providerAuthComplete]({
              ...target,
              flowId,
              callbackUrl,
            });
            assert.equal(completed.phase, "verifying");
            const cancelled = yield* client[WS_METHODS.providerAuthCancel]({ ...target, flowId });
            assert.equal(cancelled.phase, "cancelled");
            const signedOut = yield* client[WS_METHODS.providerAuthLogout](target);
            assert.equal(signedOut.phase, "idle");
          }),
        ),
      );
      assert.deepEqual(forwardedCallbacks, [callbackUrl]);
      assert.deepEqual(logoutInstances, [providerSetupInstanceId]);
      assert.isTrue(calls.every((call) => call.instanceId === providerSetupInstanceId));
      assert.deepEqual(
        calls.map((call) => call.ownerSessionId),
        [firstOwner, firstOwner, secondOwner, secondOwner, firstOwner, firstOwner],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "provider setup routes installation operations and returns only safe typed errors",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let state = providerSetupInstallState;
        yield* buildAppUnderTest({
          layers: {
            providerInstanceRegistry: {
              getInstance: (instanceId) =>
                Effect.succeed(
                  instanceId === providerSetupInstanceId ? providerSetupInstance : undefined,
                ),
            },
            antigravityInstallation: {
              start: Effect.sync(() => {
                calls.push("start");
                return state;
              }),
              cancel: (operationId) =>
                Effect.gen(function* () {
                  calls.push(`cancel:${operationId}`);
                  if (operationId !== state.operationId) {
                    return yield* new AntigravityInstallationError({
                      operation: "cancel",
                      detail: "This installation is no longer running.",
                      cause: new Error("Private download diagnostics."),
                    });
                  }
                  state = { ...state, phase: "cancelled" };
                  return state;
                }),
              changes: Stream.fromEffect(Effect.sync(() => state)),
            },
          },
        });
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const unknownInstance = yield* client[WS_METHODS.providerInstallStart]({
                instanceId: ProviderInstanceId.make("unknown-instance"),
              }).pipe(Effect.flip);
              assert.equal(unknownInstance._tag, "ProviderSetupError");
              assert.deepEqual(calls, []);
              const started = yield* client[WS_METHODS.providerInstallStart]({
                instanceId: providerSetupInstanceId,
              });
              assert.deepEqual(started, providerSetupInstallState);
              const stale = yield* client[WS_METHODS.providerInstallCancel]({
                instanceId: providerSetupInstanceId,
                operationId: "old-operation",
              }).pipe(Effect.flip);
              assert.equal(stale._tag, "ProviderSetupError");
              if (stale._tag === "ProviderSetupError") {
                assert.equal(stale.instanceId, providerSetupInstanceId);
                assert.equal(stale.operation, "cancel");
                assert.equal(stale.detail, "This installation is no longer running.");
                assert.notProperty(stale, "cause");
              }
              const cancelled = yield* client[WS_METHODS.providerInstallCancel]({
                instanceId: providerSetupInstanceId,
                operationId: "install-operation",
              });
              assert.equal(cancelled.phase, "cancelled");
              const observed = yield* client[WS_METHODS.providerInstallSubscribe]({
                instanceId: providerSetupInstanceId,
              }).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
              assert.deepEqual(observed, cancelled);
            }),
          ),
        );
        assert.deepEqual(calls, ["start", "cancel:old-operation", "cancel:install-operation"]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providers = [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          otlpLogsUrl: "http://localhost:4318/v1/logs",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(path.basename(first.config.observability.logsDirectoryPath), "logs");
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.equal(first.config.observability.otlpLogsUrl, "http://localhost:4318/v1/logs");
        assert.equal(first.config.observability.otlpLogsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { keybindings: [], issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves config on reconnect without starting provider probes", () =>
    Effect.gen(function* () {
      const refresh = vi.fn(() => Effect.never);
      yield* buildAppUnderTest({
        layers: { providerRegistry: { refresh } },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      for (let connection = 0; connection < 2; connection += 1) {
        const event = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({}).pipe(
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            ),
          ),
        );
        assert.equal(event.type, "snapshot");
      }
      assert.equal(refresh.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns cached whole-host resources over websocket", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();
      const wsUrl = yield* getWsServerUrl("/ws");
      const [first, second] = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all(
            [
              client[WS_METHODS.serverGetHostResources]({}),
              client[WS_METHODS.serverGetHostResources]({}),
            ],
            { concurrency: "unbounded" },
          ),
        ),
      );
      assert.deepEqual(first, second);
      assert.isAtLeast(first.sampledAt, 0);
      assert.isAbove(first.cpuCount, 0);
      assert.isAbove(first.totalMemoryBytes, 0);
      assert.isAtLeast(first.availableMemoryBytes, 0);
      assert.isAtMost(first.availableMemoryBytes, first.totalMemoryBytes);
      if (first.cpuUtilization !== null) {
        assert.isAtLeast(first.cpuUtilization, 0);
        assert.isAtMost(first.cpuUtilization, 1);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("counts macOS reclaimable memory once and shares concurrent samples", () =>
    Effect.gen(function* () {
      const commandCalls = yield* Ref.make(0);
      const hostResources = yield* HostResources.make().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            string: () =>
              Ref.update(commandCalls, (count) => count + 1).pipe(
                Effect.as(
                  "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n" +
                    "Pages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n" +
                    "Pages purgeable: 999.\n",
                ),
              ),
          }),
        ),
      );
      const [first, second] = yield* Effect.all([hostResources.read, hostResources.read], {
        concurrency: "unbounded",
      });
      assert.equal(first.availableMemoryBytes, 35 * 16384);
      assert.deepEqual(first, second);
      assert.deepEqual(yield* hostResources.read, first);
      assert.equal(yield* Ref.get(commandCalls), 1);
    }).pipe(TestClock.withLive),
  );

  it.effect("retries host sampling immediately after its caller is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const commandCalls = yield* Ref.make(0);
      const hostResources = yield* HostResources.make().pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provide(
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({
            string: () =>
              Effect.gen(function* () {
                const call = yield* Ref.updateAndGet(commandCalls, (count) => count + 1);
                if (call === 1) {
                  yield* Deferred.succeed(started, undefined);
                  return yield* Effect.never;
                }
                return (
                  "Mach Virtual Memory Statistics: (page size of 4096 bytes)\n" +
                  "Pages free: 10.\nPages inactive: 20.\nPages speculative: 5.\n"
                );
              }),
          }),
        ),
      );
      const firstRead = yield* hostResources.read.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(firstRead);
      const recovered = yield* hostResources.read;
      assert.equal(recovered.availableMemoryBytes, 35 * 4096);
      assert.equal(yield* Ref.get(commandCalls), 2);
    }).pipe(TestClock.withLive),
  );

  it.effect("routes websocket resource telemetry through the subscription", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const snapshot = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeResourceTelemetry]({}).pipe(Stream.runHead),
        ),
      );

      assertTrue(Option.isSome(snapshot));
      assert.equal(snapshot.value.processes.length, 0);
      assert.equal(snapshot.value.groups.backend.processCount, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  // An already-shipped client decodes this stream against an event union
  // without environmentThemesUpdated, so an ungated emit would kill its whole
  // config subscription. Opting in is the only way to receive them.
  it.effect("subscribeServerConfig sends published themes to an opt-in subscriber", () =>
    Effect.gen(function* () {
      const themes = [
        {
          id: "nightfall",
          name: "Nightfall",
          appearance: "dark" as const,
          canvas: "#1a1b26",
          accent: "#7aa2f7",
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          environmentTheme: {
            current: Effect.succeed(themes),
            streamChanges: Stream.succeed(themes),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({ environmentThemes: true }).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      // Not in the snapshot as well, or every opt-in client receives the same
      // array twice on every connect.
      if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
      assert.equal(second?.type, "environmentThemesUpdated");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeServerConfig withholds published themes from other subscribers", () =>
    Effect.gen(function* () {
      const themes = [
        {
          id: "nightfall",
          name: "Nightfall",
          appearance: "dark" as const,
          canvas: "#1a1b26",
          accent: "#7aa2f7",
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          environmentTheme: {
            current: Effect.succeed(themes),
            streamChanges: Stream.succeed(themes),
          },
          providerRegistry: { streamChanges: Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(1), Stream.runCollect),
        ),
      );

      const first = Array.from(events)[0];
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") assert.equal(first.config.environmentThemes, undefined);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([false, true])(
    "routes websocket rpc subscribeServerConfig emits provider status updates (limits: %s)",
    (hasLimits) =>
      Effect.gen(function* () {
        const nextProviders = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            installed: true,
            version: "1.0.0",
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            checkedAt: "2026-04-11T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
            ...(hasLimits
              ? {
                  usageLimits: {
                    checkedAt: "2026-04-11T00:00:00.000Z",
                    windows: [
                      { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 },
                    ],
                  },
                }
              : {}),
          },
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({
                keybindings: [],
                issues: [],
              }),
              streamChanges: Stream.empty,
            },
            providerRegistry: {
              getProviders: Effect.succeed([]),
              streamChanges: Stream.succeed(nextProviders),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({ usageLimitsCommand: true }).pipe(
              Stream.take(2),
              Stream.runCollect,
            ),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.config.providers, []);
        }
        assert.deepEqual(second, {
          version: 1,
          type: "providerStatuses",
          payload: {
            providers: hasLimits
              ? [
                  {
                    ...nextProviders[0],
                    slashCommands: [
                      {
                        name: "usage-limits",
                        description: "Show this provider's usage limits",
                      },
                    ],
                  },
                ]
              : nextProviders,
          },
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerConfig keeps the limits command from clients that do not ask for it",
    () =>
      Effect.gen(function* () {
        const codex = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt: "2026-04-11T00:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 }],
          },
        };
        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
              streamChanges: Stream.empty,
            },
            providerRegistry: {
              getProviders: Effect.succeed([codex]),
              streamChanges: Stream.succeed([{ ...codex, version: "1.0.1" }]),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.config.providers, [codex]);
        }
        assert.deepEqual(second, {
          version: 1,
          type: "providerStatuses",
          payload: { providers: [{ ...codex, version: "1.0.1" }] },
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerConfig republishes commands when only a limits source changes",
    () =>
      Effect.gen(function* () {
        const codex = {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        };
        const hub = {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy" as const,
          label: "Accounts",
          checkedAt: "2026-04-11T00:00:00.000Z",
          accounts: [
            {
              id: "work",
              driver: ProviderDriverKind.make("codex"),
              usageLimits: {
                checkedAt: "2026-04-11T00:00:00.000Z",
                windows: [
                  { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 25 },
                ],
              },
            },
          ],
        };

        yield* buildAppUnderTest({
          layers: {
            keybindings: {
              loadConfigState: Effect.succeed({ keybindings: [], issues: [] }),
              streamChanges: Stream.empty,
            },
            // The registry emits no change: only the source refresh can carry it.
            providerRegistry: {
              getProviders: Effect.succeed([codex]),
              streamChanges: Stream.empty,
            },
            usageLimitSources: {
              current: Effect.succeed([]),
              // Replay the empty snapshot, then a later refresh, as the live stream does.
              streamChanges: Stream.concat(Stream.make([]), Stream.make([hub])),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerConfig]({ usageLimitsCommand: true }).pipe(
              Stream.take(2),
              Stream.runCollect,
            ),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "snapshot");
        if (first?.type === "snapshot") {
          assert.deepEqual(first.config.providers, [codex]);
        }
        assert.deepEqual(second, {
          version: 1,
          type: "providerStatuses",
          payload: {
            providers: [
              {
                ...codex,
                slashCommands: [
                  { name: "usage-limits", description: "Show this provider's usage limits" },
                ],
              },
            ],
          },
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: "2026-01-01T00:00:00.000Z", environment: testEnvironmentDescriptor },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeServerLifecycle buffers updates published during snapshot capture", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
      const streamSubscribed = yield* Deferred.make<void>();
      const snapshotPublished = yield* Deferred.make<void>();
      const bootstrapProjectId = ProjectId.make("project-bootstrap");
      const bootstrapThreadId = ThreadId.make("thread-bootstrap");
      const snapshotEvent = {
        version: 1 as const,
        sequence: 1,
        type: "welcome" as const,
        payload: {
          environment: testEnvironmentDescriptor,
          cwd: "/tmp/project",
          projectName: "project",
          bootstrapStatus: "pending" as const,
        },
      };
      const gapEvent = {
        version: 1 as const,
        sequence: 2,
        type: "welcome" as const,
        payload: {
          environment: testEnvironmentDescriptor,
          cwd: "/tmp/project",
          projectName: "project",
          bootstrapStatus: "complete" as const,
          bootstrapProjectId,
          bootstrapThreadId,
          bootstrapProjectCreated: true,
          bootstrapThreadCreated: true,
        },
      };
      const sentinelEvent = {
        version: 1 as const,
        sequence: 3,
        type: "ready" as const,
        payload: { at: "2026-01-01T00:00:01.000Z", environment: testEnvironmentDescriptor },
      };
      const liveStream = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          yield* Deferred.succeed(streamSubscribed, undefined);
          return Stream.fromSubscription(subscription);
        }),
      );

      yield* buildAppUnderTest({
        layers: {
          serverLifecycleEvents: {
            snapshot: PubSub.publish(pubsub, gapEvent).pipe(
              Effect.andThen(Deferred.succeed(snapshotPublished, undefined)),
              Effect.as({ sequence: 1, events: [snapshotEvent] }),
            ),
            stream: liveStream,
          },
        },
      });

      yield* Effect.gen(function* () {
        yield* Deferred.await(snapshotPublished);
        yield* Deferred.await(streamSubscribed);
        yield* PubSub.publish(pubsub, sentinelEvent);
      }).pipe(Effect.forkScoped);

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "welcome");
      assert.equal(first?.sequence, 1);
      if (first?.type !== "welcome") {
        assert.fail("expected the pending bootstrap event");
      }
      assert.equal(first.payload.bootstrapStatus, "pending");
      assert.equal(second?.type, "welcome");
      assert.equal(second?.sequence, 2);
      if (second?.type !== "welcome") {
        assert.fail("expected the bootstrap completion event");
      }
      assert.equal(second.payload.bootstrapStatus, "complete");
      assert.equal(second.payload.bootstrapProjectId, bootstrapProjectId);
      assert.equal(second.payload.bootstrapThreadId, bootstrapThreadId);
      assert.equal(second.payload.bootstrapProjectCreated, true);
      assert.equal(second.payload.bootstrapThreadCreated, true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("routes websocket rpc projects.listEntries and projects.readFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-files-" });
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "index.ts"),
        "export const answer = 42;\n",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            listing: client[WS_METHODS.projectsListEntries]({ cwd: workspaceDir }),
            file: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "src/index.ts",
            }),
          }),
        ),
      );

      assert.isTrue(response.listing.entries.some((entry) => entry.path === "src/index.ts"));
      assert.deepEqual(response.file, {
        relativePath: "src/index.ts",
        contents: "export const answer = 42;\n",
        byteLength: 26,
        truncated: false,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("routes websocket rpc projects.searchEntries excludes gitignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-project-search-gitignored-",
      });
      yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
        "export const ignored = true;",
      );
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "tracked.ts"),
        "export const ok = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({
                paths: ["src/tracked.ts"],
                truncated: false,
                freshness: {
                  source: "live-local",
                  observedAt: TEST_EPOCH,
                  expiresAt: Option.none(),
                },
              }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "ignored-search-target",
            limit: 10,
          }),
        ),
      );

      assert.equal(response.entries.length, 0);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect.skipIf(!symlinksSupported)("preserves structured workspace rpc failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-",
      });
      const outsideDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-errors-outside-",
      });
      const outsideFile = path.join(outsideDir, "outside.txt");
      yield* fs.writeFileString(outsideFile, "outside\n");
      yield* fs.symlink(outsideFile, path.join(workspaceDir, "linked-outside.txt"));
      const resolvedOutsideFile = yield* fs.realPath(outsideFile);

      yield* buildAppUnderTest();

      const invalidWorkspace = path.join(workspaceDir, "missing-workspace");
      const missingBrowseParent = path.join(workspaceDir, "missing-browse");
      const sensitiveQuery = "authorization: Bearer secret-token";
      const wsUrl = yield* getWsServerUrl("/ws");
      const results = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            search: client[WS_METHODS.projectsSearchEntries]({
              cwd: invalidWorkspace,
              query: sensitiveQuery,
              limit: 10,
            }).pipe(Effect.result),
            list: client[WS_METHODS.projectsListEntries]({ cwd: invalidWorkspace }).pipe(
              Effect.result,
            ),
            read: client[WS_METHODS.projectsReadFile]({
              cwd: workspaceDir,
              relativePath: "linked-outside.txt",
            }).pipe(Effect.result),
            browse: client[WS_METHODS.filesystemBrowse]({
              cwd: workspaceDir,
              partialPath: "./missing-browse/child",
            }).pipe(Effect.result),
          }),
        ),
      );

      if (
        results.search._tag !== "Failure" ||
        results.search.failure._tag !== "ProjectSearchEntriesError"
      ) {
        assert.fail("Expected a ProjectSearchEntriesError");
      }
      const searchError = results.search.failure;
      assert.equal(
        searchError.message,
        `Failed to search workspace entries in '${invalidWorkspace}'.`,
      );
      assert.equal(searchError.cwd, invalidWorkspace);
      assert.equal(searchError.queryLength, sensitiveQuery.length);
      assert.notProperty(searchError, "query");
      assert.notInclude(searchError.message, "Bearer");
      assert.notInclude(searchError.message, "secret-token");
      assert.equal(searchError.limit, 10);
      assert.equal(searchError.failure, "workspace_root_not_found");
      assert.equal(searchError.normalizedCwd, invalidWorkspace);
      assert.isDefined(searchError.cause);

      if (
        results.list._tag !== "Failure" ||
        results.list.failure._tag !== "ProjectListEntriesError"
      ) {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const listError = results.list.failure;
      assert.equal(listError.message, `Failed to list workspace entries in '${invalidWorkspace}'.`);
      assert.equal(listError.cwd, invalidWorkspace);
      assert.equal(listError.failure, "workspace_root_not_found");
      assert.equal(listError.normalizedCwd, invalidWorkspace);
      assert.isDefined(listError.cause);

      if (results.read._tag !== "Failure" || results.read.failure._tag !== "ProjectReadFileError") {
        assert.fail("Expected a ProjectReadFileError");
      }
      const readError = results.read.failure;
      assert.equal(
        readError.message,
        `Failed to read workspace file 'linked-outside.txt' in '${workspaceDir}'.`,
      );
      assert.equal(readError.cwd, workspaceDir);
      assert.equal(readError.relativePath, "linked-outside.txt");
      assert.equal(readError.failure, "resolved_path_outside_root");
      assert.equal(readError.resolvedPath, resolvedOutsideFile);
      assert.isDefined(readError.cause);

      if (
        results.browse._tag !== "Failure" ||
        results.browse.failure._tag !== "FilesystemBrowseError"
      ) {
        assert.fail("Expected a FilesystemBrowseError");
      }
      const browseError = results.browse.failure;
      assert.equal(
        browseError.message,
        `Failed to browse filesystem path './missing-browse/child' from '${workspaceDir}'.`,
      );
      assert.equal(browseError.cwd, workspaceDir);
      assert.equal(browseError.partialPath, "./missing-browse/child");
      assert.equal(browseError.failure, "read_directory_failed");
      assert.equal(browseError.parentPath, missingBrowseParent);
      assert.isDefined(browseError.cause);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports workspace root stat failures without relabeling them as missing", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const blockedRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-workspace-stat-error-",
      });
      const workspaceRoot = path.join(blockedRoot, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      yield* fs.chmod(blockedRoot, 0o000);

      const result = yield* Effect.gen(function* () {
        yield* buildAppUnderTest();
        const wsUrl = yield* getWsServerUrl("/ws");
        return yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.projectsListEntries]({ cwd: workspaceRoot }).pipe(Effect.result),
          ),
        );
      }).pipe(Effect.ensuring(fs.chmod(blockedRoot, 0o700).pipe(Effect.ignore)));

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectListEntriesError") {
        assert.fail("Expected a ProjectListEntriesError");
      }
      const error = result.failure;
      assert.equal(error.failure, "workspace_root_stat_failed");
      assert.equal(error.normalizedCwd, workspaceRoot);
      assert.equal(error.detail, "validate-existing");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates a missing workspace root during websocket project.create dispatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-create-" });
      const missingWorkspaceRoot = path.join(parentDir, "nested", "new-project");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-missing-root"),
            projectId: ProjectId.make("project-create-missing-root"),
            title: "New Project",
            workspaceRoot: missingWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      const stat = yield* fs.stat(missingWorkspaceRoot);

      assert.isAtLeast(response.sequence, 0);
      assert.equal(stat.type, "Directory");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("starts a project clone in the background and blocks threads until it lands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-clone-" });
      const destinationPath = path.join(parentDir, "t2code");
      const projectId = ProjectId.make("project-clone-1");
      const dispatched: Array<string> = [];
      const cloneGate = yield* Deferred.make<void>();
      const metaUpdateDispatched = yield* Deferred.make<void>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command.type);
                return { sequence: dispatched.length };
              }).pipe(
                Effect.tap(() =>
                  command.type === "project.meta.update"
                    ? Deferred.succeed(metaUpdateDispatched, undefined)
                    : Effect.void,
                ),
              ),
          },
          sourceControlRepositoryService: {
            prepareClone: (input) =>
              Effect.succeed({
                destinationPath: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                cloneUrl: input.remoteUrl ?? "",
                repository: null,
              }),
            cloneRepository: (input) =>
              Deferred.await(cloneGate).pipe(
                Effect.as({
                  cwd: input.destinationPath,
                  remoteUrl: input.remoteUrl ?? "",
                  repository: null,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const started = yield* client[WS_METHODS.projectCloneStart]({
              projectId,
              title: "t2code",
              createdAt: "2026-01-01T00:00:00.000Z",
              remoteUrl: "git@github.com:octocat/t2code.git",
              destinationPath,
            });
            assert.equal(started.cwd, destinationPath);
            // The project exists before the clone finishes.
            assert.deepEqual(dispatched, ["project.create"]);

            const blocked = yield* Effect.flip(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make("cmd-thread-create-while-cloning"),
                threadId: ThreadId.make("thread-while-cloning"),
                projectId,
                title: "Draft",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5-codex",
                },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: "2026-01-01T00:00:01.000Z",
              }),
            );
            assert.include(String(blocked.message), "still being cloned");

            const snapshots = yield* client[WS_METHODS.subscribeProjectClones]({}).pipe(
              Stream.takeUntil((clones) => clones[0]?.phase === "done"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* Effect.yieldNow;
            yield* Deferred.succeed(cloneGate, undefined);
            const lists = yield* Fiber.join(snapshots);
            assert.equal(lists.at(-1)?.[0]?.phase, "done");
            // The finished clone refreshes the project so its repository
            // identity updates. That hook runs after the done snapshot.
            yield* Deferred.await(metaUpdateDispatched);
            assert.deepEqual(dispatched, ["project.create", "project.meta.update"]);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records thread analytics only after a client command succeeds", () =>
    Effect.gen(function* () {
      const effects: string[] = [];
      const analyticsProperties: Array<Readonly<Record<string, unknown>> | undefined> = [];
      const failedCommandId = CommandId.make("cmd-thread-create-failed");

      yield* buildAppUnderTest({
        layers: {
          analyticsService: {
            record: (event, properties) =>
              Effect.sync(() => {
                effects.push(`analytics:${event}`);
                analyticsProperties.push(properties);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => effects.push(`dispatch:${command.commandId}`)).pipe(
                Effect.flatMap(() =>
                  command.commandId === failedCommandId
                    ? Effect.fail(
                        new PersistenceSqlError({
                          operation: "OrchestrationEventStore.append:query",
                          detail: "thread creation failed",
                        }),
                      )
                    : Effect.succeed({ sequence: 1 }),
                ),
              ),
          },
        },
      });

      const createThreadCommand = (commandId: CommandId, threadId: ThreadId) =>
        ({
          type: "thread.create",
          commandId,
          threadId,
          projectId: defaultProjectId,
          title: "Analytics test",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        }) as const;

      const wsUrl = yield* getWsServerUrl(
        "/ws?clientSurface=mobile&clientAppVersion=1.2.3&clientDeviceType=phone&clientOs=iOS&clientOsMajorVersion=18&clientDeviceModel=iPhone+15+Pro&connectionMethod=relay",
      );
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const failed = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              createThreadCommand(failedCommandId, ThreadId.make("thread-create-failed")),
            ).pipe(Effect.result);

            assert.equal(failed._tag, "Failure");
            assert.deepEqual(effects, [
              "analytics:client.connected",
              "dispatch:cmd-thread-create-failed",
            ]);

            const succeeded = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              createThreadCommand(
                CommandId.make("cmd-thread-create-succeeded"),
                ThreadId.make("thread-create-succeeded"),
              ),
            );

            assert.equal(succeeded.sequence, 1);
          }),
        ),
      );

      assert.deepEqual(effects, [
        "analytics:client.connected",
        "dispatch:cmd-thread-create-failed",
        "dispatch:cmd-thread-create-succeeded",
        "analytics:client.thread.started",
      ]);
      assert.deepEqual(analyticsProperties, [
        {
          surface: "mobile",
          appVersion: "1.2.3",
          clientAppVersion: "1.2.3",
          clientOs: "iOS",
          os: "iOS",
          clientDeviceType: "phone",
          osMajorVersion: 18,
          clientOsMajorVersion: 18,
          deviceModel: "iPhone 15 Pro",
          clientDeviceModel: "iPhone 15 Pro",
          connectionMethod: "relay",
        },
        {
          surface: "mobile",
          appVersion: "1.2.3",
          clientAppVersion: "1.2.3",
          clientOs: "iOS",
          os: "iOS",
          clientDeviceType: "phone",
          osMajorVersion: 18,
          clientOsMajorVersion: 18,
          deviceModel: "iPhone 15 Pro",
          clientDeviceModel: "iPhone 15 Pro",
          connectionMethod: "relay",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("keeps telemetry separate for simultaneous clients", () =>
    Effect.gen(function* () {
      const analyticsEvents: Array<{
        event: string;
        properties: Readonly<Record<string, unknown>> | undefined;
      }> = [];

      yield* buildAppUnderTest({
        layers: {
          analyticsService: {
            record: (event, properties) =>
              Effect.sync(() => analyticsEvents.push({ event, properties })),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 1 }),
          },
        },
      });

      const webUrl = yield* getWsServerUrl(
        "/ws?clientSurface=web&clientAppVersion=2.0.0&clientDeviceType=desktop&clientOs=Windows&clientWebDeployment=hosted&clientBrowser=Chrome&connectionMethod=direct",
      );
      const mobileUrl = yield* getWsServerUrl(
        "/ws?clientSurface=mobile&clientAppVersion=3.0.0&clientDeviceType=tablet&clientOs=Android&clientOsMajorVersion=15&clientDeviceModel=Pixel+Tablet&connectionMethod=relay",
      );
      const turnCommand = (client: string) => ({
        type: "thread.turn.start" as const,
        commandId: CommandId.make(`cmd-${client}-turn`),
        threadId: ThreadId.make(`thread-${client}`),
        message: {
          messageId: MessageId.make(`message-${client}`),
          role: "user" as const,
          text: "hello",
          attachments: [],
        },
        modelSelection: defaultModelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* Effect.scoped(
        withWsRpcClient(webUrl, (webClient) =>
          withWsRpcClient(mobileUrl, (mobileClient) =>
            Effect.gen(function* () {
              yield* mobileClient[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand("mobile"));
              yield* webClient[ORCHESTRATION_WS_METHODS.dispatchCommand](turnCommand("web"));
            }),
          ),
        ),
      );

      assert.deepEqual(
        analyticsEvents
          .filter(({ event }) => event === "client.turn.requested")
          .map(({ properties }) => properties),
        [
          {
            surface: "mobile",
            appVersion: "3.0.0",
            clientAppVersion: "3.0.0",
            clientOs: "Android",
            os: "Android",
            clientDeviceType: "tablet",
            osMajorVersion: 15,
            clientOsMajorVersion: 15,
            deviceModel: "Pixel Tablet",
            clientDeviceModel: "Pixel Tablet",
            connectionMethod: "relay",
          },
          {
            surface: "web",
            appVersion: "2.0.0",
            clientAppVersion: "2.0.0",
            clientOs: "Windows",
            clientDeviceType: "desktop",
            webDeployment: "hosted",
            clientBrowser: "Chrome",
            connectionMethod: "direct",
          },
        ],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("ignores invalid client telemetry without rejecting the connection", () =>
    Effect.gen(function* () {
      const connectedProperties: Array<Readonly<Record<string, unknown>> | undefined> = [];

      yield* buildAppUnderTest({
        layers: {
          analyticsService: {
            record: (event, properties) =>
              event === "client.connected"
                ? Effect.sync(() => connectedProperties.push(properties))
                : Effect.void,
          },
        },
      });

      const invalidUrl = yield* getWsServerUrl(
        "/ws?clientSurface=watch&clientDeviceType=television&clientOs=Plan9&clientWebDeployment=cdn&clientBrowser=&clientOsMajorVersion=-1&connectionMethod=teleport",
      );
      yield* Effect.scoped(
        withWsRpcClient(invalidUrl, (client) => client[WS_METHODS.serverGetSettings]({})),
      );

      assert.deepEqual(connectedProperties, [{}]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      if (result._tag !== "Failure" || result.failure._tag !== "ProjectWriteFileError") {
        assert.fail("Expected a ProjectWriteFileError");
      }
      const writeError = result.failure;
      assert.equal(
        writeError.message,
        `Failed to write workspace file '../escape.txt' in '${workspaceDir}'.`,
      );
      assert.equal(writeError.cwd, workspaceDir);
      assert.equal(writeError.relativePath, "../escape.txt");
      assert.equal(writeError.failure, "workspace_path_outside_root");
      assert.isDefined(writeError.cause);
      assert.notProperty(writeError, "contents");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const externalLauncherError = new ExternalLauncherCommandNotFoundError({
        editor: "cursor",
        command: "cursor",
      });
      yield* buildAppUnderTest({
        layers: {
          externalLauncher: {
            launchEditor: () => Effect.fail(externalLauncherError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, externalLauncherError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          cwd: "/tmp/repo",
        },
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.succeed({
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
                isOnPullRequestHead: true,
              }),
          },
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                refName: "main",
                upstreamRef: "origin/main",
              }),
            listRefs: () =>
              Effect.succeed({
                refs: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", refName: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createRef: (input) => Effect.succeed({ refName: input.refName }),
            switchRef: (input) => Effect.succeed({ refName: input.refName }),
          },
          vcsStatusBroadcaster: {
            refreshStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
          },
          reviewService: {
            getDiffPreview: (input) =>
              Effect.succeed({
                cwd: input.cwd,
                generatedAt: DateTime.nowUnsafe(),
                sources: [
                  {
                    id: "working-tree",
                    kind: "working-tree",
                    title: "Dirty worktree",
                    baseRef: "HEAD",
                    headRef: null,
                    diff: "dirty-diff",
                    diffHash: "hash-dirty",
                    truncated: false,
                  },
                  {
                    id: "branch-range",
                    kind: "branch-range",
                    title: "Against main",
                    baseRef: "main",
                    headRef: "feature/demo",
                    diff: "base-diff",
                    diffHash: "hash-base",
                    truncated: false,
                  },
                ],
              }),
            getDiffFileContents: () =>
              Effect.succeed({
                oldContents: "before\n",
                newContents: "after\n",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const refreshedStatus = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRefreshStatus]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(refreshedStatus.isRepo, true);

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const refs = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsListRefs]({ cwd: "/tmp/repo" })),
      );
      assert.equal(refs.refs[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateWorktree]({
            cwd: "/tmp/repo",
            refName: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.refName, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsCreateRef]({
            cwd: "/tmp/repo",
            refName: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsSwitchRef]({
            cwd: "/tmp/repo",
            refName: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.vcsInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );

      const diffPreview = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.reviewGetDiffPreview]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(diffPreview.sources[0]?.diff, "dirty-diff");

      const diffFileContents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.reviewGetDiffFileContents]({
            cwd: "/tmp/repo",
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "README.md",
            newPath: "README.md",
          }),
        ),
      );
      assert.equal(diffFileContents.oldContents, "before\n");
      assert.equal(diffFileContents.newContents, "after\n");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: true,
                  refName: "main",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.runStackedAction errors after refreshing git status", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "commit",
        command: "git commit",
        cwd: "/tmp/repo",
        detail: "nothing to commit",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: false,
                refName: "feature/demo",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            runStackedAction: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(Stream.runCollect, Effect.result),
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("completes websocket rpc git.pull before background git status refresh finishes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled" as const,
                refName: "main",
                upstreamRef: "origin/main",
              }),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sleep(Duration.seconds(2)).pipe(
                Effect.as({
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.vcsPull]({ cwd: "/tmp/repo" })),
      );
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

      assert.equal(result.status, "pulled");
      assertTrue(elapsedMs < 1_000);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "completes websocket rpc git.runStackedAction before background git status refresh finishes",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: true,
                  isDefaultRef: false,
                  refName: "feature/demo",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

        assertTrue(elapsedMs < 1_000);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "starts a background local git status refresh after a successful git.runStackedAction",
    () =>
      Effect.gen(function* () {
        const localRefreshStarted = yield* Deferred.make<void>();

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              invalidateStatus: () => Effect.void,
              localStatus: () =>
                Deferred.succeed(localRefreshStarted, undefined).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.succeed({
                      isRepo: true,
                      hasPrimaryRemote: true,
                      isDefaultRef: false,
                      refName: "feature/demo",
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    }),
                  ),
                ),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );

        yield* Deferred.await(localRefreshStarted);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.make("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            pullRequests: [],
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
            searchThreads: () =>
              Effect.succeed({
                matches: [
                  {
                    threadId: ThreadId.make("thread-1"),
                    projectId: ProjectId.make("project-a"),
                    source: "assistant",
                    snippet: "Search reached the final response.",
                    messageCreatedAt: now,
                  },
                ],
              }),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-1"),
            threadId: ThreadId.make("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.make("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const searchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.searchThreads]({
            query: "final response",
          }),
        ),
      );
      assert.deepEqual(searchResult.matches, [
        {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-a"),
          source: "assistant",
          snippet: "Search reached the final response.",
          messageCreatedAt: now,
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration shell snapshot errors", () =>
    Effect.gen(function* () {
      const projectionError = new PersistenceSqlError({
        operation: "ProjectionSnapshotQuery.getShellSnapshot:test",
        detail: "failed to read projection shell snapshot",
      });
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () => Effect.fail(projectionError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(Stream.runCollect),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationGetSnapshotError");
      assertTrue(result.failure.cause instanceof Error);
      assert.include(result.failure.cause.message, projectionError.message);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("marks an empty shell catch-up replay as synchronized when requested", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: () => Stream.empty,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const firstItem = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.runHead),
        ),
      );

      assert.deepEqual(Option.getOrThrow(firstItem), { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const reasoningMessages of [undefined, true] as const) {
    it.effect(`preserves reasoning wire compatibility with opt-in ${reasoningMessages}`, () =>
      Effect.gen(function* () {
        const message = {
          id: MessageId.make("thinking-compatibility"),
          role: "reasoning" as const,
          text: "Checking the available evidence.",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
        const thread = { ...makeDefaultOrchestrationReadModel().threads[0]!, messages: [message] };
        const event = {
          sequence: 2,
          eventId: EventId.make("thinking-compatibility-event"),
          aggregateKind: "thread" as const,
          aggregateId: defaultThreadId,
          occurredAt: message.createdAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent" as const,
          payload: {
            messageId: message.id,
            threadId: defaultThreadId,
            role: message.role,
            text: message.text,
            turnId: message.turnId,
            streaming: message.streaming,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        } satisfies OrchestrationEvent;
        const answer = {
          ...event,
          sequence: 3,
          eventId: EventId.make("thinking-answer-event"),
          payload: {
            ...event.payload,
            messageId: MessageId.make("thinking-answer"),
            role: "assistant" as const,
            text: "Here is the answer.",
          },
        };
        const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              streamDomainEvents: Stream.fromPubSub(liveEvents),
              latestSequence: Effect.succeed(3),
              getThreadReplayStats: () =>
                Effect.succeed({ eventCount: 2, payloadBytes: 200, hasCreateEvent: false }),
              readThreadEvents: () => Stream.make(event, answer),
            },
            projectionSnapshotQuery: {
              getThreadDetailSnapshot: () =>
                Effect.gen(function* () {
                  yield* PubSub.publishAll(liveEvents, [event, answer]);
                  return Option.some({
                    snapshotSequence: 1,
                    thread,
                    page: {
                      beforeCursor: null,
                      hasMore: false,
                      snapshotSequence: 1,
                      threadSequence: 2,
                    },
                  });
                }),
            },
          },
        });
        const role = reasoningMessages ? "reasoning" : "system";
        const response = yield* fetchEffect(
          yield* getHttpServerUrl(
            `/api/orchestration/threads/${defaultThreadId}?turnLimit=1${reasoningMessages ? "&reasoningMessages=true" : ""}`,
          ),
          { headers: { cookie: yield* getAuthenticatedSessionCookieHeader() } },
        );
        const httpSnapshot = yield* responseJsonEffect<OrchestrationThreadDetailSnapshot>(response);
        assert.equal(response.status, 200);
        assert.deepEqual(httpSnapshot.thread.messages, [{ ...message, role }]);
        assert.equal(httpSnapshot.page?.threadSequence, 2);
        const wsUrl = yield* getWsServerUrl("/ws");
        for (const afterSequence of [undefined, 1]) {
          const items = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId: defaultThreadId,
                requestCompletionMarker: true,
                ...(reasoningMessages ? { reasoningMessages } : {}),
                ...(afterSequence !== undefined ? { afterSequence } : {}),
              }).pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runCollect,
              ),
            ),
          );
          if (afterSequence === undefined) {
            const first = items[0];
            assertTrue(first?.kind === "snapshot");
            assert.deepEqual(first.snapshot.thread.messages, [{ ...message, role }]);
            assert.equal(first.snapshot.page?.threadSequence, 2);
          }
          const events = items.filter((item) => item.kind === "event");
          assert.equal(events.length, 2);
          assert.deepEqual(events[0]?.event, { ...event, payload: { ...event.payload, role } });
          assert.deepEqual(events[1]?.event, answer);
          assert.deepEqual(items.at(-1), { kind: "synchronized" });
        }
        assert.equal(message.role, "reasoning");
        assert.equal(event.payload.role, "reasoning");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("marks a socket thread snapshot as synchronized when requested", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 1, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(items[1], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("buffers shell events published while the fallback snapshot loads", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const deletedEvent = {
        sequence: 2,
        eventId: EventId.make("event-shell-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.deleted",
        payload: {
          threadId: defaultThreadId,
          deletedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.gen(function* () {
                yield* PubSub.publish(liveEvents, deletedEvent);
                return {
                  snapshotSequence: 1,
                  projects: [],
                  threads: [makeDefaultOrchestrationThreadShell()],
                  updatedAt: "2026-01-01T00:00:00.000Z",
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "thread-removed");
      assert.deepEqual(items[2], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("buffers thread events published while the initial snapshot loads", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const messageEvent = {
        sequence: 2,
        eventId: EventId.make("event-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "First message",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* PubSub.publish(liveEvents, messageEvent);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "event");
      assert.equal(items[1]?.kind === "event" ? items[1].event.sequence : null, 2);
      assert.equal(items[2]?.kind, "synchronized");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const subscription of ["thread", "shell"] as const) {
    it.effect("delivers large raw tool results through the " + subscription + " stream", () =>
      Effect.gen(function* () {
        const eventThreadId =
          subscription === "thread" ? defaultThreadId : ThreadId.make("other-live-thread");
        const thread = makeDefaultOrchestrationReadModel().threads[0]!;
        const baseEvent = makeLiveToolActivityEvent(2, "tool.completed");
        const event: OrchestrationEvent = {
          ...baseEvent,
          aggregateId: eventThreadId,
          payload: {
            threadId: eventThreadId,
            activity: {
              ...baseEvent.payload.activity,
              summary: "Build complete",
              payload: {
                itemType: "command_execution",
                toolCallId: "call-build",
                status: "completed",
                title: "Build complete",
                data: {
                  item: {
                    command: "build",
                    aggregatedOutput: "Build complete\n" + "x".repeat(9 * 1024 * 1024),
                  },
                },
              },
            },
          },
        };
        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              streamDomainEvents: Stream.concat(Stream.make(event), Stream.never),
            },
            projectionSnapshotQuery: {
              getThreadDetailSnapshot: () =>
                Effect.succeed(Option.some({ snapshotSequence: 1, thread })),
              getThreadShellById: (threadId) =>
                Effect.succeed(
                  Option.some({
                    ...makeDefaultOrchestrationThreadShell(),
                    id: threadId,
                    title: "Build complete",
                  }),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const items =
          subscription === "thread"
            ? yield* Effect.scoped(
                withWsRpcClient(wsUrl, (client) =>
                  client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                    threadId: defaultThreadId,
                    requestCompletionMarker: true,
                  }).pipe(
                    Stream.takeUntil((item) => item.kind === "synchronized"),
                    Stream.runCollect,
                  ),
                ),
              )
            : yield* Effect.scoped(
                withWsRpcClient(wsUrl, (client) =>
                  client[ORCHESTRATION_WS_METHODS.subscribeShell]({
                    requestCompletionMarker: true,
                  }).pipe(
                    Stream.takeUntil((item) => item.kind === "synchronized"),
                    Stream.runCollect,
                  ),
                ),
              );

        assert.equal(items[0]?.kind, "snapshot");
        const update = items[1];
        if (subscription === "thread") {
          assertTrue(update?.kind === "event" && update.event.type === "thread.activity-appended");
          assert.equal(update.event.sequence, 2);
          assert.deepEqual(update.event.payload.activity.payload, {
            itemType: "command_execution",
            toolCallId: "call-build",
            status: "completed",
            title: "Build complete",
            data: { item: { command: "build", aggregatedOutput: "Build complete" } },
          });
        } else {
          assertTrue(update?.kind === "thread-upserted");
          assert.equal(update.sequence, 2);
          assert.equal(update.thread.id, eventThreadId);
          assert.equal(update.thread.title, "Build complete");
        }
        assert.deepEqual(items[2], { kind: "synchronized" });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("coalesces buffered live tool updates to the latest state", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publishAll(liveEvents, [
                  makeLiveToolActivityEvent(2),
                  makeLiveToolActivityEvent(3),
                  makeLiveToolActivityEvent(4),
                ]);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "event");
      assert.equal(items[1]?.kind === "event" ? items[1].event.sequence : null, 4);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("flushes more than one tool chunk before the synchronization marker", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publishAll(liveEvents, [
                  ...Array.from({ length: 512 }, (_, index) =>
                    makeLiveToolActivityEvent(index + 2),
                  ),
                  makeLiveToolActivityEvent(514, "tool.updated", {
                    toolCallId: "call-read",
                    title: "Reading server.test.ts",
                    path: "apps/server/src/server.test.ts",
                  }),
                ]);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.take(4), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(
        items.slice(1, 3).map((item) => {
          assert.equal(item?.kind, "event");
          if (item?.kind !== "event" || item.event.type !== "thread.activity-appended") {
            return null;
          }
          return {
            sequence: item.event.sequence,
            summary: item.event.payload.activity.summary,
            payload: item.event.payload.activity.payload,
          };
        }),
        [
          {
            sequence: 513,
            summary: "Editing app.ts",
            payload: {
              itemType: "file_change",
              title: "Editing app.ts",
              data: {
                files: [{ path: "src/app.ts" }],
                toolCallId: "call-edit",
              },
            },
          },
          {
            sequence: 514,
            summary: "Reading server.test.ts",
            payload: {
              itemType: "file_change",
              title: "Reading server.test.ts",
              data: {
                files: [{ path: "apps/server/src/server.test.ts" }],
                toolCallId: "call-read",
              },
            },
          },
        ],
      );
      assert.deepEqual(items[3], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("flushes a tool update before an interleaved message", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const messageEvent = {
        sequence: 3,
        eventId: EventId.make("event-interleaved-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:02.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-interleaved"),
          role: "assistant",
          text: "Still working",
          turnId: TurnId.make("turn-edit"),
          streaming: false,
          createdAt: "2026-01-01T00:00:02.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publishAll(liveEvents, [
                  makeLiveToolActivityEvent(2),
                  messageEvent,
                  makeLiveToolActivityEvent(4, "tool.completed"),
                ]);
                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
          }).pipe(Stream.take(4), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(
        items
          .slice(1)
          .map((item) => (item.kind === "event" ? [item.event.sequence, item.event.type] : null)),
        [
          [2, "thread.activity-appended"],
          [3, "thread.message-sent"],
          [4, "thread.activity-appended"],
        ],
      );
      assert.equal(
        items[3]?.kind === "event" && items[3].event.type === "thread.activity-appended"
          ? items[3].event.payload.activity.kind
          : null,
        "tool.completed",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect(
    "subscribeThread sends a fresh snapshot when its event count exceeds the replay limit",
    () =>
      Effect.gen(function* () {
        let readEventsCalls = 0;
        const thread = makeDefaultOrchestrationReadModel().threads[0]!;

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              latestSequence: Effect.succeed(100_000),
              getThreadReplayStats: () =>
                Effect.succeed({
                  eventCount: 1_001,
                  payloadBytes: 1_000,
                  hasCreateEvent: false,
                }),
              readThreadEvents: () =>
                Stream.sync(() => {
                  readEventsCalls += 1;
                  return {} as OrchestrationEvent;
                }),
            },
            projectionSnapshotQuery: {
              getThreadDetailSnapshot: () =>
                Effect.succeed(Option.some({ snapshotSequence: 100_000, thread })),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const items = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeThread]({
              threadId: defaultThreadId,
              afterSequence: 5,
              requestCompletionMarker: true,
            }).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(items);
        // Never truncate a thread's replay at the event limit.
        assert.equal(first?.kind, "snapshot");
        if (first?.kind === "snapshot") {
          assert.equal(first.snapshot.thread.id, defaultThreadId);
          assert.equal(first.snapshot.snapshotSequence, 100_000);
        }
        assert.equal(second?.kind, "synchronized");
        assert.equal(readEventsCalls, 0);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stops an overflowing thread producer without an ACK and replays the missing events",
    () =>
      Effect.gen(function* () {
        const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        const attached = yield* Deferred.make<void>();
        const detached = yield* Deferred.make<void>();
        const ackHeld = yield* Deferred.make<void>();
        const releaseAck = yield* Deferred.make<void>();
        const firstApplied = yield* Deferred.make<void>();
        const replayStarted = yield* Deferred.make<void>();
        const replayCalls: Array<{ afterSequence: number; headSequence: number }> = [];
        let headSequence = 0;
        let snapshotCalls = 0;
        const message = (sequence: number, text: string) =>
          ({
            sequence,
            eventId: EventId.make(`slow-thread-${sequence}`),
            aggregateKind: "thread",
            aggregateId: defaultThreadId,
            occurredAt: "2026-01-01T00:00:01.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId: defaultThreadId,
              messageId: MessageId.make(`slow-message-${sequence}`),
              role: "assistant",
              text,
              turnId: TurnId.make("turn-edit"),
              streaming: false,
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          }) satisfies OrchestrationEvent;
        const events = [
          message(1, "a".repeat(4 * 1024 * 1024)),
          message(2, "b".repeat(4 * 1024 * 1024)),
          makeLiveToolActivityEvent(3, "tool.completed"),
          message(4, "Finished"),
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              latestSequence: Effect.sync(() => headSequence),
              streamDomainEvents: Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(liveEvents);
                  yield* Deferred.succeed(attached, undefined);
                  return Stream.fromSubscription(subscription);
                }),
              ).pipe(Stream.ensuring(Deferred.succeed(detached, undefined))),
              readThreadEvents: ({ fromSequenceExclusive, toSequenceInclusive }) => {
                replayCalls.push({
                  afterSequence: fromSequenceExclusive,
                  headSequence: toSequenceInclusive,
                });
                const range = events.filter(
                  (event) =>
                    event.sequence > fromSequenceExclusive && event.sequence <= toSequenceInclusive,
                );
                return Stream.concat(
                  Stream.fromEffect(Deferred.succeed(replayStarted, undefined)).pipe(Stream.drain),
                  Stream.fromIterable(range),
                );
              },
              getThreadReplayStats: ({ fromSequenceExclusive, toSequenceInclusive }) => {
                const range = events.filter(
                  (event) =>
                    event.sequence > fromSequenceExclusive && event.sequence <= toSequenceInclusive,
                );
                return Effect.succeed({
                  eventCount: range.length,
                  payloadBytes: range.reduce(
                    (bytes, event) => bytes + Buffer.byteLength(jsonRequestBody(event.payload)),
                    0,
                  ),
                  hasCreateEvent: false,
                });
              },
            },
            projectionSnapshotQuery: {
              getThreadDetailSnapshot: () =>
                Effect.sync(() => {
                  snapshotCalls += 1;
                  return Option.none();
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* makeWsRpcClient.pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              let cursor = 0;
              const received: number[] = [];
              const attempt = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId: defaultThreadId,
                afterSequence: cursor,
              }).pipe(
                Stream.tap((item) => {
                  if (item.kind !== "event") return Effect.void;
                  cursor = item.event.sequence;
                  received.push(cursor);
                  return Deferred.succeed(firstApplied, undefined);
                }),
                Stream.runDrain,
                Effect.result,
                Effect.forkScoped,
              );
              yield* Deferred.await(attached);
              yield* Deferred.await(replayStarted);
              headSequence = 1;
              yield* PubSub.publish(liveEvents, events[0]!);
              yield* Deferred.await(ackHeld);
              yield* Deferred.await(firstApplied);
              headSequence = 4;
              yield* PubSub.publishAll(liveEvents, events.slice(1));

              // This must finish while the server is still waiting for the first
              // batch's ACK. A failed output queue alone would leave PubSub live.
              yield* Deferred.await(detached);
              assert.equal(yield* PubSub.size(liveEvents), 0);
              assert.deepEqual(received, [1]);
              yield* Deferred.succeed(releaseAck, undefined);
              const result = yield* Fiber.join(attempt);
              assertTrue(result._tag === "Failure");
              assert.equal(result.failure._tag, "OrchestrationGetSnapshotError");

              const recovered = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId: defaultThreadId,
                afterSequence: cursor,
                requestCompletionMarker: true,
              }).pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runCollect,
              );
              assert.deepEqual(
                recovered.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
                [2, 3, 4, "synchronized"],
              );
              const first = recovered[0];
              assertTrue(first?.kind === "event" && first.event.type === "thread.message-sent");
              assert.equal(first.event.payload.text, events[1]!.payload.text);
              const completed = recovered[1];
              assertTrue(
                completed?.kind === "event" && completed.event.type === "thread.activity-appended",
              );
              assert.equal(completed.event.payload.activity.kind, "tool.completed");
              assert.deepEqual(replayCalls, [
                { afterSequence: 0, headSequence: 0 },
                { afterSequence: 1, headSequence: 4 },
              ]);
              assert.equal(snapshotCalls, 0);
            }),
          ),
          Effect.provide(withFirstWsAckHeld(wsUrl, ackHeld, releaseAck)),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops an overflowing shell producer without an ACK and recovers deleted entries", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const detached = yield* Deferred.make<void>();
      const ackHeld = yield* Deferred.make<void>();
      const releaseAck = yield* Deferred.make<void>();
      let headSequence = 1;
      let snapshotCalls = 0;
      let replayCalls = 0;
      const thread = makeDefaultOrchestrationThreadShell();
      const project = makeDefaultOrchestrationReadModel().projects[0]!;
      const events: OrchestrationEvent[] = Array.from({ length: 1_001 }, (_, index) =>
        makeLiveToolActivityEvent(index + 2, "tool.completed"),
      );
      events.push(
        {
          ...events[0]!,
          sequence: 1_003,
          type: "thread.archived",
          payload: {
            threadId: defaultThreadId,
            archivedAt: "2026-01-01T00:00:02.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        },
        {
          ...events[0]!,
          sequence: 1_004,
          aggregateKind: "project",
          aggregateId: defaultProjectId,
          type: "project.deleted",
          payload: { projectId: defaultProjectId, deletedAt: "2026-01-01T00:00:02.000Z" },
        },
      );
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.sync(() => headSequence),
            streamDomainEvents: Stream.fromPubSub(liveEvents).pipe(
              Stream.ensuring(Deferred.succeed(detached, undefined)),
            ),
            readEvents: () => {
              replayCalls += 1;
              return Stream.empty;
            },
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.sync(() => {
                snapshotCalls += 1;
                return {
                  snapshotSequence: headSequence,
                  projects: headSequence === 1 ? [project] : [],
                  threads: headSequence === 1 ? [thread] : [],
                  updatedAt: "2026-01-01T00:00:02.000Z",
                };
              }),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* makeWsRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const received: OrchestrationShellStreamItem[] = [];
            const attempt = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
              Stream.tap((item) => Effect.sync(() => received.push(item))),
              Stream.runDrain,
              Effect.result,
              Effect.forkScoped,
            );
            yield* Deferred.await(ackHeld);
            headSequence = 1_004;
            yield* PubSub.publishAll(liveEvents, events);
            yield* Deferred.await(detached);
            assert.equal(yield* PubSub.size(liveEvents), 0);
            yield* Deferred.succeed(releaseAck, undefined);
            const result = yield* Fiber.join(attempt);
            assertTrue(result._tag === "Failure");
            assert.equal(result.failure._tag, "OrchestrationGetSnapshotError");
            assert.equal(received.length, 1);
            const initial = received[0];
            assertTrue(initial?.kind === "snapshot");
            assert.equal(initial.snapshot.threads.length, 1);

            const recovered = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              afterSequence: initial.snapshot.snapshotSequence,
              requestCompletionMarker: true,
            }).pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            );
            const snapshot = recovered[0];
            assertTrue(snapshot?.kind === "snapshot");
            assert.equal(snapshot.snapshot.snapshotSequence, 1_004);
            assert.deepEqual(snapshot.snapshot.projects, []);
            assert.deepEqual(snapshot.snapshot.threads, []);
            assert.deepEqual(recovered[1], { kind: "synchronized" });
            assert.equal(snapshotCalls, 2);
            assert.equal(replayCalls, 0);
          }),
        ),
        Effect.provide(withFirstWsAckHeld(wsUrl, ackHeld, releaseAck)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            getThreadReplayStats: () =>
              Effect.die("An invalid cursor must not start a replay query"),
            readThreadEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 5, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 10,
          }).pipe(Stream.runHead),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread replays a small thread range across a large global gap", () =>
    Effect.gen(function* () {
      const event = makeLiveToolActivityEvent(99_999, "tool.completed");
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(100_000),
            getThreadReplayStats: () =>
              Effect.succeed({
                eventCount: 1,
                payloadBytes: Buffer.byteLength(jsonRequestBody(event.payload)),
                hasCreateEvent: false,
              }),
            readThreadEvents: () => Stream.make(event),
            readEvents: () => Stream.die("Thread replay must not read the global log"),
          },
          projectionSnapshotQuery: {
            getEventReplayStats: () => Effect.die("Thread replay must not measure the global log"),
            getThreadDetailSnapshot: () =>
              Effect.die("Unrelated activity must not force a snapshot"),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );
      assert.deepEqual(
        items.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
        [99_999, "synchronized"],
      );
      const first = items[0];
      assertTrue(first?.kind === "event" && first.event.type === "thread.activity-appended");
      assert.equal(first.event.payload.activity.kind, "tool.completed");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread resets cached history when its ID is created again", () =>
    Effect.gen(function* () {
      const thread = {
        ...makeDefaultOrchestrationReadModel().threads[0]!,
        title: "Recreated thread",
      };
      let requestedTurnLimit: number | undefined;
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            getThreadReplayStats: () =>
              Effect.succeed({
                eventCount: 3,
                payloadBytes: 1_000,
                hasCreateEvent: true,
              }),
            readThreadEvents: () => Stream.die("A recreated thread must not reuse cached history"),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: (_threadId, options) => {
              requestedTurnLimit = options?.turnLimit;
              return Effect.succeed(Option.some({ snapshotSequence: 5, thread }));
            },
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 2,
            turnLimit: 1,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );
      const first = items[0];
      assertTrue(first?.kind === "snapshot");
      assert.equal(first.snapshot.thread.title, "Recreated thread");
      assert.equal(first.snapshot.snapshotSequence, 5);
      assert.equal(requestedTurnLimit, 1);
      assert.deepEqual(items[1], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const { createBeforeDelete, oversized } of [
    { createBeforeDelete: false, oversized: false },
    { createBeforeDelete: true, oversized: false },
    { createBeforeDelete: true, oversized: true },
  ]) {
    it.effect(
      oversized
        ? "keeps the missing-snapshot error when an absent thread exceeds the replay limit"
        : `synchronizes an absent thread and removes its shell after ${createBeforeDelete ? "creation and deletion" : "deletion"}`,
      () =>
        Effect.gen(function* () {
          const store = yield* OrchestrationEventStore;
          const base = makeLiveToolActivityEvent(0, "tool.completed");
          if (createBeforeDelete) {
            const thread = makeDefaultOrchestrationReadModel().threads[0]!;
            yield* store.append({
              ...base,
              eventId: EventId.make(`create-before-final-delete-${oversized}`),
              type: "thread.created",
              payload: {
                threadId: defaultThreadId,
                projectId: thread.projectId,
                title: thread.title,
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
              },
            });
          }
          if (oversized) {
            yield* Effect.forEach(
              Array.from({ length: 1_000 }, (_, index) => index + 1),
              (sequence) => store.append(makeLiveToolActivityEvent(sequence, "tool.completed")),
              { discard: true },
            );
          }
          const deleted = yield* store.append({
            ...base,
            eventId: EventId.make(`deleted-replay-${createBeforeDelete}-${oversized}`),
            type: "thread.deleted",
            payload: { threadId: defaultThreadId, deletedAt: base.occurredAt },
          });
          yield* buildAppUnderTest({
            layers: {
              orchestrationEngine: {
                latestSequence: Effect.succeed(deleted.sequence),
                getThreadReplayStats: ({ threadId, ...range }) =>
                  store.getAggregateReplayStats({
                    ...range,
                    aggregateKind: "thread",
                    aggregateId: threadId,
                  }),
                readThreadEvents: ({ threadId, ...range }) =>
                  store.readAggregateRange({
                    ...range,
                    aggregateKind: "thread",
                    aggregateId: threadId,
                  }),
                readEvents: store.readFromSequence,
              },
              projectionSnapshotQuery: {
                getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
              },
            },
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const threadResult = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                  threadId: defaultThreadId,
                  afterSequence: 0,
                  requestCompletionMarker: true,
                }).pipe(
                  Stream.takeUntil((item) => item.kind === "synchronized"),
                  Stream.runCollect,
                  Effect.result,
                );
                if (oversized) {
                  assertTrue(threadResult._tag === "Failure");
                  assert.equal(threadResult.failure._tag, "OrchestrationGetSnapshotError");
                  assert.equal(
                    threadResult.failure.message,
                    `Thread ${defaultThreadId} was not found`,
                  );
                  return;
                }
                assertTrue(threadResult._tag === "Success");
                assert.deepEqual(threadResult.success, [{ kind: "synchronized" }]);
                const shellItems = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({
                  afterSequence: 0,
                  requestCompletionMarker: true,
                }).pipe(
                  Stream.takeUntil((item) => item.kind === "synchronized"),
                  Stream.runCollect,
                );
                assert.deepEqual(shellItems, [
                  { kind: "thread-removed", sequence: deleted.sequence, threadId: defaultThreadId },
                  { kind: "synchronized" },
                ]);
              }),
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
              NodeHttpServer.layerTest,
            ),
          ),
        ),
    );
  }

  it.effect("subscribeThread bounds catch-up replay to the captured head", () =>
    Effect.gen(function* () {
      let replayHead: number | undefined;
      let headSequence = 50;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const now = "2026-01-01T00:00:00.000Z";
      const messageEvent = {
        sequence: 3,
        eventId: EventId.make("event-replay-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-replay"),
          role: "user",
          text: "Replayed message",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.sync(() => headSequence),
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            getThreadReplayStats: () =>
              Effect.sync(() => {
                headSequence = 100;
                return { eventCount: 1, payloadBytes: 100, hasCreateEvent: false };
              }),
            readThreadEvents: ({ toSequenceInclusive }) => {
              replayHead = toSequenceInclusive;
              return Stream.fromEffect(
                PubSub.publish(liveEvents, {
                  ...messageEvent,
                  sequence: 51,
                  eventId: EventId.make("event-live-after-head"),
                  payload: {
                    ...messageEvent.payload,
                    messageId: MessageId.make("message-live-after-head"),
                  },
                }),
              ).pipe(Stream.flatMap(() => Stream.make(messageEvent)));
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      assert.deepEqual(
        items.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
        [3, 51, "synchronized"],
      );
      assert.equal(replayHead, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell sends a fresh snapshot instead of replaying a large gap", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const snapshotThreadId = ThreadId.make("thread-from-snapshot");
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            // Head is far ahead of the client's afterSequence (gap > 1000).
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {
                  sequence: 1,
                  eventId: EventId.make("event-should-not-be-read"),
                  aggregateKind: "thread",
                  aggregateId: snapshotThreadId,
                  occurredAt: now,
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  type: "thread.created",
                  payload: {} as never,
                } satisfies OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 100_000,
                projects: [],
                threads: [makeDefaultOrchestrationThreadShell({ id: snapshotThreadId })],
                updatedAt: now,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      // Large gap => fresh snapshot, and the unbounded replay is never started.
      assert.equal(first?.kind, "snapshot");
      if (first?.kind === "snapshot") {
        assert.equal(first.snapshot.threads[0]?.id, snapshotThreadId);
      }
      assert.equal(second?.kind, "synchronized");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscriptions snapshot instead of decoding an oversized replay range", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      let replayStatsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const shell = makeDefaultOrchestrationThreadShell({ id: thread.id });

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            getThreadReplayStats: () =>
              Effect.sync(() => {
                replayStatsCalls += 1;
                return {
                  eventCount: 5,
                  payloadBytes: 8 * 1024 * 1024 + 1,
                  hasCreateEvent: false,
                };
              }),
            readThreadEvents: () => {
              readEventsCalls += 1;
              return Stream.empty;
            },
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getEventReplayStats: () =>
              Effect.sync(() => {
                replayStatsCalls += 1;
                return { eventCount: 5, payloadBytes: 8 * 1024 * 1024 + 1 };
              }),
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 5, thread })),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                projects: [],
                threads: [shell],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const threadItems = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: thread.id,
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );
      const shellItems = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      assert.equal(threadItems[0]?.kind, "snapshot");
      assert.equal(threadItems[1]?.kind, "synchronized");
      assert.equal(shellItems[0]?.kind, "snapshot");
      assert.equal(shellItems[1]?.kind, "synchronized");
      assert.equal(replayStatsCalls, 2);
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;
                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                projects: [],
                threads: [],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 10 }).pipe(
            Stream.runHead,
          ),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalesces a per-thread burst without stalling other threads", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-busy");
      const newThreadId = ThreadId.make("thread-new");
      const now = "2026-01-01T00:00:00.000Z";
      const shellFetches: Array<string> = [];
      let replayLimit: number | undefined;

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make("event-created"),
        aggregateKind: "thread",
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.created",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(50),
            // A burst of message-sent deltas for the busy thread, plus one
            // thread.created for a different thread, all within one batch.
            readEvents: (_afterSequence, limit) => {
              replayLimit = limit;
              return Stream.fromIterable([
                ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
                createdEvent,
              ]);
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }));
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      );

      const collected = Array.from(items);
      const upsertedIds = collected.flatMap((item) =>
        item.kind === "thread-upserted" ? [item.thread.id] : [],
      );
      // Both threads surface, and the busy thread's 20-event burst collapses to
      // a single shell refetch (not 20). The new thread is not stuck behind it.
      assert.include(upsertedIds, busyThreadId);
      assert.include(upsertedIds, newThreadId);
      assert.equal(collected[2]?.kind, "synchronized");
      assert.equal(shellFetches.filter((id) => id === busyThreadId).length, 1);
      assert.equal(replayLimit, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalesces live bursts after the synchronization marker", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-live-busy");
      const newThreadId = ThreadId.make("thread-live-new");
      const now = "2026-01-01T00:00:00.000Z";
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const synchronized = yield* Deferred.make<void>();
      const shellFetches: Array<string> = [];
      const observedLiveThreadIds = new Set<string>();

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-live-${sequence}`),
          aggregateKind: "thread",
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make("event-live-created"),
        aggregateKind: "thread",
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.created",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);
                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }));
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        Effect.gen(function* () {
          const itemsFiber = yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(
              Stream.tap((item) =>
                item.kind === "synchronized"
                  ? Deferred.succeed(synchronized, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Stream.takeUntil((item) => {
                if (item.kind === "thread-upserted") {
                  observedLiveThreadIds.add(item.thread.id);
                }
                return (
                  observedLiveThreadIds.has(busyThreadId) && observedLiveThreadIds.has(newThreadId)
                );
              }),
              Stream.runCollect,
            ),
          ).pipe(Effect.forkScoped);

          yield* Deferred.await(synchronized);
          for (const event of [
            ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
            createdEvent,
          ]) {
            yield* PubSub.publish(liveEvents, event);
          }

          return yield* Fiber.join(itemsFiber);
        }),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "synchronized");
      const liveUpsertedIds = Array.from(items)
        .slice(2)
        .flatMap((item) => (item.kind === "thread-upserted" ? [item.thread.id] : []));
      assert.include(liveUpsertedIds, busyThreadId);
      assert.include(liveUpsertedIds, newThreadId);
      assert.isBelow(shellFetches.filter((id) => id === busyThreadId).length, 20);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("subscribeShell coalescing still emits a removal for a deleted thread", () =>
    Effect.gen(function* () {
      const goneThreadId = ThreadId.make("thread-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeThreadEvent = (
        sequence: number,
        type: "thread.deleted" | "thread.message-sent",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: goneThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload: type === "thread.deleted" ? { threadId: goneThreadId, deletedAt: now } : {},
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            // A thread.deleted followed, within the same coalescing window, by a
            // later refetchable event for the same thread. The later event wins
            // coalescing; its shell refetch returns none (the row is gone), which
            // must still surface a removal rather than be swallowed.
            readEvents: () =>
              Stream.fromIterable([
                makeThreadEvent(1, "thread.deleted"),
                makeThreadEvent(2, "thread.message-sent"),
              ]),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-removed");
      assert.equal(first?.kind === "thread-removed" ? first.threadId : null, goneThreadId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell retries a transient shell projection refetch failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-transient-refetch");
      const now = "2026-01-01T00:00:00.000Z";
      let attempts = 0;

      const event: OrchestrationEvent = {
        sequence: 1,
        eventId: EventId.make("event-transient-refetch"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(1),
            readEvents: () => Stream.make(event),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts === 1
                  ? Effect.fail(
                      new PersistenceSqlError({
                        operation: "test.shell-refetch",
                        detail: "transient failure",
                      }),
                    )
                  : Effect.succeed(
                      Option.some(makeDefaultOrchestrationThreadShell({ id: threadId })),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-upserted");
      assert.equal(first?.kind === "thread-upserted" ? first.thread.id : null, threadId);
      assert.equal(attempts, 2);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalescing still removes a project after a trailing update", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeProjectEvent = (
        sequence: number,
        type: "project.deleted" | "project.meta-updated",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-project-${sequence}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload:
            type === "project.deleted"
              ? { projectId, deletedAt: now }
              : { projectId, title: "Still deleted", updatedAt: now },
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            readEvents: () =>
              Stream.fromIterable([
                makeProjectEvent(1, "project.deleted"),
                makeProjectEvent(2, "project.meta-updated"),
              ]),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () => Effect.succeed(Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "project-removed");
      assert.equal(first?.kind === "project-removed" ? first.projectId : null, projectId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops the provider session and closes thread terminals after archive", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      const sessionStopCommand = dispatchedCommands[1];
      assert.equal(sessionStopCommand?.type, "thread.session.stop");
      if (sessionStopCommand?.type === "thread.session.stop") {
        assert.equal(sessionStopCommand.threadId, threadId);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("checks session status before archiving removes the thread from active lookups", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-precheck");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";
      let archived = false;

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                if (command.type === "thread.archive") {
                  archived = true;
                }
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.sync(() => {
                effects.push(`query:thread-shell:${archived ? "archived" : "active"}`);
                return archived
                  ? Option.none()
                  : Option.some(
                      makeDefaultOrchestrationThreadShell({
                        id: threadId,
                        updatedAt: now,
                        session: {
                          threadId,
                          status: "ready",
                          providerName: "claudeAgent",
                          runtimeMode: "full-access",
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: now,
                        },
                      }),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-precheck"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "query:thread-shell:active",
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives without dispatching session stop when the thread has no session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-no-session");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, session: null })),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-no-session"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "archives without dispatching session stop when the thread session is already stopped",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-archive-stopped-session");
        const effects: string[] = [];
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const now = "2026-01-01T00:00:00.000Z";

        yield* buildAppUnderTest({
          layers: {
            terminalManager: {
              close: (input) =>
                Effect.sync(() => {
                  effects.push(`terminal.close:${input.threadId}`);
                }),
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  effects.push(`dispatch:${command.type}`);
                  return { sequence: dispatchedCommands.length };
                }),
            },
            projectionSnapshotQuery: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some(
                    makeDefaultOrchestrationThreadShell({
                      id: threadId,
                      updatedAt: now,
                      session: {
                        threadId,
                        status: "stopped",
                        providerName: "claudeAgent",
                        runtimeMode: "full-access",
                        activeTurnId: null,
                        lastError: null,
                        updatedAt: now,
                      },
                    }),
                  ),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const dispatchResult = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.archive",
              commandId: CommandId.make("cmd-thread-archive-stopped-session"),
              threadId,
            }),
          ),
        );

        assert.equal(dispatchResult.sequence, 1);
        assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.archive"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("leaves settle cleanup to the event reactor", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-settle");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.settle",
            commandId: CommandId.make("cmd-thread-settle"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, ["dispatch:thread.settle"]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.settle"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("forwards the friendly blocked-settlement message over websocket rpc", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-settle-blocked");
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            dispatch: () => Effect.fail(new OrchestrationThreadSettleBlockedError({ threadId })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.settle",
            commandId: CommandId.make("cmd-thread-settle-blocked"),
            threadId,
          }),
        ).pipe(Effect.flip),
      );

      assert.equal(error._tag, "OrchestrationDispatchCommandError");
      assert.equal(
        error.message,
        "This thread still needs attention. Resolve or interrupt it first, then try again.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-failure");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.fail(
                  new PersistenceSqlError({
                    operation: "OrchestrationEventStore.append:query",
                    detail: "simulated archive stop failure",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-failure"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop defects", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-defect");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.die(new Error("simulated archive stop defect"));
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-defect"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps first-send worktree turns on the server before dispatching turn start",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const bootstrapGitOperations: string[] = [];
        const refreshStatus = vi.fn((_: string) =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: "t2code/bootstrap-refName",
            hasWorkingTreeChanges: false,
            workingTree: {
              files: [],
              insertions: 0,
              deletions: 0,
            },
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          }),
        );
        const remoteExists = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteExists"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("remote-exists");
              return true;
            }),
        );
        const fetchRemote = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("fetch");
            }),
        );
        const remoteBranchExists = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("remote-branch-exists");
              return true;
            }),
        );
        const fetchedOriginCommit = "0123456789abcdef0123456789abcdef01234567";
        const resolveRemoteTrackingCommit = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("resolve-remote-commit");
              return {
                commitSha: fetchedOriginCommit,
                remoteRefName: "origin/main",
              };
            }),
        );
        const createWorktree = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
            Effect.sync(() => {
              bootstrapGitOperations.push("create-worktree");
              return {
                worktree: {
                  refName: "t2code/bootstrap-refName",
                  path: "/tmp/bootstrap-worktree",
                },
              };
            }),
        );
        const runForThread = vi.fn(
          (
            _: Parameters<
              ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
            >[0],
          ) =>
            Effect.succeed({
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "npm install",
              terminalId: "setup-setup",
              cwd: "/tmp/bootstrap-worktree",
              async: true,
            }),
        );

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(true),
            },
            gitVcsDriver: {
              execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
              remoteExists,
              fetchRemote,
              remoteBranchExists,
              resolveRemoteTrackingCommit,
              createWorktree,
            },
            vcsStatusBroadcaster: {
              refreshStatus,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        });

        const createdAt = "2026-01-01T00:00:00.000Z";
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start"),
              threadId: ThreadId.make("thread-bootstrap"),
              message: {
                messageId: MessageId.make("msg-bootstrap"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t2code/bootstrap-refName",
                  startFromOrigin: true,
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 8);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          [
            "thread.create",
            "thread.message.user.append",
            "thread.activity.append",
            "thread.session.set",
            "thread.meta.update",
            "thread.activity.append",
            "thread.activity.append",
            "thread.turn.start",
            "thread.activity.append",
          ],
        );
        // The checkout can take minutes, so the thread reads as working from
        // the moment setup starts rather than only once the turn is dispatched.
        const preparingCommand = dispatchedCommands[3];
        assertTrue(preparingCommand?.type === "thread.session.set");
        if (preparingCommand?.type === "thread.session.set") {
          assert.equal(preparingCommand.session.status, "starting");
          assert.equal(preparingCommand.session.activeTurnId, null);
          assert.equal(
            preparingCommand.session.providerInstanceId,
            defaultModelSelection.instanceId,
          );
        }
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: fetchedOriginCommit,
          newRefName: "t2code/bootstrap-refName",
          baseRefName: "main",
          path: null,
        });
        assert.deepEqual(fetchRemote.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
          refName: "main",
        });
        assert.deepEqual(remoteBranchExists.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
          refName: "main",
        });
        assert.deepEqual(resolveRemoteTrackingCommit.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          refName: "main",
          fallbackRemoteName: "origin",
        });
        assert.deepEqual(bootstrapGitOperations, [
          "remote-exists",
          "fetch",
          "remote-branch-exists",
          "resolve-remote-commit",
          "create-worktree",
        ]);
        const runForThreadInput = runForThread.mock.calls[0]?.[0];
        assert.deepEqual(
          runForThreadInput && {
            threadId: runForThreadInput.threadId,
            projectId: runForThreadInput.projectId,
            projectCwd: runForThreadInput.projectCwd,
            worktreePath: runForThreadInput.worktreePath,
          },
          {
            threadId: ThreadId.make("thread-bootstrap"),
            projectId: defaultProjectId,
            projectCwd: "/tmp/project",
            worktreePath: "/tmp/bootstrap-worktree",
          },
        );
        // Worktree bootstraps observe script completion so the setup card can show the exit code.
        assert.isDefined(runForThreadInput?.observeCompletion);
        assert.deepEqual(refreshStatus.mock.calls[0]?.[0], "/tmp/bootstrap-worktree");

        const setupActivities = dispatchedCommands.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
            command.type === "thread.activity.append",
        );
        assert.deepEqual(
          setupActivities.map((command) => command.activity.kind),
          ["worktree-setup", "setup-script.requested", "setup-script.started", "worktree-setup"],
        );
        // The setup record is upserted under one id: running once the thread
        // exists, settled at the end, so a late client renders the outcome
        // without the in-memory tracker.
        const runningActivity = setupActivities[0]?.activity;
        const settledActivity = setupActivities.at(-1)?.activity;
        assert.equal(runningActivity?.id, settledActivity?.id);
        assert.equal(settledActivity?.tone, "info");
        assertTrue(Schema.is(WorktreeSetupSnapshot)(runningActivity?.payload));
        if (Schema.is(WorktreeSetupSnapshot)(runningActivity?.payload)) {
          assert.equal(runningActivity.payload.phase, "running");
        }
        assertTrue(Schema.is(WorktreeSetupSnapshot)(settledActivity?.payload));
        if (Schema.is(WorktreeSetupSnapshot)(settledActivity?.payload)) {
          assert.equal(settledActivity.payload.phase, "done");
          assert.equal(settledActivity.payload.threadId, ThreadId.make("thread-bootstrap"));
        }
        const finalCommand = dispatchedCommands[7];
        assertTrue(finalCommand?.type === "thread.turn.start");
        if (finalCommand?.type === "thread.turn.start") {
          assert.equal(finalCommand.bootstrap, undefined);
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    { caseName: "the origin remote is missing", hasOrigin: false },
    { caseName: "the base branch exists only locally", hasOrigin: true },
  ])("falls back to the local base branch when $caseName", ({ hasOrigin }) =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const remoteExists = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteExists"]>[0]) =>
          Effect.succeed(hasOrigin),
      );
      const fetchRemote = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemote"]>[0]) => Effect.void,
      );
      const resolveRemoteTrackingCommit = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"]>[0]) =>
          Effect.succeed({
            commitSha: "0123456789abcdef0123456789abcdef01234567",
            remoteRefName: "origin/main",
          }),
      );
      const remoteBranchExists = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["remoteBranchExists"]>[0]) =>
          Effect.succeed(false),
      );
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "t2code/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            remoteExists,
            fetchRemote,
            remoteBranchExists,
            resolveRemoteTrackingCommit,
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-no-origin"),
            threadId: ThreadId.make("thread-bootstrap-no-origin"),
            message: {
              messageId: MessageId.make("msg-bootstrap-no-origin"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t2code/bootstrap-refName",
                startFromOrigin: true,
              },
            },
            createdAt,
          }),
        ),
      );

      assert.deepEqual(remoteExists.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        remoteName: "origin",
      });
      assert.equal(fetchRemote.mock.calls.length, hasOrigin ? 1 : 0);
      assert.equal(remoteBranchExists.mock.calls.length, hasOrigin ? 1 : 0);
      if (hasOrigin) {
        assert.deepEqual(remoteBranchExists.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          remoteName: "origin",
          refName: "main",
        });
      }
      assert.equal(resolveRemoteTrackingCommit.mock.calls.length, 0);
      assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        refName: "main",
        newRefName: "t2code/bootstrap-refName",
        baseRefName: "main",
        path: null,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    { caseName: "a non-repository", isRepository: false, failFetch: false },
    { caseName: "a base without a commit", isRepository: true, failFetch: false },
    { caseName: "a fetch failure", isRepository: true, failFetch: true },
  ])(
    "rejects required worktree bootstrap before creating a thread for $caseName",
    ({ isRepository, failFetch }) =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const createWorktree = vi.fn(
          (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
            Effect.die(new Error("createWorktree must not run before a valid base is found")),
        );

        yield* buildAppUnderTest({
          layers: {
            vcsDriver: {
              isInsideWorkTree: () => Effect.succeed(isRepository),
            },
            gitVcsDriver: {
              execute: () =>
                Effect.succeed({
                  ...SUCCESSFUL_GIT_EXECUTION,
                  exitCode: ChildProcessSpawner.ExitCode(128),
                  stderr: "fatal: Needed a single revision",
                }),
              remoteExists: () => Effect.succeed(true),
              fetchRemote: () => Effect.die(new Error("fetch failed before thread creation")),
              createWorktree,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
          },
        });

        const createdAt = "2026-01-01T00:00:00.000Z";
        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-required-worktree"),
              threadId: ThreadId.make("thread-required-worktree"),
              message: {
                messageId: MessageId.make("msg-required-worktree"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  requireWorktree: true,
                  startFromOrigin: failFetch,
                },
              },
              createdAt,
            }),
          ).pipe(Effect.result),
        );

        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
        assert.strictEqual(result.failure.bootstrapThreadDisposition, "not-created");
        assert.include(
          result.failure.message,
          failFetch ? "fetch failed" : "separate worktree requires",
        );
        assert.equal(createWorktree.mock.calls.length, 0);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.activity.append"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("falls back to the project checkout when worktree mode targets a non-repository", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("createWorktree must not run for a non-repository")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-non-repo"),
            threadId: ThreadId.make("thread-bootstrap-non-repo"),
            message: {
              messageId: MessageId.make("msg-bootstrap-non-repo"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t2code/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.equal(createWorktree.mock.calls.length, 0);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.message.user.append",
          "thread.activity.append",
          "thread.turn.start",
          "thread.activity.append",
        ],
      );
      const finalCommand = dispatchedCommands[3];
      assertTrue(finalCommand?.type === "thread.turn.start");
      if (finalCommand?.type === "thread.turn.start") {
        assert.equal(finalCommand.bootstrap, undefined);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("falls back to the project checkout when the worktree base has no commit", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("createWorktree must not run without a base commit")),
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitVcsDriver: {
            execute: () =>
              Effect.succeed({
                ...SUCCESSFUL_GIT_EXECUTION,
                exitCode: ChildProcessSpawner.ExitCode(128),
                stderr: "fatal: Needed a single revision",
              }),
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-unborn-head"),
            threadId: ThreadId.make("thread-bootstrap-unborn-head"),
            message: {
              messageId: MessageId.make("msg-bootstrap-unborn-head"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t2code/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.equal(createWorktree.mock.calls.length, 0);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.message.user.append",
          "thread.activity.append",
          "thread.turn.start",
          "thread.activity.append",
        ],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records setup-script failures without aborting bootstrap turn start", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "t2code/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );
      const runForThread = vi.fn(
        (
          input: Parameters<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
          >[0],
        ) =>
          Effect.fail(
            new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
              threadId: input.threadId,
              worktreePath: input.worktreePath,
              operation: "openTerminal",
              cause: { message: "pty unavailable" },
            }),
          ),
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t2code/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 7);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.message.user.append",
          "thread.activity.append",
          "thread.session.set",
          "thread.meta.update",
          "thread.activity.append",
          "thread.turn.start",
          "thread.activity.append",
        ],
      );
      const setupFailureActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append" && command.activity.kind !== "worktree-setup",
      );
      assert.equal(setupFailureActivity?.activity.kind, "setup-script.failed");
      assert.deepEqual(setupFailureActivity?.activity.payload, {
        detail: "pty unavailable",
        worktreePath: "/tmp/bootstrap-worktree",
      });
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not misattribute setup activity dispatch failures as setup launch failures", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              refName: "t2code/bootstrap-refName",
              path: "/tmp/bootstrap-worktree",
            },
          }),
      );
      const runForThread = vi.fn(
        (
          _: Parameters<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
          >[0],
        ) =>
          Effect.succeed({
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "npm install",
            terminalId: "setup-setup",
            cwd: "/tmp/bootstrap-worktree",
            async: true,
          }),
      );
      let setupActivityAppendAttempt = 0;

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              if (
                command.type === "thread.activity.append" &&
                command.activity.kind.startsWith("setup-script.")
              ) {
                setupActivityAppendAttempt += 1;
                if (setupActivityAppendAttempt === 2) {
                  return Effect.fail(
                    new PersistenceSqlError({
                      operation: "OrchestrationEventStore.append:query",
                      detail: "failed to append setup-script.started activity",
                    }),
                  );
                }
              }

              return Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              });
            },
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-activity-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-activity-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-activity-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t2code/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 7);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.message.user.append",
          "thread.activity.append",
          "thread.session.set",
          "thread.meta.update",
          "thread.activity.append",
          "thread.turn.start",
          "thread.activity.append",
        ],
      );
      const setupActivities = dispatchedCommands.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.deepEqual(
        setupActivities.map((command) => command.activity.kind),
        ["worktree-setup", "setup-script.requested", "worktree-setup"],
      );
      assertTrue(
        setupActivities.every((command) => command.activity.kind !== "setup-script.failed"),
      );
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    {
      caseName: "async setup scripts let the turn start before the script exits",
      async: true,
      cancel: false,
    },
    {
      caseName: "sync setup scripts hold the turn until the script exits",
      async: false,
      cancel: false,
    },
    {
      caseName: "cancelling worktree setup publishes its outcome and cleans up the thread",
      async: false,
      cancel: true,
    },
  ])("$caseName", ({ async, cancel }) =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const scriptExit = yield* Deferred.make<void>();
      const runForThread = vi.fn(
        (
          _: Parameters<
            ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
          >[0],
        ) =>
          Effect.succeed({
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "npm install",
            terminalId: "setup-setup",
            cwd: "/tmp/bootstrap-worktree",
            async,
            completion: Deferred.await(scriptExit).pipe(Effect.as({ exitCode: 0, durationMs: 1 })),
          }),
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree: () =>
              Effect.succeed({
                worktree: {
                  refName: "t2code/bootstrap-refName",
                  path: "/tmp/bootstrap-worktree",
                },
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make(`thread-bootstrap-${async ? "async" : "sync"}-setup`);
      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchFiber = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-bootstrap-${async ? "async" : "sync"}-setup`),
            threadId,
            message: {
              messageId: MessageId.make("msg-bootstrap-setup"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t2code/bootstrap-refName",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      ).pipe(Effect.forkChild);

      const turnStarted = () =>
        dispatchedCommands.some((command) => command.type === "thread.turn.start");
      const snapshotWhere = (predicate: (snapshot: WorktreeSetupSnapshot) => boolean) =>
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeWorktreeSetup]({ threadId }).pipe(
              Stream.filter(
                (snapshot): snapshot is WorktreeSetupSnapshot =>
                  snapshot !== null && predicate(snapshot),
              ),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            ),
          ),
        );
      const stageStatus = (snapshot: WorktreeSetupSnapshot, id: WorktreeSetupStageId) =>
        snapshot.stages.find((stage) => stage.id === id)?.status;

      if (async) {
        // The turn is dispatched while the script is still running.
        const started = yield* snapshotWhere(
          (snapshot) => stageStatus(snapshot, "agent") === "done",
        );
        assertTrue(turnStarted());
        assert.equal(started.phase, "running");
        assert.equal(stageStatus(started, "setup-script"), "running");
        yield* Fiber.join(dispatchFiber);

        yield* Deferred.succeed(scriptExit, undefined);
        const settled = yield* snapshotWhere((snapshot) => snapshot.phase !== "running");
        assert.equal(settled.phase, "done");
        assert.equal(stageStatus(settled, "setup-script"), "done");
        return;
      }

      // The script is running and the turn has not been dispatched yet.
      const running = yield* snapshotWhere(
        (snapshot) => stageStatus(snapshot, "setup-script") === "running",
      );
      assert.equal(stageStatus(running, "agent"), "pending");
      assert.isFalse(turnStarted());

      if (cancel) {
        const cancelled = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.worktreeSetupCancel]({ threadId })),
        );
        assert.isTrue(cancelled.cancelled);
        assertTrue(dispatchedCommands.some((command) => command.type === "thread.delete"));
        const outcome = dispatchedCommands.findLast(
          (command) =>
            command.type === "thread.activity.append" && command.activity.kind === "worktree-setup",
        );
        assertTrue(outcome?.type === "thread.activity.append");
        assert.propertyVal(outcome.activity.payload, "phase", "cancelled");
        const result = yield* Fiber.join(dispatchFiber).pipe(Effect.result);
        assertTrue(result._tag === "Failure");
        assert.propertyVal(result.failure, "message", "Worktree setup cancelled.");
        assert.propertyVal(result.failure, "bootstrapThreadDisposition", "deleted");
        assert.isFalse(turnStarted());
        return;
      }

      // The client that sent the message goes away mid-setup (a reload or a
      // dropped socket). The bootstrap belongs to the server, not the
      // connection: the thread already exists for every client, so it must
      // finish and start the turn regardless.
      yield* Fiber.interrupt(dispatchFiber);
      assert.isFalse(turnStarted());

      yield* Deferred.succeed(scriptExit, undefined);
      yield* snapshotWhere((snapshot) => stageStatus(snapshot, "agent") === "done");
      assertTrue(turnStarted());
      const settled = yield* snapshotWhere((snapshot) => snapshot.phase !== "running");
      assert.equal(settled.phase, "done");
      assert.equal(stageStatus(settled, "setup-script"), "done");
      assert.equal(stageStatus(settled, "agent"), "done");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up created bootstrap threads when worktree creation defects", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("worktree exploded")),
      );

      const config = yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      let pendingAttachmentId: string | undefined;
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const upload = yield* client[WS_METHODS.attachmentsCreateUploadUrl]({
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 6,
            });
            pendingAttachmentId = upload.attachmentId;
            const uploadResponse = yield* HttpClient.post(upload.relativeUrl, {
              body: HttpBody.uint8Array(new Uint8Array([1, 2, 3, 4, 5, 6]), "image/png"),
            });
            assert.equal(uploadResponse.status, 204);

            return yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start-defect"),
              threadId: ThreadId.make("thread-bootstrap-defect"),
              message: {
                messageId: MessageId.make("msg-bootstrap-defect"),
                role: "user",
                text: "hello",
                attachments: [
                  {
                    type: "image",
                    id: upload.attachmentId,
                    name: "screenshot.png",
                    mimeType: "image/png",
                    sizeBytes: 6,
                  },
                ],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t2code/bootstrap-refName",
                },
                runSetupScript: false,
              },
              createdAt,
            });
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "worktree exploded");
      assert.strictEqual(result.failure.bootstrapThreadDisposition, "deleted");
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.message.user.append",
          "thread.activity.append",
          "thread.session.set",
          "thread.activity.append",
          "thread.delete",
        ],
      );
      assert.isDefined(pendingAttachmentId);
      assert.isTrue(
        yield* fileSystem.exists(path.join(config.attachmentsDir, `${pendingAttachmentId}.png`)),
      );
      assert.deepEqual(yield* fileSystem.readDirectory(config.attachmentsDir), [
        `${pendingAttachmentId}.png`,
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("drains deletion cleanup through the re-created thread event", () =>
    Effect.gen(function* () {
      // A draft retry reuses the thread id its failed bootstrap deleted. The
      // deletion reactor stops sessions and closes terminals by that id, so
      // both thread.create paths use the created event as a fence, then drain
      // cleanup before handing the new incarnation to resource-owning work.
      const trace: Array<string> = [];
      const drainRequested = yield* Deferred.make<void>();
      const cleanupDone = yield* Deferred.make<void>();
      yield* buildAppUnderTest({
        layers: {
          threadDeletionReactor: {
            drainThrough: (sequence) =>
              Effect.gen(function* () {
                trace.push(`drain:${sequence}`);
                yield* Deferred.succeed(drainRequested, undefined);
                yield* Deferred.await(cleanupDone);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                trace.push(command.type);
                return { sequence: trace.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const threadId = ThreadId.make("thread-retry-after-delete");
      const wsUrl = yield* getWsServerUrl("/ws");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const directCreate = yield* Effect.forkChild(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.create",
                commandId: CommandId.make("cmd-retry-create"),
                threadId,
                projectId: defaultProjectId,
                title: "Retry",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              }),
            );
            yield* Deferred.await(drainRequested);
            assert.deepEqual(trace, ["thread.create", "drain:1"]);
            yield* Deferred.succeed(cleanupDone, undefined);
            yield* Fiber.join(directCreate);
          }),
        ),
      );
      assert.deepEqual(trace, ["thread.create", "drain:1"]);

      // Cleanup is already released; the bootstrap path must still drain
      // between creating the thread and starting its turn.
      trace.length = 0;
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const bootstrapCreate = yield* Effect.forkChild(
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make("cmd-retry-bootstrap"),
                threadId,
                message: {
                  messageId: MessageId.make("msg-retry-bootstrap"),
                  role: "user",
                  text: "hello",
                  attachments: [],
                },
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                bootstrap: {
                  createThread: {
                    projectId: defaultProjectId,
                    title: "Retry",
                    modelSelection: defaultModelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    createdAt,
                  },
                  runSetupScript: false,
                },
                createdAt,
              }),
            );
            yield* Fiber.join(bootstrapCreate);
          }),
        ),
      );
      assert.deepEqual(trace, [
        "thread.create",
        "drain:1",
        "thread.message.user.append",
        "thread.turn.start",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not report a deleted bootstrap thread when cleanup fails", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn(
        (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
          Effect.die(new Error("worktree exploded")),
      );

      yield* buildAppUnderTest({
        layers: {
          vcsDriver: {
            isInsideWorkTree: () => Effect.succeed(true),
          },
          gitVcsDriver: {
            execute: () => Effect.succeed(SUCCESSFUL_GIT_EXECUTION),
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              if (command.type === "thread.delete") {
                return Effect.fail(
                  new PersistenceSqlError({
                    operation: "OrchestrationEventStore.append:query",
                    detail: "thread cleanup exploded",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = "2026-01-01T00:00:00.000Z";
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-cleanup-defect"),
            threadId: ThreadId.make("thread-bootstrap-cleanup-defect"),
            message: {
              messageId: MessageId.make("msg-bootstrap-cleanup-defect"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t2code/bootstrap-refName",
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "worktree exploded");
      assert.strictEqual(result.failure.bootstrapThreadDisposition, undefined);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        [
          "thread.create",
          "thread.message.user.append",
          "thread.activity.append",
          "thread.session.set",
          "thread.activity.append",
          "thread.delete",
          "thread.session.set",
        ],
      );
      // The surviving thread must not keep its preparing session, or it would
      // read as working forever.
      const failedSession = dispatchedCommands[6];
      assertTrue(failedSession?.type === "thread.session.set");
      if (failedSession?.type === "thread.session.set") {
        assert.equal(failedSession.session.status, "error");
        assert.include(failedSession.session.lastError ?? "", "worktree exploded");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Primary",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
