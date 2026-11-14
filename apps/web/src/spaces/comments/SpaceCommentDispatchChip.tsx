import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t2code/client-runtime/environment";
import { spaceCommentDispatchLabel } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCommentDispatch } from "@t2code/contracts/spaces";

import { Badge } from "~/components/ui/badge";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

const STATUS_VARIANT = {
  queued: "secondary",
  running: "info",
  done: "success",
  failed: "error",
  cancelled: "outline",
} as const;

/** The session a comment was sent to: its live run status, linking to the thread. */
export function SpaceCommentDispatchChip({
  environmentId,
  dispatch,
}: {
  readonly environmentId: EnvironmentId;
  readonly dispatch: SpaceCommentDispatch;
}) {
  const ref = scopeThreadRef(environmentId, dispatch.threadId);
  const title = useThreadShell(ref)?.title ?? "Session";
  return (
    <Badge
      variant={STATUS_VARIANT[dispatch.status]}
      size="lg"
      render={<Link to="/$environmentId/$threadId" params={buildThreadRouteParams(ref)} />}
    >
      <span>{spaceCommentDispatchLabel(dispatch.status)}</span>
      <span className="max-w-40 truncate font-normal">{title}</span>
    </Badge>
  );
}
