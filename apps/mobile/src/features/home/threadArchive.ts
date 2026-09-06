import {
  threadRuntimeCanArchive,
  type ThreadRuntimeSummary,
} from "@t2code/client-runtime/state/models";

export function threadCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return threadRuntimeCanArchive(runtime);
}
