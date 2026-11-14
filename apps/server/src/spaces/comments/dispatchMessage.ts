import type { SpaceCommentDispatchMode } from "@t2code/contracts/spaces";

const EDIT =
  'Change the page as the comment asks, using the Spaces tools. Then reply in the comment thread with t2_spaces_comments (action "reply") saying what you changed. Do not resolve the comment; the user does.';
const MESSAGE = 'Reply in the comment thread with t2_spaces_comments (action "reply").';

export function commentDispatchMessage(input: {
  readonly mode: SpaceCommentDispatchMode;
  readonly pageTitle: string;
  readonly environmentId: string;
  readonly pageId: string;
  readonly blockId: string;
  readonly commentThreadId: string;
  readonly commentId: string;
  readonly text: string;
  readonly quote?: string | undefined;
}) {
  return [
    `A comment on the Spaces page "${input.pageTitle}" was sent to you.`,
    "",
    input.text,
    "",
    input.mode === "edit" ? EDIT : MESSAGE,
    ...(input.quote === undefined ? [] : ["", `Quoted text: "${input.quote}"`]),
    `environmentId: ${input.environmentId} · pageId: ${input.pageId} · blockId: ${input.blockId} · commentThreadId: ${input.commentThreadId} · commentId: ${input.commentId}`,
  ].join("\n");
}
