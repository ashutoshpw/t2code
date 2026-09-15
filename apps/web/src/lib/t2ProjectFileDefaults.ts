<<<<<<< HEAD:apps/web/src/lib/t3ProjectFileDefaults.ts
import { T3_PROJECT_FILE_NAME, type EnvironmentId, type T3ProjectFile } from "@t2code/contracts";
import { parseT3ProjectFile } from "@t2code/shared/t3ProjectFile";
=======
import { T2_PROJECT_FILE_NAME, type EnvironmentId, type ThreadEnvMode } from "@t2code/contracts";
import { parseT2ProjectFile } from "@t2code/shared/t2ProjectFile";
>>>>>>> 74eaa6cbe (fix(project): migrate checked-in config to t2.json (#7)):apps/web/src/lib/t2ProjectFileDefaults.ts
import { executeAtomQuery } from "@t2code/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

/**
<<<<<<< HEAD:apps/web/src/lib/t3ProjectFileDefaults.ts
 * Read and decode the project's checked-in `t3.json`.
 *
 * Imperative counterpart to `useT3ProjectFileState` for the new-thread path,
 * which resolves defaults at call time rather than render time. The file
 * query atom caches per (environment, cwd), so repeat calls don't re-fetch.
 * Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readT3ProjectFile(
=======
 * Read `defaultThreadEnvMode` from the project's checked-in `t2.json`.
 *
 * Imperative counterpart to `useT2ProjectFileScripts` for the new-thread
 * path, which resolves defaults at call time rather than render time. The
 * file query atom caches per (environment, cwd), so repeat calls don't
 * re-fetch. Optimistic in-app writes overlay the query result, matching what
 * `useProjectFileQuery` renders. Missing, truncated, or invalid files
 * resolve to null.
 */
export async function readT2ProjectFileDefaultThreadEnvMode(
>>>>>>> 74eaa6cbe (fix(project): migrate checked-in config to t2.json (#7)):apps/web/src/lib/t2ProjectFileDefaults.ts
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<T3ProjectFile | null> {
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
<<<<<<< HEAD:apps/web/src/lib/t3ProjectFileDefaults.ts
  return parseT3ProjectFile(data.contents);
=======
  return parseT2ProjectFile(data.contents)?.defaultThreadEnvMode ?? null;
>>>>>>> 74eaa6cbe (fix(project): migrate checked-in config to t2.json (#7)):apps/web/src/lib/t2ProjectFileDefaults.ts
}
