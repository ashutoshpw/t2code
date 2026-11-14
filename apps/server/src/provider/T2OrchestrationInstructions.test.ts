import { assert, describe, it } from "@effect/vitest";

import {
  T2_CODE_ORCHESTRATION_INSTRUCTIONS,
  t2AcpPromptWithInstructions,
  t2OrchestrationPromptForFirstRun,
  t2OrchestrationSystemPrompt,
} from "./T2OrchestrationInstructions.ts";

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
  });
});
