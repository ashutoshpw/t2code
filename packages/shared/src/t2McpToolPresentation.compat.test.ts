import { describe, expect, it } from "vite-plus/test";

import { T2_MCP_TOOL_NAMES, resolveT2McpToolPresentation } from "./t2McpToolPresentation.ts";

describe("resolveT2McpToolPresentation", () => {
  it("recognizes legacy tools across provider prefixes and completion suffixes", () => {
    for (const tool of T2_MCP_TOOL_NAMES) {
      const presentation = resolveT2McpToolPresentation(tool);
      for (const prefix of [
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T2 Code ",
        "t3-code · ",
      ]) {
        expect(resolveT2McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT2McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints legacy Claude and Cursor MCP tool names", () => {
    expect(resolveT2McpToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a T2 thread",
      logo: "t2-code",
    });
  });

  it("pretty prints legacy Codex MCP tool names", () => {
    expect(resolveT2McpToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create T2 threads",
      logo: "t2-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveT2McpToolPresentation("mcp__t3-code__t3_thread_update")).toEqual({
      displayName: "Update T2 thread metadata",
      logo: "t2-code",
    });
  });

  it("pretty prints bare legacy MCP toolkit names", () => {
    expect(resolveT2McpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t2-code",
    });
  });

  it("pretty prints legacy worktree MCP tool names", () => {
    expect(resolveT2McpToolPresentation("mcp__t3-code__t3_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "t2-code",
    });
    expect(resolveT2McpToolPresentation("t3-code.t3_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "t2-code",
    });
  });

  it("pretty prints legacy preview MCP tool names", () => {
    expect(resolveT2McpToolPresentation("T3-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "t2-code",
    });
    expect(resolveT2McpToolPresentation("mcp__t3-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "t2-code",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_t3-code_delegate_task",
      "t3_code:delegate_task",
      "t3code/delegate_task",
      "t3-code delegate_task",
      "T2 Code delegate_task",
      "t3-code__delegate_task",
    ]) {
      expect(resolveT2McpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT2McpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT2McpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT2McpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveT2McpToolPresentation("t3-code.not_a_real_tool")).toBeNull();
  });
});
