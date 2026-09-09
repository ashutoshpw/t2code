/**
 * FX ACP adapter.
 *
 * FX exposes a small, native ACP surface. The adapter keeps the provider
 * process and ACP session scoped to one T2 thread while translating the
 * protocol's streaming updates and permission requests into the canonical
 * runtime events consumed by all clients.
 *
 * @module FxAdapter
 */

import {
  ApprovalRequestId,
  EventId,
  type FxSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError, selectAcpPermissionOptionId } from "../acp/AcpAdapterSupport.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyFxAcpSessionConfiguration,
  makeFxAcpRuntime,
  resolveFxAcpBaseModelId,
} from "../acp/FxAcpSupport.ts";
import type { FxAdapterShape } from "../Services/FxAdapter.ts";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("fx");
const FX_RESUME_VERSION = 1 as const;

// FX's ACP transport rejects an input frame above 8 MiB. The limit applies to
// the complete JSON-RPC line, so image files need to fit after base64, JSON,
// the session id, and the runtime instructions are included.
export const FX_MAX_ACP_FRAME_BYTES = 8 * 1024 * 1024;

const FX_MAX_REQUEST_ID = Number.MAX_SAFE_INTEGER;

export function encodedFxPromptFrameBytes(
  sessionId: string,
  prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
): number {
  const frame = JSON.stringify({
    jsonrpc: "2.0",
    id: FX_MAX_REQUEST_ID,
    method: "session/prompt",
    params: { sessionId, prompt },
    // effect-acp's JSON-RPC request schema adds this default header array to
    // every outgoing request, so include it in the byte-limit calculation.
    headers: [],
  });
  return Buffer.byteLength(`${frame}\n`, "utf8");
}

function stringifyForDiagnostics(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : encoded;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFxResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== FX_RESUME_VERSION) {
    return undefined;
  }
  if (typeof raw.sessionId !== "string" || raw.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: raw.sessionId.trim() };
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<
    ApprovalRequestId,
    { readonly decision: Deferred.Deferred<ProviderApprovalDecision> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    pendingApprovals.values(),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function permissionOptionsFromAcp(
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): ReadonlyArray<ProviderApprovalOption> {
  return options.flatMap((option) => {
    const label = option.name.trim();
    if (label.length === 0 || option.optionId.trim().length === 0) {
      return [];
    }
    const decision: ProviderApprovalDecision =
      option.kind === "allow_always"
        ? "acceptForSession"
        : option.kind === "allow_once"
          ? "accept"
          : "decline";
    return [{ decision, label }];
  });
}

function selectFxPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  // `acceptAlways` is the canonical T2 decision used by a few older clients;
  // FX's session-scoped ACP option is the closest native representation.
  const normalizedDecision = decision === "acceptAlways" ? "acceptForSession" : decision;
  const selected = selectAcpPermissionOptionId(request, normalizedDecision);
  if (selected !== undefined) {
    return selected;
  }
  if (normalizedDecision === "decline") {
    return request.options.find(
      (option) => option.kind === "reject_always" && option.optionId.trim().length > 0,
    )?.optionId;
  }
  return undefined;
}

function detailForPermission(request: EffectAcpSchema.RequestPermissionRequest): string {
  const parsed = parsePermissionRequest(request);
  return (
    parsed.detail ??
    stringifyForDiagnostics(request)?.slice(0, 2_000) ??
    "FX requested permission to continue."
  );
}

function isEditPermissionKind(kind: string): boolean {
  switch (kind.trim().toLowerCase()) {
    case "edit":
    case "delete":
    case "move":
    case "file-change":
    case "file_change":
      return true;
    default:
      return false;
  }
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface FxPromptState {
  readonly turnId: TurnId;
  readonly epoch: number;
  settled: boolean;
}

interface FxSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly supportsImages: boolean;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Serializes cancel-then-dispatch so steering never races a prompt launch. */
  readonly promptLifecycle: Semaphore.Semaphore;
  readonly promptStates: Map<number, FxPromptState>;
  promptEpoch: number;
  stopped: boolean;
}

export interface FxAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Selections are honored only when the instance id matches this value. */
  readonly instanceId?: ProviderInstanceId;
  /** Test hook for replacing the captured settings before each session. */
  readonly resolveSettings?: Effect.Effect<FxSettings>;
  /** Publishes the ACP session's initial model/config metadata to the provider snapshot. */
  readonly onSessionStarted?: (
    started: AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  /** Publishes workspace-scoped ACP slash commands to the provider snapshot. */
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd: string,
  ) => Effect.Effect<void>;
  /** Publishes live ACP model/config changes to the provider snapshot. */
  readonly onConfigOptionsUpdated?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) => Effect.Effect<void>;
}

export function makeFxAdapter(fxSettings: FxSettings, options?: FxAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("fx");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();
    const ownerScope = yield* Scope.Scope;

    const sessions = new Map<ThreadId, FxSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate FX runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: FxSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${stringifyForDiagnostics(payload) ?? "[unserializable]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<FxSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return ctx && !ctx.stopped
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const finishTurn = (input: {
      readonly ctx: FxSessionContext;
      readonly state: "completed" | "cancelled" | "failed";
      readonly turnId?: TurnId;
      readonly stopReason?: string | null;
      readonly errorMessage?: string;
    }) =>
      Effect.gen(function* () {
        const turnId = input.turnId ?? input.ctx.activeTurnId;
        if (turnId === undefined || input.ctx.activeTurnId !== turnId) {
          return false;
        }

        for (const [epoch, prompt] of input.ctx.promptStates) {
          if (prompt.turnId === turnId) {
            prompt.settled = true;
            input.ctx.promptStates.delete(epoch);
          }
        }
        input.ctx.activeTurnId = undefined;
        input.ctx.lastPlanFingerprint = undefined;
        const { activeTurnId: _activeTurnId, ...readySession } = input.ctx.session;
        input.ctx.session = {
          ...readySession,
          status: "ready",
          updatedAt: yield* nowIso,
        };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.ctx.threadId,
          turnId,
          payload: {
            state: input.state,
            ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
            ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
          },
        });
        return true;
      });

    const settlePromptResult = (
      ctx: FxSessionContext,
      state: FxPromptState,
      prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
      result: EffectAcpSchema.PromptResponse,
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(ctx.threadId);
        if (liveCtx !== ctx || ctx.stopped) {
          return;
        }
        const livePrompt = ctx.promptStates.get(state.epoch);
        if (livePrompt === undefined || livePrompt.settled) {
          return;
        }
        livePrompt.settled = true;
        ctx.promptStates.delete(state.epoch);
        if (ctx.activeTurnId !== state.turnId || ctx.promptEpoch !== state.epoch) {
          return;
        }
        const turnRecord = ctx.turns.find((turn) => turn.id === state.turnId);
        const item = { prompt, result };
        if (turnRecord) {
          turnRecord.items.push(item);
        } else {
          ctx.turns.push({ id: state.turnId, items: [item] });
        }
        yield* finishTurn({
          ctx,
          turnId: state.turnId,
          state: result.stopReason === "cancelled" ? "cancelled" : "completed",
          stopReason: result.stopReason ?? null,
        });
      });

    const settlePromptFailure = (
      ctx: FxSessionContext,
      state: FxPromptState,
      errorMessage: string,
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(ctx.threadId);
        if (liveCtx !== ctx || ctx.stopped) {
          return;
        }
        const livePrompt = ctx.promptStates.get(state.epoch);
        if (livePrompt === undefined || livePrompt.settled) {
          return;
        }
        livePrompt.settled = true;
        ctx.promptStates.delete(state.epoch);
        if (ctx.activeTurnId !== state.turnId || ctx.promptEpoch !== state.epoch) {
          return;
        }
        yield* finishTurn({
          ctx,
          turnId: state.turnId,
          state: "failed",
          errorMessage,
        });
      });

    const stopSessionInternal = (
      ctx: FxSessionContext,
      exit: { readonly exitKind: "graceful" | "error"; readonly reason?: string } = {
        exitKind: "graceful",
      },
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (ctx.stopped) {
            return;
          }
          ctx.stopped = true;
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* finishTurn(
            exit.exitKind === "error"
              ? {
                  ctx,
                  state: "failed",
                  ...(exit.reason !== undefined ? { errorMessage: exit.reason } : {}),
                }
              : {
                  ctx,
                  state: "cancelled",
                  stopReason: "cancelled",
                },
          );
          if (ctx.notificationFiber) {
            yield* Fiber.interrupt(ctx.notificationFiber);
          }
          yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
          if (sessions.get(ctx.threadId) === ctx) {
            sessions.delete(ctx.threadId);
          }
          yield* offerRuntimeEvent({
            type: "session.exited",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            payload: {
              exitKind: exit.exitKind,
              ...(exit.reason ? { reason: exit.reason } : {}),
            },
          });
        }),
      );

    const startSession: FxAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (
            (input.providerInstanceId !== undefined &&
              input.providerInstanceId !== boundInstanceId) ||
            (input.modelSelection !== undefined &&
              input.modelSelection.instanceId !== boundInstanceId)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "The FX provider instance does not match the requested session.",
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const modelSelection = input.modelSelection;
          const initialModelSelection = modelSelection?.model?.trim();
          const initialModel = resolveFxAcpBaseModelId(initialModelSelection);
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: FxSessionContext;

          const resumeSessionId = parseFxResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const effectiveFxSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : fxSettings;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeFxAcpRuntime({
            fxSettings: effectiveFxSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const permissionRequest = parsePermissionRequest(params);
                if (
                  (input.runtimeMode === "auto-accept-edits" &&
                    isEditPermissionKind(permissionRequest.kind)) ||
                  input.runtimeMode === "full-access"
                ) {
                  const optionId =
                    selectFxPermissionOptionId(params, "acceptForSession") ??
                    selectFxPermissionOptionId(params, "accept");
                  if (optionId !== undefined) {
                    return { outcome: { outcome: "selected" as const, optionId } };
                  }
                }

                const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision });
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    approvalOptions: permissionOptionsFromAcp(params.options),
                    detail: detailForPermission(params),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const optionId = selectFxPermissionOptionId(params, resolved);
                return optionId === undefined
                  ? ({ outcome: { outcome: "cancelled" } } as const)
                  : ({ outcome: { outcome: "selected", optionId } } as const);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new EffectAcpErrors.AcpTransportError({
                      detail: "Failed to process FX ACP permission request.",
                      cause,
                    }),
                ),
              ),
            );
            const started = yield* acp.start();
            yield* options?.onSessionStarted?.(started, cwd) ?? Effect.void;
            return started;
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          yield* applyFxAcpSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            ...(initialModelSelection !== undefined ? { model: initialModelSelection } : {}),
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(initialModel ? { model: initialModel } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: FX_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            supportsImages:
              started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
            notificationFiber: undefined,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptLifecycle: yield* Semaphore.make(1),
            promptStates: new Map(),
            promptEpoch: 0,
            stopped: false,
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "AvailableCommandsUpdated":
                    if (ctx.session.cwd) {
                      yield* (
                        options?.onAvailableCommands?.(event.availableCommands, ctx.session.cwd) ??
                          Effect.void
                      );
                    }
                    return;
                  case "ConfigOptionsUpdated":
                    yield* options?.onConfigOptionsUpdated?.(event.configOptions) ?? Effect.void;
                    return;
                  case "ConnectionTerminated":
                    yield* stopSessionInternal(ctx, {
                      exitKind: "error",
                      reason: event.error.message,
                    }).pipe(Effect.forkIn(ownerScope), Effect.asVoid);
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process FX ACP notification.", { cause }),
            ),
            Effect.forkIn(ctx.scope),
          );
          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "FX ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: FxAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        let tracked: { readonly ctx: FxSessionContext; readonly state: FxPromptState } | undefined;
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            return yield* ctx.promptLifecycle.withPermit(
              Effect.gen(function* () {
                if (
                  input.modelSelection !== undefined &&
                  input.modelSelection.instanceId !== boundInstanceId
                ) {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "The selected model belongs to another FX provider instance.",
                  });
                }

                const steeringTurnId = ctx.activeTurnId;
                const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);

                const rawPrompt = input.input?.trim() ?? "";
                const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
                if (rawPrompt.length > 0) {
                  promptParts.push({ type: "text", text: rawPrompt });
                }
                for (const attachment of input.attachments ?? []) {
                  if (attachment.type !== "image") {
                    return yield* new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "sendTurn",
                      issue:
                        "FX ACP supports image attachments only; remove file attachments and retry.",
                    });
                  }
                  if (!ctx.supportsImages) {
                    return yield* new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "sendTurn",
                      issue: "The FX ACP session does not advertise image prompt support.",
                    });
                  }
                  const attachmentPath = resolveAttachmentPath({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachment,
                  });
                  if (!attachmentPath) {
                    return yield* new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: `Invalid attachment id '${attachment.id}'.`,
                    });
                  }
                  const fileInfo = yield* fileSystem.stat(attachmentPath).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider: PROVIDER,
                          method: "session/prompt",
                          detail: `Could not read attachment '${attachment.name}'.`,
                          cause,
                        }),
                    ),
                  );
                  if (fileInfo.type !== "File") {
                    return yield* new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "sendTurn",
                      issue: "FX image attachments must resolve to regular files.",
                    });
                  }
                  const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderAdapterRequestError({
                          provider: PROVIDER,
                          method: "session/prompt",
                          detail: `Could not read attachment '${attachment.name}'.`,
                          cause,
                        }),
                    ),
                  );
                  promptParts.push({
                    type: "image",
                    data: Buffer.from(bytes).toString("base64"),
                    mimeType: attachment.mimeType,
                  });
                }

                if (promptParts.length === 0) {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: "Turn requires non-empty text or image attachments.",
                  });
                }

                const modelSelection = input.modelSelection;
                const requestedModel = modelSelection?.model ?? ctx.session.model;
                const requestedModelSelection = requestedModel?.trim();
                const resolvedModel = resolveFxAcpBaseModelId(requestedModel);
                const runtimeInstructions = buildRuntimeInstructions({
                  harness: "FX",
                  model: resolvedModel,
                });
                const prompt = [
                  ...promptParts,
                  { type: "text" as const, text: runtimeInstructions },
                ];
                const frameBytes = encodedFxPromptFrameBytes(ctx.acpSessionId, prompt);
                if (frameBytes > FX_MAX_ACP_FRAME_BYTES) {
                  return yield* new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "sendTurn",
                    issue: `FX prompt frame is ${frameBytes} bytes; it must be no larger than ${FX_MAX_ACP_FRAME_BYTES} bytes. Reduce the prompt or image attachments.`,
                  });
                }

                // Validate and construct the complete prompt before changing
                // the active turn. An invalid steering request must leave the
                // provider's existing prompt and turn intact.
                const state: FxPromptState = {
                  turnId,
                  epoch: ctx.promptEpoch + 1,
                  settled: false,
                };
                ctx.promptEpoch = state.epoch;
                ctx.promptStates.set(state.epoch, state);
                tracked = { ctx, state };

                if (steeringTurnId !== undefined) {
                  yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
                  yield* ctx.acp.cancel.pipe(
                    Effect.mapError((error) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, "session/cancel", error),
                    ),
                  );
                }
                ctx.activeTurnId = turnId;
                ctx.session = {
                  ...ctx.session,
                  status: steeringTurnId === undefined ? "connecting" : "running",
                  activeTurnId: turnId,
                  updatedAt: yield* nowIso,
                };
                if (steeringTurnId === undefined) {
                  ctx.lastPlanFingerprint = undefined;
                  yield* offerRuntimeEvent({
                    type: "turn.started",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: {},
                  });
                }
                yield* applyFxAcpSessionConfiguration({
                  runtime: ctx.acp,
                  runtimeMode: ctx.session.runtimeMode,
                  ...(input.interactionMode !== undefined
                    ? { interactionMode: input.interactionMode }
                    : {}),
                  ...(requestedModelSelection !== undefined
                    ? { model: requestedModelSelection }
                    : {}),
                  mapError: ({ cause, method }) =>
                    mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
                });
                const hasExplicitModelSelection = modelSelection !== undefined;
                const sessionWithoutModel = (() => {
                  const { model: _model, ...withoutModel } = ctx.session;
                  return withoutModel;
                })();
                ctx.session = {
                  ...(resolvedModel !== undefined
                    ? { ...ctx.session, model: resolvedModel }
                    : hasExplicitModelSelection
                      ? sessionWithoutModel
                      : ctx.session),
                  status: "running",
                  activeTurnId: turnId,
                  updatedAt: yield* nowIso,
                };

                const dispatched = yield* Deferred.make<void>();
                const promptFiber = yield* ctx.acp
                  .prompt({ prompt }, { dispatched })
                  .pipe(Effect.forkIn(ctx.scope));
                yield* Effect.raceFirst(
                  Deferred.await(dispatched),
                  Fiber.await(promptFiber).pipe(Effect.asVoid),
                );
                return { ctx, state, promptParts, promptFiber };
              }),
            );
          }),
        ).pipe(
          Effect.tapError((error) =>
            tracked
              ? withThreadLock(
                  input.threadId,
                  settlePromptFailure(tracked.ctx, tracked.state, error.message),
                )
              : Effect.void,
          ),
        );

        let stateSettled = false;
        let promptFailureMessage = "FX prompt request failed.";
        return yield* Effect.gen(function* () {
          const result = yield* prepared.promptFiber.pipe(
            Fiber.join,
            Effect.mapError((error) => {
              const mapped = mapAcpToAdapterError(
                PROVIDER,
                input.threadId,
                "session/prompt",
                error,
              );
              promptFailureMessage = mapped.message;
              return mapped;
            }),
          );
          yield* prepared.ctx.acp.drainEvents;
          stateSettled = true;
          yield* withThreadLock(
            input.threadId,
            settlePromptResult(prepared.ctx, prepared.state, prepared.promptParts, result),
          );
          const liveCtx = sessions.get(input.threadId);
          return {
            threadId: input.threadId,
            turnId: prepared.state.turnId,
            resumeCursor: liveCtx?.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              stateSettled || tracked === undefined
                ? Effect.void
                : withThreadLock(
                    input.threadId,
                    settlePromptFailure(tracked.ctx, tracked.state, promptFailureMessage),
                  ).pipe(Effect.ignore),
            ),
          ),
        );
      });

    const interruptTurn: FxAdapterShape["interruptTurn"] = (threadId, requestedTurnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* ctx.promptLifecycle.withPermit(
            Effect.gen(function* () {
              const activeTurnId = ctx.activeTurnId;
              if (
                activeTurnId === undefined ||
                (requestedTurnId !== undefined && requestedTurnId !== activeTurnId)
              ) {
                return;
              }

              yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
              // FX accepts a replacement prompt only after the old prompt has
              // fully settled. The runtime's wait-for-prompt cancellation
              // gives us that confirmation, so keep the old turn identity
              // visible until cancel succeeds and then emit one terminal event.
              yield* ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
                Effect.tap(() =>
                  finishTurn({
                    ctx,
                    turnId: activeTurnId,
                    state: "cancelled",
                    stopReason: "cancelled",
                  }).pipe(Effect.asVoid),
                ),
                Effect.tapError((error) =>
                  finishTurn({
                    ctx,
                    turnId: activeTurnId,
                    state: "failed",
                    errorMessage: error.message,
                  }).pipe(Effect.ignore),
                ),
              );
            }),
          );
        }),
      );

    const respondToRequest: FxAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: FxAdapterShape["respondToUserInput"] = (
      threadId,
      _requestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: "FX ACP does not expose structured user-input requests.",
        });
      });

    const readThread: FxAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: FxAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "FX ACP does not support conversation rollback.",
        });
      });

    const stopSession: FxAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: FxAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: FxAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: FxAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit FX session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsConversationRollback: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies FxAdapterShape;
  });
}
