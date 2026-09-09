/**
 * FxDriver — provider driver for Vercel's fx CLI through native ACP.
 *
 * fx credentials and provider selection are owned by the user's fx profile,
 * so this driver deliberately keeps setup manual and does not implement a T2
 * authentication controller.
 */
import { FxSettings, ProviderDriverKind } from "@t2code/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeFxTextGeneration } from "../../textGeneration/FxTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeFxAdapter } from "../Layers/FxAdapter.ts";
import {
  buildFxModelsFromSessionSetup,
  buildFxSlashCommands,
  buildInitialFxProviderSnapshot,
  checkFxProviderStatus,
  mergeFxProbeMetadata,
} from "../Layers/FxProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { AcpSessionRuntimeStartResult } from "../acp/AcpSessionRuntime.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);
const DRIVER_KIND = ProviderDriverKind.make("fx");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type FxDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const FxDriver: ProviderDriver<FxSettings, FxDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "FX",
    // fx uses one user-level profile and active provider selection. Keep the
    // built-in slot single-instance until profile isolation is supported.
    supportsMultipleInstances: false,
  },
  configSchema: FxSettings,
  defaultConfig: (): FxSettings => decodeFxSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies FxSettings;

      // Health probes cannot discover ACP command/config metadata. Keep a
      // driver-local draft so live sessions can publish those updates through
      // the same managed snapshot stream used by regular provider refreshes.
      const initialDraft = yield* buildInitialFxProviderSnapshot(effectiveConfig);
      const metadata = yield* SubscriptionRef.make<ServerProviderDraft>(initialDraft);
      const updateMetadata = (
        update: (draft: ServerProviderDraft) => ServerProviderDraft,
      ): Effect.Effect<void> => SubscriptionRef.update(metadata, update);
      const updateSessionModels = (setup: AcpSessionRuntimeStartResult["sessionSetupResult"]) =>
        Effect.gen(function* () {
          const models = buildFxModelsFromSessionSetup(setup, effectiveConfig.customModels);
          if (models === undefined) {
            return;
          }
          yield* updateMetadata((draft) => ({ ...draft, models }));
        });
      const updateConfigModels = (
        configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      ) =>
        Effect.gen(function* () {
          const models = buildFxModelsFromSessionSetup(
            { configOptions },
            effectiveConfig.customModels,
          );
          if (models === undefined) {
            return;
          }
          yield* updateMetadata((draft) => ({ ...draft, models }));
        });
      const updateSessionCommands = (
        commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
        cwd: string,
      ) =>
        Effect.gen(function* () {
          const slashCommands = buildFxSlashCommands(commands);
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          yield* updateMetadata((draft) => {
            const previousWorkspace = draft.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
            const workspaceSnapshots = [
              ...(draft.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd),
              {
                cwd,
                checkedAt,
                slashCommands,
                skills: previousWorkspace?.skills ?? [],
              },
            ].slice(-16);
            return { ...draft, slashCommands, workspaceSnapshots };
          });
        });

      const checkProvider = checkFxProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((next) =>
          SubscriptionRef.updateAndGet(metadata, (previous) =>
            mergeFxProbeMetadata(previous, next),
          ),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FxSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialFxProviderSnapshot(settings.provider).pipe(
            Effect.tap((draft) => SubscriptionRef.set(metadata, draft)),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ publishSnapshot }) =>
          SubscriptionRef.changes(metadata).pipe(
            Stream.mapEffect((draft) =>
              Effect.succeed(stampIdentity(draft)).pipe(Effect.flatMap(publishSnapshot)),
            ),
            Stream.runDrain,
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build FX snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makeFxAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        onSessionStarted: (started) => updateSessionModels(started.sessionSetupResult),
        onAvailableCommands: updateSessionCommands,
        onConfigOptionsUpdated: updateConfigModels,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeFxTextGeneration(effectiveConfig);
      const snapshotForCwd = (cwd: string) =>
        checkFxProviderStatus(effectiveConfig, processEnv, cwd).pipe(
          Effect.flatMap((next) =>
            SubscriptionRef.get(metadata).pipe(
              Effect.map((previous) => mergeFxProbeMetadata(previous, next)),
            ),
          ),
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to probe FX for '${cwd}'.`,
                cause,
              }),
          ),
        );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
