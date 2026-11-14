import { describe, expect, it } from "vite-plus/test";

import {
  T2_MCP_TOOL_NAMES,
  resolveT2McpSummaryAction,
  resolveT2McpToolDefinition,
  resolveT2McpToolPresentation,
} from "./t2McpToolPresentation.ts";

describe("resolveT2McpToolPresentation", () => {
  it("recognizes every T3 tool across provider prefixes and completion suffixes", () => {
    for (const tool of T2_MCP_TOOL_NAMES) {
      const presentation = resolveT2McpToolPresentation(tool);
      for (const prefix of [
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3code.",
        "t3-code-direct.",
        "mcp__t3_code_direct__",
        "t2_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveT2McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT2McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT2McpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT2McpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });
});

describe("resolveT2McpToolDefinition", () => {
  it("labels an action tool call as the action it ran", () => {
    expect(
      resolveT2McpToolDefinition("mcp__t3-code__preview_act", { action: "type" })?.labels,
    ).toEqual(resolveT2McpToolDefinition("preview_type")?.labels);
    expect(resolveT2McpToolDefinition("t2_thread_transfer", { action: "fork" })?.displayName).toBe(
      resolveT2McpToolDefinition("t2_thread_fork")?.displayName,
    );
    expect(resolveT2McpToolDefinition("preview_act", { action: "unknown" })?.labels[2]).toBe(
      "Used",
    );
  });
});

describe("resolveT2McpSummaryAction", () => {
  it("summarizes an action tool by the action each call ran", () => {
    expect(resolveT2McpSummaryAction("mcp__t3-code__t3_queue", { action: "list" })).toBe(
      "queue-list",
    );
    expect(resolveT2McpSummaryAction("t2_queue", { action: "edit" })).toBe("queue-edit");
    expect(resolveT2McpSummaryAction("t2_thread_transfer", { action: "status" })).toBe(
      "thread-transfers",
    );
    expect(resolveT2McpSummaryAction("t2_thread_configure", {})).toBe("thread-configuration");
    expect(resolveT2McpSummaryAction("schedule_task", { scheduledTaskId: "task-1" })).toBe(
      "schedule-update",
    );
    expect(resolveT2McpSummaryAction("delegate_task", { task: "x" })).toBe("delegate");
  });
});
