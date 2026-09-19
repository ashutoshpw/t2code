import { T2_PROJECT_FILE_NAME, type EnvironmentId, type T2ProjectFile } from "@t2code/contracts";
import { parseT2ProjectFile } from "@t2code/shared/t2ProjectFile";
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
 * Read and decode the project's checked-in `t2.json`.
 *
 * Imperative counterpart to `useT2ProjectFileScripts` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
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
