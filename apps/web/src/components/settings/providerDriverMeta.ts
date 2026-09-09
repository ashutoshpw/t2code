import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  FxSettings,
  GrokSettings,
  OpenCodeSettings,
  PiSettings,
  MuseSettings,
  ProviderDriverKind,
} from "@t2code/contracts";
import { acpRegistryClient } from "@t2code/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t2code/provider-core/client";
import { cursorClient } from "@t2code/provider-cursor/client";
import { fxClient } from "@t2code/provider-fx/client";
import { grokClient } from "@t2code/provider-grok/client";
import { museClient } from "@t2code/provider-muse/client";
import { openCodeClient } from "@t2code/provider-opencode/client";
import { piClient } from "@t2code/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    acpRegistryAgentIds: ["claude-acp"],
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    acpRegistryAgentIds: ["antigravity-acp"],
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
