import {
  T2_PROJECT_FILE_NAME,
  type EnvironmentId,
  type T2ProjectFile,
  type T2ProjectFileScript,
} from "@t2code/contracts";
import { parseT2ProjectFile } from "@t2code/shared/t2ProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<T2ProjectFileScript> = [];

export interface T2ProjectFileState {
  /**
   * - `valid`: t2.json exists and decoded.
   * - `invalid`: t2.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable t2.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: T2ProjectFile | null;
  scripts: ReadonlyArray<T2ProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `t2.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useT2ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): T2ProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", T2_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseT2ProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `t2.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useT2ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T2ProjectFileScript> {
  return useT2ProjectFileState(environmentId, cwd).scripts;
}
