import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@t2code/contracts";
import { acpRegistryClient } from "@t2code/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t2code/provider-core/client";
import { cursorClient } from "@t2code/provider-cursor/client";
import { grokClient } from "@t2code/provider-grok/client";
import { museClient } from "@t2code/provider-muse/client";
import { openCodeClient } from "@t2code/provider-opencode/client";
import { piClient } from "@t2code/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
