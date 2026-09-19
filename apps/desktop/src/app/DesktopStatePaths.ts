import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t2Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t2Home)) {
    return Option.none();
  }
  const trimmed = t2Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t2Home: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t2Home), () =>
    input.joinPath(input.homeDirectory, ".t2"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t2Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t2Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
