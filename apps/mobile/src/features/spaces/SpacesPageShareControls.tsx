import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t2code/client-runtime/state/runtime";
import { SpacePageShareError, type EnvironmentId } from "@t2code/contracts";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { useContext, useEffect, useState } from "react";
import { Platform, Share } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import * as Dialog from "../../components/ui/Dialog";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useServerConfigs } from "../../state/entities";
import { spacesEnvironment } from "../../state/spaces";
import { useAtomCommand } from "../../state/use-atom-command";
import { pageShareErrorMessage } from "./pageShareCopy";

/** Share controls for an open page; a page's link covers it and its sub-pages. */
export function SpacesPageShareControls(props: {
  readonly environmentId: EnvironmentId;
  readonly pageId: SpacePageId;
  readonly disabled: boolean;
}) {
  const { environmentId, pageId } = props;
  const registry = useContext(RegistryContext);
  const enabled = useServerConfigs().get(environmentId)?.settings.spacesPageSharingEnabled === true;
  const canRead = useAtomValue(spacesEnvironment.getPageShare.permissionAtom(environmentId));
  const canCreate = useAtomValue(spacesEnvironment.createPageShare.permissionAtom(environmentId));
  const canStop = useAtomValue(spacesEnvironment.stopPageShare.permissionAtom(environmentId));
  const link = useAtomValue(spacesEnvironment.pageShare(environmentId, pageId));
  const createShare = useAtomCommand(spacesEnvironment.createPageShare, { reportFailure: false });
  const stopShare = useAtomCommand(spacesEnvironment.stopPageShare, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [openedAt] = useState(Date.now);
  // oxlint-disable-next-line t2code/react-effect-budget -- Reads the page's share from the environment when the page opens.
  useEffect(() => {
    if (!enabled || !canRead) return;
    void spacesEnvironment.getPageShare.run(registry, { environmentId, input: { pageId } });
  }, [registry, enabled, canRead, environmentId, pageId]);

  const shareUrl = (url: string) =>
    void Share.share(Platform.OS === "ios" ? { url } : { message: url }).catch(() => {});
  const request = async (action: "create" | "stop") => {
    setBusy(true);
    const input = { environmentId, input: { pageId } };
    const result = await (action === "create" ? createShare(input) : stopShare(input));
    setBusy(false);
    if (result._tag === "Success") {
      if (action === "create") {
        const created = registry.get(spacesEnvironment.pageShare(environmentId, pageId));
        if (created) shareUrl(created.url);
      }
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    Dialog.alert(
      action === "create" ? "Could not create link" : "Could not stop sharing",
      pageShareErrorMessage(squashAtomCommandFailure(result)),
    );
  };
  const create = () => {
    if (!enabled) {
      Dialog.alert(
        "Page links are off",
        pageShareErrorMessage(new SpacePageShareError({ reason: "disabled" })),
      );
      return;
    }
    void request("create");
  };
  const unavailable = props.disabled || busy;
  const active = link && Date.parse(link.share.expiresAt) > openedAt;
  if (!enabled && !canCreate) return null;

  return active ? (
    <>
      <Text className="w-full text-sm text-foreground-muted">
        Shared. Anyone with the link can read this page and its sub-pages.
      </Text>
      <ControlPill
        variant="pill"
        label="Copy link"
        disabled={busy}
        onPress={() => copyTextWithHaptic(link.url, { target: "page link" })}
      />
      <ControlPill
        variant="pill"
        label="Share link"
        disabled={busy}
        onPress={() => shareUrl(link.url)}
      />
      <ControlPill
        variant="pill"
        label="Create new link"
        disabled={unavailable || !canCreate}
        onPress={() =>
          Dialog.confirm({
            title: "Create a new link?",
            message: "The current link stops working.",
            confirmText: "Create new link",
            onConfirm: create,
          })
        }
      />
      <ControlPill
        variant="pill"
        label="Stop sharing"
        disabled={unavailable || !canStop}
        onPress={() =>
          Dialog.confirm({
            title: "Stop sharing?",
            message: "The link stops working for everyone.",
            confirmText: "Stop sharing",
            destructive: true,
            onConfirm: () => void request("stop"),
          })
        }
      />
    </>
  ) : (
    <ControlPill
      variant="pill"
      label="Share"
      disabled={unavailable || !canCreate}
      onPress={create}
    />
  );
}
