import type { OrchestrationV2RunStatus } from "@t2code/contracts";
import type * as C from "@t2code/contracts/spaces";

const TERMINAL: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

export const isTerminalDispatchRun = (status: OrchestrationV2RunStatus) => TERMINAL.has(status);

export function dispatchStatusOf(status: OrchestrationV2RunStatus): C.SpaceCommentDispatchStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "cancelled";
  }
}
