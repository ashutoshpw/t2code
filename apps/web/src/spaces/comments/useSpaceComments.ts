import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { groupSpaceCommentThreads } from "@t2code/client-runtime/spaces";

import { SpaceCommentsController } from "./commentsController";
import { useSpaceCommentActions } from "./useSpaceCommentActions";
import { useSpaceCommentList } from "./useSpaceCommentList";

/** The comment controller of one mounted editor, fed from the page's open comment threads. */
export function useSpaceComments(environmentId: EnvironmentId, pageId: SpacePageId) {
  const [controller] = useState(() => new SpaceCommentsController(environmentId, pageId));
  const { supported, threads, loaded } = useSpaceCommentList(environmentId, pageId, "open");
  const { writable } = useSpaceCommentActions(environmentId, pageId);
  const enabled = supported && writable;
  // oxlint-disable-next-line t2code/no-unreasoned-state-sync -- Pushes the server's comment list into the editor plugin closure, which lives outside React.
  useEffect(() => {
    controller.setEnabled(enabled);
    if (loaded) controller.setThreads(threads);
  }, [controller, enabled, loaded, threads]);
  return {
    controller,
    enabled: supported,
    writable,
    openCount: groupSpaceCommentThreads(threads).openCount,
  };
}
