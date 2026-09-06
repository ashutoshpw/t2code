import { makeThreadPullRequests } from "@t2code/source-control-core/shared/threadPullRequests";

import { sourceControlClients } from "./sourceControlClients.ts";

export {
  threadPullRequestSearchTerms,
  visibleThreadPullRequests,
} from "@t2code/shared/threadPullRequests";
export {
  pullRequestListLines,
  type PullRequestListLine,
  type ThreadCurrentPullRequest,
  type ThreadPullRequestBadge,
  type ThreadPullRequestChain,
} from "@t2code/source-control-core/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadCurrentPullRequest,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  resolveThreadPullRequestBadge,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlClients);
