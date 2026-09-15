import { T2_PROJECT_FILE_NAME, type EnvironmentId, type T2ProjectFile } from "@t2code/contracts";
import { parseT2ProjectFile } from "@t2code/shared/t2ProjectFile";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in `t2.json`; imperative counterpart
 * to `useT2ProjectFileState` for the new-thread path. The query atom caches
 * per (environment, cwd) and optimistic writes overlay it, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files are null.
 */
export async function readT2ProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T2ProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, T2_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    T2_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseT2ProjectFile(data.contents);
}
