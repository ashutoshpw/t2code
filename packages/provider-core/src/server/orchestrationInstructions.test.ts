import { assert, describe, it } from "@effect/vitest";

import {
<<<<<<< HEAD
  T2_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T2_CODE_ORCHESTRATION_INSTRUCTIONS,
  t2AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t2OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 device instructions", () => {
  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T2_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T2_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T2_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T2_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T2_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t2OrchestrationSystemPrompt(true, true), T2_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t2OrchestrationSystemPrompt(true, false), "## T3 Code devices");
    assert.isUndefined(t2OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT2Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T2_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), "## T3 Code devices");

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT2Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T2_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T2_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT2Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t2AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T2_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t2AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t2AcpPromptWithInstructions({ prompt: "Hi.", state }), "## T3 Code devices");
=======
  T2_CODE_ORCHESTRATION_INSTRUCTIONS,
  t2AcpPromptWithInstructions,
  t2OrchestrationPromptForFirstRun,
  t2OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T2 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T2 conversations");
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T2_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t2_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T2_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t2OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT2Mcp: true,
    });

    assert.include(injected, "<t2_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t2OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT2Mcp: true }),
      prompt,
    );
    assert.equal(
      t2OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT2Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T2 MCP server is attached", () => {
    assert.equal(t2OrchestrationSystemPrompt(false), undefined);
    assert.equal(t2OrchestrationSystemPrompt(true), T2_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t2AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT2Mcp: true },
    });

    assert.include(injected, "T2 Code interaction mode: Default");
    assert.include(injected, "T2 Code collaborative browser");
    assert.include(injected, "T2 Code orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT2Mcp: true } as const;

    assert.equal(
      t2AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t2AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "T2 Code interaction mode: Plan",
    );
    const withoutMcp = t2AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT2Mcp: false },
    });
    assert.include(withoutMcp, "T2 Code interaction mode: Default");
    assert.notInclude(withoutMcp, "T2 Code collaborative browser");
    assert.notInclude(withoutMcp, "T2 Code orchestration");
>>>>>>> 3fe5686b6c (rebrand(packages): finish the T2 sweep in shared packages and providers)
  });
});
