/**
 * Health and model discovery for the fx CLI.
 *
 * fx keeps authentication and provider selection in its own user profile. The
 * T2 server therefore probes the CLI's read-only JSON commands instead of
 * trying to reproduce fx's credential logic or opening an ACP session during
 * health checks.
 *
 * @module FxProvider
 */
import type {
  FxSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t2code/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t2code/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const FX_PRESENTATION = {
  displayName: "FX",
  badgeLabel: "Early Access",
  supportsTextGeneration: false,
  // FX has ask/code permission modes but no T2 plan mode. Hiding the plan
  // toggle avoids presenting a plan workflow that the provider cannot honor.
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [],
};

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const STATUS_PROBE_TIMEOUT_MS = 10_000;
const MODELS_PROBE_TIMEOUT_MS = 15_000;

export interface FxStatusOutput {
  readonly model: string | undefined;
  readonly auth: ServerProviderAuth;
  readonly message: string | undefined;
  readonly permissionMode: string | undefined;
  readonly authExpired: boolean;
  readonly authRefreshable: boolean | undefined;
}

export interface FxModelsOutput {
  readonly models: ReadonlyArray<string>;
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function authFromStatus(rawAuth: unknown, authExpired: boolean): ServerProviderAuth {
  const auth = normalizeString(rawAuth)?.toLowerCase();
  if (authExpired) {
    return { status: "unauthenticated" };
  }
  if (!auth) {
    return { status: "unknown" };
  }

  if (/missing|invalid|expired|required|error|failed|unavailable/.test(auth)) {
    return { status: "unauthenticated" };
  }

  return {
    status: "authenticated",
    type: auth,
    label: `fx (${auth.replaceAll("_", " ")})`,
  };
}

/** Parse the stable fields emitted by `fx status --json`. */
export function parseFxStatusOutput(output: string): FxStatusOutput | undefined {
  const value = parseJsonObject(output);
  if (!value || value.kind !== "status") {
    return undefined;
  }
  const authExpired = value.auth_expired === true;
  const auth = authFromStatus(value.auth, authExpired);
  return {
    model: normalizeString(value.model),
    auth,
    message: normalizeString(value.auth_help),
    permissionMode: normalizeString(value.permission_mode),
    authExpired,
    authRefreshable:
      typeof value.auth_refreshable === "boolean" ? value.auth_refreshable : undefined,
  };
}

/** Parse model ids emitted by `fx models --json`. */
export function parseFxModelsOutput(output: string): FxModelsOutput | undefined {
  const value = parseJsonObject(output);
  if (!value || value.kind !== "models" || !Array.isArray(value.ids)) {
    return undefined;
  }
  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of value.ids) {
    const model = normalizeString(item);
    if (model && !seen.has(model)) {
      seen.add(model);
      models.push(model);
    }
  }
  return { models };
}

export function displayNameFromFxModelSlug(slug: string): string {
  const tail = slug.includes("/") ? slug.slice(slug.lastIndexOf("/") + 1) : slug;
  const words = tail.split(/[-_.]+/g).filter(Boolean);
  return words.length > 0
    ? words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ")
    : slug;
}

export function buildFxModels(
  modelIds: ReadonlyArray<string>,
  currentModel: string | undefined,
  customModels: FxSettings["customModels"],
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const builtIns: ServerProviderModel[] = [];
  for (const rawModel of modelIds) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    builtIns.push({
      slug,
      name: displayNameFromFxModelSlug(slug),
      isCustom: false,
      ...(currentModel === slug ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return providerModelsFromSettings(builtIns, customModels, EMPTY_CAPABILITIES);
}

function flattenFxModelOptions(
  option: Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  return option.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value, name: entry.name }]
      : entry.options.map((model) => ({ value: model.value, name: model.name })),
  );
}

/** Build the live FX catalog from ACP's model configuration option. */
export function buildFxModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  customModels: FxSettings["customModels"],
): ReadonlyArray<ServerProviderModel> | undefined {
  const modelOption = configOptions?.find(
    (option) =>
      option.type === "select" &&
      (option.category === "model" || option.id.trim().toLowerCase() === "model"),
  );
  if (!modelOption || modelOption.type !== "select") {
    return undefined;
  }
  const currentModel = normalizeString(modelOption.currentValue);
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const option of flattenFxModelOptions(modelOption)) {
    const slug = normalizeString(option.value);
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: normalizeString(option.name) ?? displayNameFromFxModelSlug(slug),
      isCustom: false,
      ...(currentModel === slug ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return providerModelsFromSettings(models, customModels, EMPTY_CAPABILITIES);
}

/** Build the live FX catalog from ACP's optional session model state. */
export function buildFxModelsFromSessionSetup(
  setup: Pick<
    EffectAcpSchema.NewSessionResponse | EffectAcpSchema.LoadSessionResponse,
    "configOptions" | "models"
  >,
  customModels: FxSettings["customModels"],
): ReadonlyArray<ServerProviderModel> | undefined {
  const fromConfig = buildFxModelsFromConfigOptions(setup.configOptions, customModels);
  if (fromConfig !== undefined) {
    return fromConfig;
  }
  if (!setup.models) {
    return undefined;
  }
  return buildFxModels(
    setup.models.availableModels.map((model) => model.modelId),
    setup.models.currentModelId,
    customModels,
  );
}

/** Translate ACP command metadata into the provider snapshot contract. */
export function buildFxSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = normalizeString(command.name);
    if (!name || seen.has(name)) {
      return [];
    }
    seen.add(name);
    const description = normalizeString(command.description);
    const hint = normalizeString(command.input?.hint);
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

/**
 * Health probes do not expose ACP command metadata. Preserve metadata learned
 * from a live session while still allowing an explicit auth/error result to
 * clear stale account state.
 */
export function mergeFxProbeMetadata(
  previous: ServerProviderDraft,
  next: ServerProviderDraft,
): ServerProviderDraft {
  if (!next.enabled || next.status === "error" || next.auth.status === "unauthenticated") {
    return next;
  }
  return {
    ...next,
    models: next.models.length > 0 ? next.models : previous.models,
    slashCommands: previous.slashCommands,
    ...(previous.workspaceSnapshots ? { workspaceSnapshots: previous.workspaceSnapshots } : {}),
  };
}

function runFxCliCommand(
  fxSettings: FxSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  return Effect.gen(function* () {
    const command = fxSettings.binaryPath || "fx";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });
}

function probeResult<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
): Effect.Effect<Result.Result<Option.Option<A>, E>, never, R> {
  return effect.pipe(Effect.timeoutOption(timeoutMs), Effect.result);
}

function buildFallbackModels(settings: FxSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
}

export function buildInitialFxProviderSnapshot(
  fxSettings: FxSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = buildFallbackModels(fxSettings);
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: fxSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: fxSettings.enabled,
        version: null,
        status: fxSettings.enabled ? "warning" : "warning",
        auth: { status: "unknown" },
        message: fxSettings.enabled
          ? "Checking fx CLI availability..."
          : "fx is disabled in T2 Code settings.",
      },
    });
  });
}

function statusMessage(status: FxStatusOutput | undefined): string | undefined {
  if (status?.auth.status === "unauthenticated") {
    return (
      status.message ??
      "fx is not authenticated. Run `fx login`, `fx login codex`, `fx login grok`, or `fx setup`."
    );
  }
  return status?.message;
}

export const checkFxProviderStatus = Effect.fn("checkFxProviderStatus")(function* (
  fxSettings: FxSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = buildFallbackModels(fxSettings);

  if (!fxSettings.enabled) {
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "fx is disabled in T2 Code settings.",
      },
    });
  }

  const versionResult = yield* probeResult(
    runFxCliCommand(fxSettings, ["--version"], environment, cwd),
    VERSION_PROBE_TIMEOUT_MS,
  );
  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("fx CLI health check failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "fx CLI (`fx`) is not installed or not on PATH."
          : "Failed to execute the fx CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "fx CLI is installed but timed out while running `fx --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: FX_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "fx CLI is installed but failed to run.",
      },
    });
  }

  const statusResult = yield* probeResult(
    runFxCliCommand(fxSettings, ["status", "--json"], environment, cwd),
    STATUS_PROBE_TIMEOUT_MS,
  );
  const statusOutput =
    Result.isSuccess(statusResult) &&
    Option.isSome(statusResult.success) &&
    statusResult.success.value.code === 0
      ? statusResult.success.value
      : undefined;
  const status = statusOutput
    ? (parseFxStatusOutput(statusOutput.stdout) ?? parseFxStatusOutput(statusOutput.stderr))
    : undefined;

  const modelsResult = yield* probeResult(
    runFxCliCommand(fxSettings, ["models", "--json"], environment, cwd),
    MODELS_PROBE_TIMEOUT_MS,
  );
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value
      : undefined;
  const parsedModels = modelsOutput
    ? (parseFxModelsOutput(modelsOutput.stdout) ?? parseFxModelsOutput(modelsOutput.stderr))
    : undefined;
  const models = buildFxModels(parsedModels?.models ?? [], status?.model, fxSettings.customModels);

  const auth = status?.auth ?? { status: "unknown" as const };
  const statusProbeFailed = statusOutput === undefined || status === undefined;
  const modelsProbeFailed = modelsOutput === undefined || parsedModels === undefined;
  let probeStatus: "ready" | "warning" | "error" = "ready";
  if (auth.status === "unauthenticated") {
    probeStatus = "error";
  } else if (statusProbeFailed || modelsProbeFailed) {
    probeStatus = "warning";
  }
  const message =
    statusMessage(status) ??
    (statusProbeFailed
      ? "fx status could not be read; authentication and model metadata may be stale."
      : modelsProbeFailed
        ? "fx model discovery failed; refresh after checking `fx status` and `fx models`."
        : undefined);

  return buildServerProvider({
    presentation: FX_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    // FX's ACP command list is currently empty; do not advertise TUI-only
    // commands such as `/compact` as if they were supported over ACP.
    probe: {
      installed: true,
      version,
      status: probeStatus,
      auth,
      ...(message ? { message } : {}),
    },
  });
});
