import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { squashAtomCommandFailure } from "@t2code/client-runtime/state/runtime";
import type { EnvironmentId } from "@t2code/contracts";
import { useRef, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useSpacesReadAccess } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

export function SpacesEnvironmentSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const permission = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const connection = useEnvironmentQuery(environmentCatalog.stateAtom(environmentId));
  const access = useSpacesReadAccess(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = config?.environment.capabilities.spacesSettings === true;
  async function change(enabled: boolean) {
    if (busy.current) return;
    const current = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if (current?.environment.capabilities.spacesSettings !== true) return;
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await update({ environmentId, input: { patch: { spacesEnabled: enabled } } });
    busy.current = false;
    setPending(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change Spaces. Try again.");
    }
  }
  return (
    <SettingsSection title="Spaces">
      <SettingsSwitchRow
        icon="doc.text"
        label="Enable Spaces"
        subtitle={
          supported
            ? "Browse pages from this environment. Turning Spaces off keeps its data."
            : "Update this environment to enable Spaces."
        }
        value={config?.settings.spacesEnabled ?? false}
        disabled={!supported || !permission || connection.data?.phase !== "connected" || pending}
        onValueChange={(value) => void change(value)}
      />
      <SettingsRow
        icon="folder"
        label="Open Spaces"
        disabled={!canBrowseSpaces(access.availability)}
        onPress={() => navigation.push("SpacesLibrary", { environmentId })}
      />
      {error ? (
        <Text accessibilityRole="alert" className="px-4 py-2 text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
