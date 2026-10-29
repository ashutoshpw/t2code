import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t2code/client-runtime/state/runtime";
import { SPACE_PAGE_SHARE_TTL_MS, SpacePageShareError } from "@t2code/contracts";
import type { SpacePageShareLink } from "@t2code/contracts";
import * as Schema from "effect/Schema";
import { Link, useRouter } from "@tanstack/react-router";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironment } from "~/state/environments";
import { spacesEnvironment } from "~/state/spaces";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatExpiresInLabel } from "~/timestampFormat";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { spacePageShareDialogAtom, type SpacePageShareTarget } from "./spacePageShareDialogState";

const isShareError = Schema.is(SpacePageShareError);

export function SpacePageShareDialogHost() {
  const target = useAtomValue(spacePageShareDialogAtom);
  if (target === null) return null;
  return (
    <SpacePageShareDialog
      key={`${target.environmentId}:${target.pageId}`}
      target={target}
      onClose={() => appAtomRegistry.set(spacePageShareDialogAtom, null)}
    />
  );
}

function SpacePageShareDialog({
  target,
  onClose,
}: {
  readonly target: SpacePageShareTarget;
  readonly onClose: () => void;
}) {
  const { environmentId, pageId } = target;
  const router = useRouter();
  const enabled =
    useEnvironment(environmentId)?.serverConfig?.settings.spacesPageSharingEnabled === true;
  const link = useAtomValue(spacesEnvironment.pageShare(environmentId, pageId));
  const canCreate = useAtomValue(spacesEnvironment.createPageShare.permissionAtom(environmentId));
  const canStop = useAtomValue(spacesEnvironment.stopPageShare.permissionAtom(environmentId));
  const createShare = useAtomCommand(spacesEnvironment.createPageShare, { reportFailure: false });
  const stopShare = useAtomCommand(spacesEnvironment.stopPageShare, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SpacePageShareError["reason"] | null>(null);
  const connectMissing = problem === "connect_unavailable";

  const run = async (action: "create" | "stop") => {
    setBusy(true);
    setProblem(null);
    const input = { environmentId, input: { pageId } };
    const result = await (action === "create" ? createShare(input) : stopShare(input));
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: action === "create" ? "Link created" : "Sharing stopped",
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    if (isShareError(error)) {
      if (error.reason === "disabled" || error.reason === "connect_unavailable")
        setProblem(error.reason);
      else toastManager.add({ type: "error", title: error.message });
      return;
    }
    toastManager.add({ type: "error", title: "Could not update the page share." });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share page</DialogTitle>
          <DialogDescription>
            Anyone with the link can read this page and its sub-pages in a browser, without signing
            in. They see it as it was when they opened it and cannot edit.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!enabled || problem === "disabled" ? (
            <Notice
              text="Page links are off. Turn on Page links in Settings > Labs to share pages."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onClose();
                    void router.navigate({ to: "/settings/labs" });
                  }}
                >
                  Open Labs settings
                </Button>
              }
            />
          ) : connectMissing ? (
            <Notice
              text="Page links need T2 Connect. Sign in and link this machine, as described in the Remote access guide."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link to="/settings/access" onClick={onClose} />}
                >
                  Open Sharing &amp; access
                </Button>
              }
            />
          ) : link === undefined ? (
            <p role="status" className="text-muted-foreground text-sm">
              Checking for a link…
            </p>
          ) : link === null ? (
            <p className="text-muted-foreground text-sm">
              This page is not shared. A link works for{" "}
              {Math.round(SPACE_PAGE_SHARE_TTL_MS / 86_400_000)} days.
            </p>
          ) : (
            <LinkDetails link={link} />
          )}
          {!canCreate && enabled ? (
            <p className="mt-3 text-muted-foreground text-xs">
              You have read-only access to this environment, so you cannot change sharing.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {enabled && !connectMissing && problem !== "disabled" ? (
            <>
              {link ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !canStop}
                  onClick={() => void run("stop")}
                >
                  Stop sharing
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={busy || !canCreate || link === undefined}
                onClick={() => void run("create")}
              >
                {link ? "Create new link" : "Create link"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Notice({ text, action }: { text: string; action: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm">{text}</p>
      {action}
    </div>
  );
}

function LinkDetails({ link }: { link: SpacePageShareLink }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "page link" });
  const nowMinute = useNowMinute();
  const expired = link.share.expiresAt.slice(0, 16) <= nowMinute;
  const expires = formatExpiresInLabel(link.share.expiresAt);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-label="Page link"
          value={link.url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button size="sm" variant="outline" onClick={() => copyToClipboard(link.url)}>
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {expired
          ? "This link has expired. Create a new link to share the page again."
          : `${expires}. Creating a new link ends this one.`}
      </p>
    </div>
  );
}
