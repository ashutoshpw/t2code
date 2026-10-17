import { isProviderDriverKind } from "@t2code/contracts";
import { acpRegistryClient } from "@t2code/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t2code/provider-core/client";
import { cursorClient } from "@t2code/provider-cursor/client";
import { grokClient } from "@t2code/provider-grok/client";
import { museClient } from "@t2code/provider-muse/client";
import { openCodeClient } from "@t2code/provider-opencode/client";
import { piClient } from "@t2code/provider-pi/client";

const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
