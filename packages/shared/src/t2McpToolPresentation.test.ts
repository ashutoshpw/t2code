import { describe, expect, it } from "vite-plus/test";

import { T2_MCP_TOOL_NAMES, resolveT2McpToolPresentation } from "./t2McpToolPresentation.ts";

describe("resolveT2McpToolPresentation", () => {
  it("recognizes every T2 tool across provider prefixes and completion suffixes", () => {
    for (const tool of T2_MCP_TOOL_NAMES) {
      const presentation = resolveT2McpToolPresentation(tool);
      for (const prefix of [
        "mcp__t2-code__",
        "mcp__t2_code__",
        "mcp__t3code__",
        "T2-code.",
        "t3_code/",
        "t3code:",
        "mcp_t2-code_",
        "T2 Code ",
        "t2-code · ",
      ]) {
        expect(resolveT2McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT2McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor T2 MCP tool names", () => {
    expect(resolveT2McpToolPresentation("mcp__t2-code__t2_thread_read")).toEqual({
      displayName: "Read a T2 thread",
      logo: "t2-code",
    });
  });

  it("pretty prints Codex T2 MCP tool names", () => {
    expect(resolveT2McpToolPresentation("t2-code.create_threads")).toEqual({
      displayName: "Create T2 threads",
      logo: "t2-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveT2McpToolPresentation("mcp__t2-code__t2_thread_update")).toEqual({
      displayName: "Update T2 thread metadata",
      logo: "t2-code",
    });
  });

  it("pretty prints bare T2 MCP toolkit names", () => {
    expect(resolveT2McpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t2-code",
    });
  });

  it("pretty prints worktree T2 MCP tool names", () => {
    expect(resolveT2McpToolPresentation("mcp__t2-code__t2_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "t2-code",
    });
    expect(resolveT2McpToolPresentation("t2-code.t2_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "t2-code",
    });
  });

  it("pretty prints preview T2 MCP tool names", () => {
    expect(resolveT2McpToolPresentation("T2-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "t2-code",
    });
    expect(resolveT2McpToolPresentation("mcp__t2-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "t2-code",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_t2-code_delegate_task",
      "t2_code:delegate_task",
      "t2code/delegate_task",
      "t2-code delegate_task",
      "T2 Code delegate_task",
      "t2-code__delegate_task",
      // Transcripts recorded before the rename keep the upstream spellings.
      "mcp_t3-code_delegate_task",
      "t3-code__delegate_task",
    ]) {
      expect(resolveT2McpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT2McpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveT2McpToolPresentation("t2-code.not_a_real_tool")).toBeNull();
  });
});
