import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCursor, SpaceCommentsListResult, SpacePageId } from "@t2code/contracts/spaces";
import { commentsSupported } from "@t2code/client-runtime/spaces";

import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { spacesEnvironment } from "~/state/spaces";

const NO_THREADS: SpaceCommentsListResult["threads"] = [];

function useSpaceCommentsSupported(environmentId: EnvironmentId) {
  return commentsSupported(
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces,
  );
}

/** One window of a page's comment threads; refreshes when the page's comments change. */
export function useSpaceCommentList(
  environmentId: EnvironmentId,
  pageId: SpacePageId,
  status: "open" | "resolved",
  options?: { readonly cursor?: SpaceCursor | undefined; readonly enabled?: boolean },
) {
  const supported = useSpaceCommentsSupported(environmentId);
  const cursor = options?.cursor;
  const query = useEnvironmentQuery(
    supported && options?.enabled !== false
      ? spacesEnvironment.comments.list({
          environmentId,
          input: { environmentId, pageId, status, ...(cursor === undefined ? {} : { cursor }) },
        })
      : null,
  );
  const data: SpaceCommentsListResult | null = supported ? query.data : null;
  return {
    supported,
    threads: data?.threads ?? NO_THREADS,
    epoch: data?.mutationAdmission.epoch,
    nextCursor: data?.nextCursor ?? null,
    loaded: data !== null,
    error: query.error,
    refresh: query.refresh,
  };
}
