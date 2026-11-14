import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import { resolveProjectSettings } from "@t2code/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t2code/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
import * as Project from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";

/** The model and modes a new thread in the project starts with, as the composer would pick them. */
export const resolveCommentLaunch = Effect.fn("SpaceComments.resolveLaunch")(function* (
  projectId: ProjectId,
): Effect.fn.Return<
  {
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  },
  C.SpaceCommentError,
  Project.ProjectService | ServerSettings.ServerSettingsService | ProviderRegistry.ProviderRegistry
> {
  const failed = (reason: "project_not_found" | "no_default_model") =>
    new C.SpaceCommentError({ reason });
  const project = Option.getOrUndefined(
    yield* (yield* Project.ProjectService)
      .getById(projectId)
      .pipe(Effect.mapError(() => failed("project_not_found"))),
  );
  if (project === undefined) return yield* failed("project_not_found");
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => failed("no_default_model")),
  );
  const defaults = resolveProjectSettings(settings, projectId, project).settings;
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  const modelSelection = resolveNewThreadModelSelection({
    defaultSelection: defaults.defaultModelSelection,
    fallbackSelection: defaults.fallbackModelSelection,
    providers,
    settings: defaults,
    projectId,
    now: DateTime.toEpochMillis(yield* DateTime.now),
  }).selection;
  if (modelSelection === null || modelSelection === undefined)
    return yield* failed("no_default_model");
  const projectMode = yield* resolveRuntimeMode(
    DEFAULT_RUNTIME_MODE,
    defaults.defaultRuntimeMode,
  ).pipe(Effect.orElseSucceed(() => DEFAULT_RUNTIME_MODE));
  const runtimeMode = yield* resolveRuntimeMode(projectMode, undefined, {
    modelSelection,
    supportedRuntimeModes: providers.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    )?.supportedRuntimeModes,
  }).pipe(Effect.orElseSucceed(() => projectMode));
  return { modelSelection, runtimeMode, interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE };
});
