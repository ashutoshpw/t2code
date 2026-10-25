import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t2code/provider-core/server/runtimeInstructions";

import {
  T2_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T2_CODE_ORCHESTRATION_SECTIONS,
} from "@t2code/provider-core/server/orchestrationInstructions";

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const T2_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T2 Code devices

The \`t2-code\` MCP server also exposes \`device_*\` tools for iOS Simulators and Android Emulators on this environment. For mobile verification, call \`device_list\`, then \`device_open\` so the user can watch the device in their Device panel; its result explains how to drive the device. Driving happens through the \`agent-device\` CLI, using the exact launcher path returned by \`device_open\`. Keep the host config and session flags returned by \`device_open\` on every command so concurrent devices stay independent: prefer \`agent-device snapshot -i\` refs over coordinates, and use \`device_screenshot\` when you need to see the screen. Prefer these tools and \`agent-device\` for opening and driving devices. Platform tools such as \`xcrun simctl\` and \`adb\` remain available for anything they do not cover, such as builds, logs, or port forwarding. If \`device_list\` reports a platform as unavailable, say so.`;

export interface T2CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T2CodeToolAvailability,
): T2CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T2CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T2_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T2_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  /**
   * Whether the `t2-code` MCP server is attached to this turn. Callers derive
   * it from the session's actual MCP configuration rather than re-reading the
   * setting, so the prompt cannot claim tools the turn doesn't have.
   */
  toolsAvailable: boolean | T2CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T2_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t2_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t2_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t2_code_tools: { kind: "application", value: tools } } : {}),
  };
}
