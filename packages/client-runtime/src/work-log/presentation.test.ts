import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t2code/contracts";
import * as DateTime from "effect/DateTime";
import { T2_MCP_TOOL_NAMES } from "@t2code/shared/t2McpToolPresentation";

import {
  commandDetailRepeatsCommand,
  extractCommandOutputText,
  resolveWorkEntryToolPresentation,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    exitCode: 0,
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(workEntryIndicatesToolSuccess(entry)).toBe(!failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("presents and summarizes every T2 tool using the same structured identity", () => {
    for (const tool of T2_MCP_TOOL_NAMES) {
      const entry: WorkLogPresentationEntry = {
        id: tool,
        createdAt: "2026-09-19T00:00:00.000Z",
        tone: "tool",
        label: "Custom provider title",
        toolData: { server: "t2-code", tool },
        toolLifecycleStatus: "completed",
        itemType: "dynamic_tool",
        toolSource: { key: "t2-code", name: "T2 Code", kind: "integration" },
      };
      const presentation = resolveWorkEntryToolPresentation(entry);
      expect(presentation, tool).not.toBeNull();
      expect(presentation?.displayName, tool).not.toContain(tool);
      const summary = summarizeToolGroup([entry]);
      expect(summary.summary, tool).not.toMatch(/Used (?:1 tool|T2 Code integration)/);
      expect(summary.hasFailure, tool).toBe(false);
      const failed = { ...entry, toolLifecycleStatus: "failed" as const };
      expect(resolveWorkEntryToolPresentation(failed)?.displayName, tool).toMatch(/^Failed to /);
      expect(summarizeToolGroup([failed]).hasFailure, tool).toBe(true);
      expect(summarizeToolGroup([failed]).summary, tool).toMatch(
        /^(?:Tried to |Requested thread creation)/,
      );
    }
  });

  it.each([
    ["t2_project_list", "Listing projects", "Listed projects"],
    ["t2_project_clone", "Cloning a repository", "Cloned a repository"],
    ["t2_project_create", "Registering a project", "Registered a project"],
    ["t2_thread_launch", "Launching a project thread", "Launched a project thread"],
    ["t2_queue_edit", "Editing a queued message", "Edited a queued message"],
    ["t2_pending_request_respond", "Answering pending questions", "Answered pending questions"],
    ["t2_thread_configure", "Setting thread model", "Set thread model"],
    ["t2_thread_fork", "Forking this thread", "Requested a fork of this thread"],
    ["t2_thread_send_attachments", "Sending attachments", "Sent attachments"],
    ["run_scheduled_task_now", "Running a scheduled task", "Requested a run of a scheduled task"],
    ["t2_workflow_stop", "Stopping a workflow", "Requested a stop for a workflow"],
  ])("labels %s through its lifecycle", (tool, running, completed) => {
    expect(resolveWorkEntryToolPresentation({ label: `T2-code.${tool}` })?.displayName).toBe(
      running,
    );
    expect(
      resolveWorkEntryToolPresentation({
        label: `T2-code.${tool}`,
        toolLifecycleStatus: "completed",
      })?.displayName,
    ).toBe(completed);
  });

  it("summarizes workflow stop targets separately from their parent thread", () => {
    const entry = {
      id: "workflow-stop",
      createdAt: "2026-10-07T00:00:00.000Z",
      tone: "tool",
      label: "Custom title",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolData: {
        server: "t2-code",
        tool: "t2_workflow_stop",
        arguments: { threadId: "parent", subagentId: "workflow-1" },
        result: {},
      },
    } satisfies WorkLogPresentationEntry;
    expect(
      summarizeToolGroup([
        entry,
        entry,
        {
          ...entry,
          toolData: {
            ...entry.toolData,
            arguments: { threadId: "parent", subagentId: "workflow-2" },
          },
        },
        {
          ...entry,
          toolData: {
            ...entry.toolData,
            tool: "t2_thread_interrupt",
            arguments: { threadId: "parent" },
          },
        },
      ]),
    ).toEqual({
      summary: "Requested stops for 2 workflows and requested interrupts for 1 thread",
      hasFailure: false,
    });
  });

  it("summarizes project tools from MCP arguments and results without claiming failed effects", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "Custom title",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolData: {
        server: "t2-code",
        tool: "t2_project_clone",
        arguments: { url: "https://github.com/acme/repo" },
        result: { cwd: "/tmp/repo" },
      },
    };
    const list = { ...entry, toolData: { server: "t2-code", tool: "t2_project_list" } };
    expect(summarizeToolGroup([list, entry])).toEqual({
      summary: "Listed projects 1 time and cloned 1 repository",
      hasFailure: false,
    });
    const failed = {
      ...entry,
      toolData: { toolName: "T2-code.t2_project_clone", rawOutput: { isError: true } },
    };
    expect(summarizeToolGroup([entry, failed])).toEqual({
      summary: "Cloned 1 repository",
      hasFailure: true,
    });
  });

  it("does not summarize a foreign structured identity as T2 work", () => {
    const entry: WorkLogPresentationEntry = {
      id: "foreign",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "t2_project_clone",
      toolLifecycleStatus: "completed",
      toolData: { server: "another-server", tool: "t2_project_clone" },
    };
    expect(summarizeToolGroup([entry]).summary).toBe("Used 1 tool");
  });

  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T2-code.t2_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
    const childFailure = {
      ...entry,
      label: "T2-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
    expect(workEntryIndicatesToolSuccess(childFailure)).toBe(true);
  });
  it.each([
    "mcp__t2-code__preview_click",
    "mcp__t2_code__preview_click",
    "mcp__t2code__preview_click",
    "t2-code.preview_click",
    "t2-code · preview_click completed",
    "t2_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t2-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "t2-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it.each([
    ["preview_type", "Typing in the preview browser", "Typed in the preview browser"],
    [
      "preview_set_appearance",
      "Setting preview browser appearance",
      "Set preview browser appearance",
    ],
    [
      "preview_snapshot",
      "Taking a snapshot of the preview page",
      "Took a snapshot of the preview page",
    ],
    [
      "preview_recording_stop",
      "Stopping recording the preview browser",
      "Stopped recording the preview browser",
    ],
    ["t2_thread_read", "Reading a T2 thread", "Read a T2 thread"],
    ["t2_thread_send", "Sending to a T2 thread", "Sent to a T2 thread"],
    [
      "t2_worktree_handoff",
      "Handing off thread to a git worktree",
      "Handed off thread to a git worktree",
    ],
  ])("preserves verb forms and the rest of %s's label", (tool, running, completed) => {
    const entry = { label: `t2-code.${tool}` };
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "inProgress" })
        ?.displayName,
    ).toBe(running);
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" })?.displayName,
    ).toBe(completed);
  });

  it("keeps T2 branding for non-browser tools and falls back to the original tool label", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "mcp__t2_code__task_status",
        toolTitle: "Check the child task",
      }),
    ).toEqual({ displayName: "Getting delegated task status", icon: "t2-code" });
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t2-code.unknown_tool",
      "t2-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("command work-log details", () => {
  it("extracts Claude result blocks and projected output", () => {
    expect(
      extractCommandOutputText({
        result: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      }),
    ).toBe("first\nsecond");
    expect(extractCommandOutputText({ rawOutput: { content: "projected summary" } })).toBe(
      "projected summary",
    );
  });

  it("treats an ingestion-truncated echo of a long command as a repeat", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const truncated = `Bash: ${command}`.slice(0, 177) + "...";
    expect(
      commandDetailRepeatsCommand({
        detail: truncated,
        command,
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "Bash: printf hello...",
        command: "printf goodbye",
        rawCommand: null,
        toolName: "Bash",
        data: { toolName: "Bash", command: "printf goodbye" },
      }),
    ).toBe(false);
  });

  it("treats ACP command echoes as synthetic even without a tool kind", () => {
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { toolCallId: "tool-1", command: "pnpm test" },
      }),
    ).toBe(true);
    expect(
      commandDetailRepeatsCommand({
        detail: "pnpm test",
        command: "pnpm test",
        rawCommand: null,
        toolName: undefined,
        data: { command: "pnpm test" },
      }),
    ).toBe(false);
  });
});

describe("workEntryViewedImagePath", () => {
  const entry = {
    id: "entry-1",
    createdAt: "2026-01-01T00:00:00Z",
    label: "Read",
    tone: "tool",
  } as const;

  it("returns a single image path from supported read entries", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: " assets/a.png " }),
    ).toBe("assets/a.png");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool",
        toolTitle: "Read file",
        detail: "C:\\workspace\\a.webp",
      }),
    ).toBe("C:\\workspace\\a.webp");
    expect(
      workEntryViewedImagePath({
        ...entry,
        itemType: "dynamic_tool",
        detail: 'Read: {"file_path":"truncated..."}',
        viewedImagePath: " /workspace/reference image.webp ",
      }),
    ).toBe("/workspace/reference image.webp");
  });

  it("rejects non-image, multi-line, and non-read details", () => {
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: "a.txt" }),
    ).toBeNull();
    expect(
      workEntryViewedImagePath({ ...entry, requestKind: "file-read", detail: "a.png\nb.png" }),
    ).toBeNull();
    expect(workEntryViewedImagePath({ ...entry, detail: "a.png" })).toBeNull();
  });
});

describe("toolGroupAction", () => {
  it("groups legacy Claude image reads with other reads", () => {
    expect(
      toolGroupAction({
        id: "legacy-read",
        createdAt: "2026-09-01T00:00:00Z",
        label: "Tool call",
        tone: "tool",
        itemType: "dynamic_tool",
        viewedImagePath: "/workspace/reference.png",
      }),
    ).toBe("read");
  });

  it("groups Claude Read and Grep from toolName, not file contents", () => {
    expect(
      toolGroupAction({
        id: "read",
        createdAt: "2026-09-01T00:00:00Z",
        label: "Read",
        tone: "tool",
        itemType: "dynamic_tool",
        toolTitle: "Read",
        toolData: { input: { file_path: "src/env.ts" } },
        structuredPayload: {
          type: "dynamic_tool",
          toolName: "Read",
          input: { file_path: "src/env.ts" },
        } as NonNullable<WorkLogPresentationEntry["structuredPayload"]>,
      }),
    ).toBe("read");
    expect(
      toolGroupAction({
        id: "grep",
        createdAt: "2026-09-01T00:00:00Z",
        label: "Grep",
        tone: "tool",
        itemType: "dynamic_tool",
        toolTitle: "Grep",
        toolData: { input: { pattern: "TODO", path: "apps/web" } },
        structuredPayload: {
          type: "dynamic_tool",
          toolName: "Grep",
          input: { pattern: "TODO", path: "apps/web" },
        } as NonNullable<WorkLogPresentationEntry["structuredPayload"]>,
      }),
    ).toBe("code-search");
  });
});

describe("resolveViewedImageAsset", () => {
  const threadId = ThreadId.make("thread-1");

  it("serves t2 attachment paths in place like any other host path", () => {
    const path = "/Users/demo/.t2/dev/attachments/11111111-1111-4111-8111-111111111111.png";
    expect(resolveViewedImageAsset(path, { threadId, workspaceRoot: "/workspace" })).toEqual({
      resource: { _tag: "media-file", threadId, path },
      alt: "11111111-1111-4111-8111-111111111111.png",
      srcFragment: "",
    });
  });

  it("normalizes workspace image sources", () => {
    expect(
      resolveViewedImageAsset("screens/logo.svg?v=2#mark", {
        threadId,
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      resource: {
        _tag: "media-file",
        threadId,
        path: "/workspace/screens/logo.svg",
      },
      alt: "logo.svg",
      srcFragment: "#mark",
    });
    expect(resolveViewedImageAsset("https://example.com/logo.png", { threadId })).toBeNull();
  });
});

describe("pull request tool presentation", () => {
  it.each([
    "mcp__t2-code__link_pull_request",
    "mcp__t2_code__link_pull_request",
    "t2-code · link_pull_request",
    "t2code/link_pull_request",
    "link_pull_request",
  ])("recognizes the native linking tool: %s", (label) => {
    const entry: WorkLogPresentationEntry = {
      id: "link",
      createdAt: "2026-09-10T00:00:00.000Z",
      label,
      tone: "tool",
      toolLifecycleStatus: "completed",
    };
    expect(resolveWorkEntryToolPresentation(entry)).toMatchObject({
      displayName: "Linked a pull request",
      icon: "pull-request",
    });
    expect(toolGroupAction(entry)).toBe("link-pr");
  });

  it.each([
    ["inProgress", "Linking PR #42"],
    ["completed", "Linked PR #42"],
    ["failed", "Failed to link PR #42"],
    ["declined", "Declined to link PR #42"],
    ["stopped", "Stopped linking PR #42"],
  ] as const)("describes the target and %s status", (toolLifecycleStatus, displayName) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "MCP tool call",
        toolTitle: "Custom title",
        toolLifecycleStatus,
        toolData: {
          server: "t2-code",
          tool: "link_pull_request",
          arguments: { url: "https://github.com/acme/web/pull/42" },
        },
      })?.displayName,
    ).toBe(displayName);
  });

  it("recognizes unlink targets supplied as repository and number", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "MCP tool call",
        toolLifecycleStatus: "completed",
        toolData: {
          toolName: "mcp__t2-code__unlink_pull_request",
          rawInput: { repository: "acme/web", number: 42 },
        },
      }),
    ).toMatchObject({ displayName: "Unlinked PR #42", icon: "pull-request", action: "unlink-pr" });
  });

  it("summarizes native PR work separately from ordinary tools and integration metadata", () => {
    const link: WorkLogPresentationEntry = {
      id: "link",
      createdAt: "2026-09-10T00:00:00.000Z",
      label: "T2-code · link_pull_request",
      tone: "tool",
      itemType: "dynamic_tool",
      toolLifecycleStatus: "completed",
      toolSource: { key: "t2-code", name: "T2 Code", kind: "integration" },
    };
    const list: WorkLogPresentationEntry = {
      ...link,
      label: "t2-code · list_thread_pull_requests",
    };
    expect(summarizeToolGroup([link, link, list]).summary).toBe(
      "Linked 2 pull requests and checked linked pull requests",
    );
    expect(summarizeToolGroup([{ ...link, label: "T2-code · unlink_pull_request" }]).summary).toBe(
      "Unlinked 1 pull request",
    );
    expect(toolGroupSummaryKind([link, link, list])).toBe("pull-request");
    expect(summarizeToolGroup([list, list]).summary).toBe("Checked linked pull requests 2 times");
    expect(
      resolveWorkEntryToolPresentation({ label: "mcp__another-server__link_pull_request" }),
    ).toBeNull();
  });
});

describe("device group summaries", () => {
  const deviceEntry = (tool: string): WorkLogPresentationEntry => ({
    id: tool,
    createdAt: "2026-09-10T00:00:00.000Z",
    label: "MCP tool call",
    toolData: { server: "t2-code", tool },
    itemType: "dynamic_tool",
    toolLifecycleStatus: "completed",
    tone: "tool",
  });

  it.each(["device_list", "device_open", "device_screenshot", "device_close"])(
    "recognizes %s as device controls",
    (tool) => {
      const entry = deviceEntry(tool);
      expect(summarizeToolGroup([entry]).summary).toBe("Used device controls 1 time");
      expect(toolGroupSummaryKind([entry])).toBe("device");
    },
  );

  it("summarizes device calls alongside shell commands", () => {
    expect(
      summarizeToolGroup([
        {
          id: "command",
          createdAt: "2026-09-10T00:00:00.000Z",
          label: "Ran command",
          itemType: "command_execution",
          command: "pwd",
          tone: "tool",
        },
        deviceEntry("device_list"),
        deviceEntry("device_open"),
      ]).summary,
    ).toBe("Ran 1 command and used device controls 2 times");
  });

  it("recognizes Claude tool names and preserves screenshot previews", () => {
    const entry = {
      ...deviceEntry("device_screenshot"),
      toolData: { toolName: "mcp__t2_code__device_screenshot" },
      viewedImagePath: "/workspace/device.png",
    };
    expect(summarizeToolGroup([entry]).summary).toBe("Used device controls 1 time");
    expect(workEntryViewedImagePath(entry)).toBe("/workspace/device.png");
  });

  it("does not classify another server's tools as T2 device controls", () => {
    expect(
      summarizeToolGroup([
        {
          ...deviceEntry("device_open"),
          toolData: { server: "another-server", tool: "device_open" },
        },
      ]).summary,
    ).toBe("Used 1 tool");
  });
});

describe("liveThoughtLine", () => {
  it("keeps the first sentence, including a closing quote", () => {
    expect(
      liveThoughtLine(
        'Found the cause: the repo has no commits, so `git worktree add` fails with "invalid reference: main." Now checking the UI.',
      ),
    ).toBe(
      'Found the cause: the repo has no commits, so git worktree add fails with "invalid reference: main."',
    );
  });

  it("does not cut at dots inside file names or long dashes", () => {
    expect(
      liveThoughtLine("I read ThreadLaunchService.ts \u2014 it skips the fetch. Next step."),
    ).toBe("I read ThreadLaunchService.ts \u2014 it skips the fetch.");
  });

  it("uses a bold-only opening line as the whole line", () => {
    expect(
      liveThoughtLine("**Narrowing dispatch files**\n\nI should check the adapter. Then more."),
    ).toBe("Narrowing dispatch files");
    expect(liveThoughtLine("**Narrowing dispatch files**\r\n\r\nI should check the adapter.")).toBe(
      "Narrowing dispatch files",
    );
  });

  it("returns unpunctuated text whole and flattens markdown", () => {
    expect(liveThoughtLine("- Checking [the docs](https://x.dev) for **limits**")).toBe(
      "Checking the docs for limits",
    );
    expect(liveThoughtLine("This is *really* ~~not~~ _fine_ in snake_case_names.")).toBe(
      "This is really not fine in snake_case_names.",
    );
    expect(liveThoughtLine("   ")).toBe("");
  });
});
