import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId } from "@t2code/contracts/spaces";
import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { spaceRootReorder } from "./sessionRuntime";

declare module "@tanstack/react-router" {
  interface HistoryState {
    focusTitle?: string;
  }
}

const run = (work: Promise<unknown>) => {
  void work.catch(() => {});
};

function OwnerGate({
  environmentId,
  children,
}: {
  environmentId: EnvironmentId;
  children: (owner: SpaceRootReorder) => ReactNode;
}) {
  const registry = useContext(RegistryContext);
  const [result] = useState(() => {
    try {
      return { owner: spaceRootReorder(registry, environmentId) };
    } catch (error) {
      return { error };
    }
  });
  if (!result.owner)
    return (
      <p role="alert" className="text-sm">
        {result.error instanceof Error ? result.error.message : "Library storage unavailable."}
      </p>
    );
  return children(result.owner);
}

function useLibraryGate(environmentId: EnvironmentId, owner: SpaceRootReorder) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const availability = useSpacesAvailability(environmentId);
  // oxlint-disable-next-line t2code/react-effect-budget -- Load the durable operation journal so a retained receipt blocks new creates.
  useEffect(() => {
    run(owner.hydrate());
  }, [owner]);
  const { busy, hydrated, journal } = snapshot;
  const blockedReason = !canBrowseSpaces(availability)
    ? "Spaces is unavailable"
    : availability !== "writable"
      ? "Spaces is read-only"
      : journal.pending
        ? "Recover the pending library change first"
        : !hydrated
          ? "Loading library storage"
          : busy
            ? "Another library change is in progress"
            : null;
  return { snapshot, availability, blockedReason };
}

function Reason({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipPopup side="bottom">{reason}</TooltipPopup>
    </Tooltip>
  );
}

export function CreatePageButton({
  environmentId,
  spaceId,
  label,
  variant = "default",
  onNavigate,
}: {
  environmentId: EnvironmentId;
  spaceId?: SpaceId | undefined;
  label: string;
  variant?: "default" | "outline";
  onNavigate?: () => void;
}) {
  return (
    <OwnerGate environmentId={environmentId}>
      {(owner) => (
        <PageButton
          environmentId={environmentId}
          spaceId={spaceId}
          label={label}
          variant={variant}
          onNavigate={onNavigate}
          owner={owner}
        />
      )}
    </OwnerGate>
  );
}

function PageButton({
  environmentId,
  spaceId,
  label,
  variant,
  onNavigate,
  owner,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId | undefined;
  label: string;
  variant: "default" | "outline";
  onNavigate: (() => void) | undefined;
  owner: SpaceRootReorder;
}) {
  const navigate = useNavigate();
  const { availability, blockedReason } = useLibraryGate(environmentId, owner);
  const allowed = useAtomValue(spacesEnvironment.createPage.permissionAtom(environmentId));
  const readable = canBrowseSpaces(availability);
  const catalog = useEnvironmentQuery(
    readable && !spaceId
      ? spacesEnvironment.list({ environmentId, input: { environmentId, limit: 1 } })
      : null,
  );
  const targetId =
    spaceId ?? (catalog.isSuccess && !catalog.isPending ? catalog.data?.defaultSpaceId : undefined);
  const selected = useEnvironmentQuery(
    readable && targetId
      ? spacesEnvironment.pages({
          environmentId,
          input: { environmentId, spaceId: targetId, limit: 1 },
        })
      : null,
  );
  const space = selected.isSuccess && !selected.isPending ? selected.data?.space : undefined;
  const reason =
    blockedReason ?? (!allowed ? "You cannot create pages here" : !space ? "Loading space" : null);
  const create = async () => {
    if (!space) return;
    await owner.createRootPage(space, "");
    const page = owner.getSnapshot().libraryResult?.page;
    if (!page) return;
    onNavigate?.();
    await navigate({
      to: "/spaces/$environmentId/$spaceId/$pageId",
      params: { environmentId, spaceId: page.spaceId, pageId: page.id },
      search: {},
      state: { focusTitle: page.id },
    });
  };
  return (
    <Reason reason={reason}>
      <Button variant={variant} disabled={!!reason} onClick={() => run(create())}>
        <PlusIcon />
        {label}
      </Button>
    </Reason>
  );
}

export function NewSpaceButton({
  environmentId,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  onNavigate?: () => void;
}) {
  return (
    <OwnerGate environmentId={environmentId}>
      {(owner) => (
        <SpaceButton environmentId={environmentId} onNavigate={onNavigate} owner={owner} />
      )}
    </OwnerGate>
  );
}

function SpaceButton({
  environmentId,
  onNavigate,
  owner,
}: {
  environmentId: EnvironmentId;
  onNavigate: (() => void) | undefined;
  owner: SpaceRootReorder;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const { blockedReason } = useLibraryGate(environmentId, owner);
  const allowed = useAtomValue(spacesEnvironment.createSpace.permissionAtom(environmentId));
  const reason = blockedReason ?? (!allowed ? "You cannot create spaces here" : null);
  const submit = async () => {
    await owner.createSpace(title);
    const space = owner.getSnapshot().libraryResult?.space;
    setOpen(false);
    if (!space) return;
    onNavigate?.();
    await navigate({
      to: "/spaces/$environmentId/$spaceId",
      params: { environmentId, spaceId: space.id },
    });
  };
  return (
    <>
      <Reason reason={reason ?? "New space"}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="New space"
          disabled={!!reason}
          onClick={() => {
            setTitle("");
            setOpen(true);
          }}
        >
          <PlusIcon />
        </Button>
      </Reason>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New space</DialogTitle>
            <DialogDescription>Spaces group pages. You can rename it later.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!reason) run(submit());
              }}
            >
              <Input
                autoFocus
                aria-label="Space title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <Button type="submit" disabled={!!reason || !title.trim()}>
                Create space
              </Button>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function CreateStatus({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <OwnerGate environmentId={environmentId}>
      {(owner) => <Status environmentId={environmentId} owner={owner} />}
    </OwnerGate>
  );
}

function Status({
  environmentId,
  owner,
}: {
  environmentId: EnvironmentId;
  owner: SpaceRootReorder;
}) {
  const { snapshot, availability } = useLibraryGate(environmentId, owner);
  // While an operation is in flight its own journal entry is pending; only a leftover one needs the banner.
  const pending = snapshot.busy ? null : snapshot.journal.pending;
  if (!pending && !snapshot.error) return null;
  return (
    <div className="space-y-1 text-sm">
      {pending ? (
        <>
          <p role="status">
            {pending.conflict || pending.rejection
              ? "A library change was not applied."
              : "A library change is waiting for confirmation."}
          </p>
          <Button
            variant="outline"
            size="xs"
            disabled={
              snapshot.busy ||
              !snapshot.hydrated ||
              !canBrowseSpaces(availability) ||
              (!!pending.conflict && availability !== "writable")
            }
            onClick={() => run(pending.conflict ? owner.reinspect() : owner.recover())}
          >
            {pending.conflict ? "Dismiss" : "Finish it"}
          </Button>
        </>
      ) : snapshot.error ? (
        <p role="alert">Couldn't finish that change. Reload the page and try again.</p>
      ) : null}
    </div>
  );
}

export function SidebarCreateControls({
  environmentId,
  spaceId,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  spaceId: SpaceId | undefined;
  onNavigate: () => void;
}) {
  return (
    <>
      <CreatePageButton
        environmentId={environmentId}
        spaceId={spaceId}
        label="Create"
        variant="outline"
        onNavigate={onNavigate}
      />
      <CreateStatus environmentId={environmentId} />
    </>
  );
}
