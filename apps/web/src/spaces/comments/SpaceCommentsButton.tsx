import { MessageSquareIcon } from "lucide-react";
import { groupSpaceCommentThreads } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { openSpaceCommentsPanel } from "./spaceCommentsPanelState";
import { useSpaceCommentList } from "./useSpaceCommentList";

/** Header button with the page's open comment count; hidden where the server has no comments. */
export function SpaceCommentsButton({
  environmentId,
  pageId,
}: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
}) {
  const { supported, threads } = useSpaceCommentList(environmentId, pageId, "open");
  if (!supported) return null;
  const count = groupSpaceCommentThreads(threads).openCount;
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={count === 0 ? "Comments" : `Comments, ${count} open`}
      onClick={() => openSpaceCommentsPanel({ environmentId, pageId })}
    >
      <MessageSquareIcon />
      {count === 0 ? null : count}
    </Button>
  );
}
