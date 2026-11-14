import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t2code/contracts";
import {
  SpaceBlockId,
  SpaceCommentId,
  SpaceCommentThreadId,
  SpacePageId,
  type SpaceCommentThread,
} from "@t2code/contracts/spaces";

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { SpaceEditorAdapter } from "../adapter";
import { SpaceEditor } from "../SpaceEditor";
import { SpaceCommentsController } from "./commentsController";
import { SpaceCommentComposer } from "./SpaceCommentComposer";
import { SpaceCommentDispatchChip } from "./SpaceCommentDispatchChip";
import { SpaceCommentsPanelHost } from "./SpaceCommentsPanel";
import { openSpaceCommentsPanel } from "./spaceCommentsPanelState";

const mocks = vi.hoisted(() => ({
  actions: {} as Record<string, unknown>,
  resolved: [] as unknown[],
}));

vi.mock("./useSpaceCommentActions", () => ({ useSpaceCommentActions: () => mocks.actions }));
vi.mock("./useSpaceCommentList", () => ({
  useSpaceCommentList: (_env: unknown, _page: unknown, status: string) => ({
    supported: true,
    threads: status === "resolved" ? mocks.resolved : [],
    epoch: "epoch",
    nextCursor: null,
    loaded: true,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("~/state/entities", () => ({
  useVisibleThreadShells: () => [
    {
      environmentId: "env",
      id: "thread-1",
      title: "Fix the intro",
      archivedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
      updatedAt: "2026-11-14T00:00:00.000Z",
    },
  ],
  useProjects: () => [],
  useThreadShell: () => ({ title: "Fix the intro" }),
}));

const env = EnvironmentId.make("env");
const pageId = SpacePageId.make("page");
const now = "2026-11-14T00:00:00.000Z";

type Call = (...args: unknown[]) => Promise<{ commentId?: SpaceCommentId }>;

function setup() {
  const saved = { commentId: SpaceCommentId.make("c1") };
  const create = vi.fn<Call>().mockResolvedValue(saved);
  const reopen = vi.fn<Call>().mockResolvedValue({});
  const dispatch = vi.fn<Call>().mockResolvedValue({});
  mocks.actions = {
    writable: true,
    create,
    reply: create,
    edit: create,
    reopen,
    resolve: reopen,
    remove: reopen,
    dispatch,
  };
  mocks.resolved = [];
  return { create, reopen, dispatch };
}

function editorAdapter() {
  let sequence = 0;
  return new SpaceEditorAdapter({
    target: { environmentId: env, pageId },
    window: {
      revision: 0,
      completeParents: [null],
      blocks: [
        {
          id: SpaceBlockId.make("first"),
          parentId: null,
          order: "a",
          type: "paragraph",
          version: 1,
          content: { runs: [{ text: "Hello page", marks: [] }] },
        },
      ],
    },
    maxBlocks: 50,
    maxDepth: 8,
    maxTextLength: 10000,
    maxClipboardBytes: 20000,
    allocateId: () => SpaceBlockId.make(`new-${++sequence}`),
    allocateOrder: ({ before }) => `${before ?? ""}~${++sequence}`,
  });
}

const thread = (
  anchor: SpaceCommentThread["anchor"],
  extra: Partial<SpaceCommentThread> = {},
): SpaceCommentThread => ({
  id: SpaceCommentThreadId.make("thread-a"),
  pageId,
  blockId: SpaceBlockId.make("first"),
  resolvedBlockId: SpaceBlockId.make("first"),
  anchorState: "live",
  anchor,
  status: "open",
  resolvedAt: null,
  createdAt: now,
  revision: 1 as SpaceCommentThread["revision"],
  comments: [
    {
      id: SpaceCommentId.make("c1"),
      author: { kind: "user" },
      body: [{ text: "Nice", marks: [] }],
      createdAt: now,
      editedAt: null,
    },
  ],
  ...extra,
});

async function mountEditor() {
  const controller = new SpaceCommentsController(env, pageId);
  controller.setEnabled(true);
  const screen = await render(<SpaceEditor adapter={editorAdapter()} comments={controller} />);
  return { controller, screen };
}

const press = (target: { element(): Element }) =>
  target.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));

const submitComment = async (text: string) => {
  await userEvent.type(page.getByRole("textbox", { name: "Add a comment" }), text);
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
};

describe("Spaces comments", () => {
  it("comments on selected text and highlights it once the thread arrives", async () => {
    const actions = setup();
    const { controller, screen } = await mountEditor();
    await using _screen = screen;
    await userEvent.dblClick(screen.getByText("Hello page"));
    const quote = window.getSelection()?.toString().trim() ?? "";
    expect(quote.length).toBeGreaterThan(0);
    await userEvent.click(
      screen.getByRole("button", { name: "Comment" }).filter({ hasText: "Comment" }),
    );
    await submitComment("Nice");
    await vi.waitFor(() => expect(actions.create).toHaveBeenCalledTimes(1));
    const [blockId, anchor, body] = actions.create.mock.calls[0]!;
    expect(blockId).toBe("first");
    expect(anchor).toMatchObject({ kind: "range", quote });
    expect(body).toEqual([{ text: "Nice", marks: [] }]);
    await act(() => controller.setThreads([thread(anchor as SpaceCommentThread["anchor"])]));
    await vi.waitFor(() =>
      expect(document.querySelector(".space-comment-range")?.textContent).toBe(quote),
    );
  });

  it("comments on a whole block from its hover button", async () => {
    const actions = setup();
    const { screen } = await mountEditor();
    await using _screen = screen;
    await userEvent.hover(screen.getByText("Hello page"));
    await userEvent.click(page.getByRole("button", { name: "Comment" }));
    await submitComment("About this block");
    await vi.waitFor(() => expect(actions.create).toHaveBeenCalledTimes(1));
    expect(actions.create.mock.calls[0]?.slice(0, 2)).toEqual(["first", { kind: "block" }]);
  });

  it("lists resolved threads in the panel and reopens one", async () => {
    const actions = setup();
    mocks.resolved = [thread({ kind: "block" }, { status: "resolved", resolvedAt: now })];
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <SpaceCommentsPanelHost />
      </AppAtomRegistryProvider>,
    );
    await act(() => openSpaceCommentsPanel({ environmentId: env, pageId }));
    await expect.element(page.getByText("Resolved", { exact: true })).toBeVisible();
    // userEvent never sees a stable box for controls inside the sliding sheet.
    press(page.getByText("Resolved", { exact: true }));
    await expect.element(page.getByText("Nice")).toBeVisible();
    press(page.getByRole("button", { name: "Reopen" }));
    expect(actions.reopen).toHaveBeenCalledWith("thread-a");
  });

  it("sends a new comment to a chosen session and shows its status", async () => {
    const actions = setup();
    const dispatch = {
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project"),
      runId: RunId.make("run"),
      mode: "edit" as const,
      status: "queued" as const,
      updatedAt: now,
    };
    await using screen = await render(
      <SpaceCommentComposer
        environmentId={env}
        placeholder="Add a comment"
        write={(body) => actions.create(body)}
        dispatch={(id, choice) => actions.dispatch(id, choice)}
      />,
    );
    await userEvent.type(screen.getByRole("textbox", { name: "Add a comment" }), "Please fix");
    await userEvent.click(screen.getByRole("button", { name: "Send to session" }));
    await userEvent.click(page.getByText("Ask to edit", { exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Fix the intro" }));
    await userEvent.click(screen.getByRole("button", { name: "Comment and send" }));
    await vi.waitFor(() => expect(actions.dispatch).toHaveBeenCalledTimes(1));
    expect(actions.create).toHaveBeenCalledTimes(1);
    expect(actions.dispatch).toHaveBeenCalledWith("c1", {
      mode: "edit",
      target: { kind: "thread", threadId: "thread-1" },
      title: "Fix the intro",
    });
    await using chip = await render(
      <SpaceCommentDispatchChip environmentId={env} dispatch={dispatch} />,
    );
    await expect.element(chip.getByText("Queued")).toBeVisible();
  });
});
