/**
 * T2ProjectFileLoader - Effect service that loads the checked-in `t2.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module T2ProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T2_PROJECT_FILE_NAME, type T2ProjectFile } from "@t2code/contracts";
import { T2ProjectFileFromJson } from "@t2code/shared/t2ProjectFile";

const decodeT2ProjectFileJson = Schema.decodeEffect(T2ProjectFileFromJson);

export class T2ProjectFileLoadError extends Schema.TaggedError<T2ProjectFileLoadError>()(
  "T2ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${T2_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for t2.json project file loading. */
export class T2ProjectFileLoader extends Context.Service<
  T2ProjectFileLoader,
  {
    /**
     * Load and decode `t2.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T2ProjectFile>>;
  }
>()("@t2code/cli/project/T2ProjectFileLoader") {}

const logT2ProjectFileLoadError = (error: T2ProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: T2ProjectFileLoader["Service"]["load"] = Effect.fn("T2ProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, T2_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logT2ProjectFileLoadError(
                  new T2ProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<T2ProjectFile>();
      }
      return yield* decodeT2ProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logT2ProjectFileLoadError(
              new T2ProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<T2ProjectFile>())),
        }),
      );
    },
  );

  return T2ProjectFileLoader.of({ load });
});

export const layer = Layer.effect(T2ProjectFileLoader, make);
