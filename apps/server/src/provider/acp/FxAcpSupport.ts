import { type FxSettings, type ProviderInteractionMode, type RuntimeMode } from "@t2code/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type FxAcpRuntimeFxSettings = Pick<FxSettings, "binaryPath">;

/**
 * Options needed to launch FX's native ACP transport.
 *
 * FX owns authentication in its CLI and advertises an empty `authMethods`
 * array over ACP. The runtime therefore deliberately skips the optional ACP
 * authenticate request for this adapter.
 */
export interface FxAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fxSettings: FxAcpRuntimeFxSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode: RuntimeMode;
}

export function buildFxAcpSpawnInput(
  fxSettings: FxAcpRuntimeFxSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  const spawnEnvironment =
    runtimeMode === "full-access"
      ? { ...(environment ?? {}), FX_PERMISSION_MODE: "full-access" }
      : environment;
  return {
    command: fxSettings?.binaryPath || "fx",
    // FX's ACP surface accepts only `fx acp [--model|--log-file]`; supervised
    // and automatic-review modes are selected through ACP after startup.
    args: ["acp"],
    cwd,
    ...(spawnEnvironment ? { env: spawnEnvironment } : {}),
  };
}

/** Build an ACP runtime for one FX process/session. */
export const makeFxAcpRuntime = (
  input: FxAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        // FX rejects a second prompt until the previous worker has fully
        // settled. The shared runtime therefore must wait for cancellation
        // confirmation before a steering prompt is dispatched.
        cancelBehavior: "wait-for-prompt",
        spawn: buildFxAcpSpawnInput(
          input.fxSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        // FX advertises authMethods: []. Omitting authMethodId keeps startup
        // within the ACP contract instead of sending a made-up method id.
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/** FX's ACP model selector is a standard config option with this stable id. */
const FX_MODEL_CONFIG_ID = "model" as const;
export const FX_ASK_MODE_ID = "ask" as const;
export const FX_CODE_MODE_ID = "code" as const;

export function resolveFxAcpBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 && trimmed !== "default" ? trimmed : undefined;
}

/**
 * FX exposes `ask` and `code` modes. T2's supervised mode maps to `ask`; all
 * execution modes use `code`. FX does not expose a separate plan mode, so a
 * plan interaction also stays in its read-only `ask` mode.
 */
export function resolveFxAcpModeId(
  runtimeMode: RuntimeMode,
  interactionMode?: ProviderInteractionMode,
): typeof FX_ASK_MODE_ID | typeof FX_CODE_MODE_ID | undefined {
  // FX has no ACP mode that represents full access. The launch environment
  // sets its native yolo/full-access permission mode instead.
  if (runtimeMode === "full-access") {
    return undefined;
  }
  // FX only has a broad automatic `code` mode and an approval-gated `ask`
  // mode. Auto-accept-edits is handled in the adapter's permission callback
  // so commands remain supervised while file mutations are accepted.
  if (
    interactionMode === "plan" ||
    runtimeMode === "approval-required" ||
    runtimeMode === "auto-accept-edits"
  ) {
    return FX_ASK_MODE_ID;
  }
  return FX_CODE_MODE_ID;
}

export interface FxAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly method: "session/set_config_option";
}

export function applyFxAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly model: string | null | undefined;
  readonly mapError: (context: FxAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const model = input.model?.trim();
  if (!model) {
    return Effect.void;
  }
  return input.runtime.setConfigOption(FX_MODEL_CONFIG_ID, model).pipe(
    Effect.mapError((cause) =>
      input.mapError({
        cause,
        method: "session/set_config_option",
      }),
    ),
    Effect.asVoid,
  );
}

export interface FxAcpModeSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly method: "session/set_mode";
}

/** Apply the FX mode only when the agent advertised the requested option. */
function applyFxAcpModeSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getModeState" | "setSessionMode"
  >;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly mapError: (context: FxAcpModeSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const modeState = yield* input.runtime.getModeState;
    if (!modeState) {
      return;
    }
    const modeId = resolveFxAcpModeId(input.runtimeMode, input.interactionMode);
    if (modeId === undefined) {
      return;
    }
    if (!modeState.availableModes.some((mode) => mode.id === modeId)) {
      return;
    }
    if (modeState.currentModeId === modeId) {
      return;
    }
    yield* input.runtime.setSessionMode(modeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
      Effect.asVoid,
    );
  });
}

export interface FxAcpSessionConfigurationErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly method: "session/set_config_option" | "session/set_mode";
}

export function applyFxAcpSessionConfiguration<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setConfigOption" | "getModeState" | "setSessionMode"
  >;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string | null;
  readonly mapError: (context: FxAcpSessionConfigurationErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* applyFxAcpModelSelection({
      runtime: input.runtime,
      model: input.model,
      mapError: input.mapError,
    });
    yield* applyFxAcpModeSelection({
      runtime: input.runtime,
      runtimeMode: input.runtimeMode,
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      mapError: input.mapError,
    });
  });
}
