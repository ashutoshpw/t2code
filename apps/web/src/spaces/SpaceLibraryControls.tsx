import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId, SpacePageSummary, SpaceSummary } from "@t2code/contracts/spaces";
import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { Input } from "../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { toastManager } from "../components/ui/toast";
import { spaceRootReorder } from "./sessionRuntime";

interface Props {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
}
type Intent =
  | { kind: "renameSpace"; space: SpaceSummary }
  | { kind: "setDefaultSpace"; space: SpaceSummary; previous: SpaceSummary };
const focusedTitles = new Set<string>();
const run = (work: Promise<unknown>) => {
  void work.catch(() => {});
};

function useOwner(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const [result] = useState(() => {
    try {
      return { owner: spaceRootReorder(registry, environmentId) };
    } catch (error) {
      return { error };
    }
  });
  return result;
}

export default function SpaceLibraryControls(props: Props) {
  const result = useOwner(props.environmentId);
  if (!result.owner) return null;
  return <Library {...props} owner={result.owner} />;
}

export function PageTitleField({
  environmentId,
  page,
  current,
  autoFocus,
}: {
  environmentId: EnvironmentId;
  page: SpacePageSummary;
  current: () => boolean;
  autoFocus: boolean;
}) {
  const result = useOwner(environmentId);
  if (!result.owner) return <TitleInput page={page} readOnly autoFocus={false} />;
  return (
    <EditableTitle
      environmentId={environmentId}
      page={page}
      current={current}
      owner={result.owner}
      autoFocus={autoFocus}
    />
  );
}

function TitleInput({
  page,
  value = page.title,
  readOnly,
  autoFocus,
  onChange,
  onCommit,
  onCancel,
}: {
  page: SpacePageSummary;
  value?: string;
  readOnly: boolean;
  autoFocus: boolean;
  onChange?: (value: string) => void;
  onCommit?: () => void;
  onCancel?: () => void;
}) {
  return (
    <textarea
      ref={(element) => {
        if (!element || !autoFocus || focusedTitles.has(page.id)) return;
        focusedTitles.add(page.id);
        element.focus();
        element.select();
      }}
      rows={1}
      aria-label="Page title"
      placeholder="Untitled"
      readOnly={readOnly || !!page.trash}
      value={value}
      onChange={(event) => onChange?.(event.target.value.replace(/\n/g, " "))}
      onBlur={onCommit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel?.();
          event.currentTarget.blur();
        }
      }}
      className="block w-full resize-none break-words bg-transparent text-4xl font-bold leading-tight outline-none [field-sizing:content] placeholder:text-muted-foreground/50"
    />
  );
}

function EditableTitle({
  environmentId,
  page,
  current,
  owner,
  autoFocus,
}: {
  environmentId: EnvironmentId;
  page: SpacePageSummary;
  current: () => boolean;
  owner: SpaceRootReorder;
  autoFocus: boolean;
}) {
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const availability = useSpacesAvailability(environmentId);
  const allowed = useAtomValue(spacesEnvironment.updatePage.permissionAtom(environmentId));
  const [edit, setEdit] = useState<{ base: string; value: string; saved: boolean } | null>(null);
  const cancelled = useRef(false);
  const shown = edit && edit.base === page.title ? edit.value : page.title;
  const writable = allowed && availability === "writable";
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return setEdit(null);
    }
    if (!edit || edit.saved || edit.base !== page.title) return setEdit(null);
    const value = edit.value.trim();
    if (value === page.title || !current() || snapshot.busy || snapshot.journal.pending)
      return setEdit(null);
    setEdit({ ...edit, value, saved: true });
    owner.renamePage(page, value).catch((error: unknown) => {
      setEdit(null);
      toastManager.add({
        type: "error",
        title: "Couldn't rename page",
        description: error instanceof Error ? error.message : undefined,
      });
    });
  };
  return (
    <TitleInput
      page={page}
      value={shown}
      readOnly={!writable}
      autoFocus={autoFocus}
      onChange={(value) => setEdit({ base: page.title, value, saved: false })}
      onCommit={commit}
      onCancel={() => {
        cancelled.current = true;
        setEdit(null);
      }}
    />
  );
}

function Library({ environmentId, spaceId, owner }: Props & { owner: SpaceRootReorder }) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [title, setTitle] = useState("");
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const availability = useSpacesAvailability(environmentId);
  const readable = canBrowseSpaces(availability);
  const renameSpace = useAtomValue(spacesEnvironment.renameSpace.permissionAtom(environmentId));
  const setDefault = useAtomValue(spacesEnvironment.setDefaultSpace.permissionAtom(environmentId));
  const selected = useEnvironmentQuery(
    readable
      ? spacesEnvironment.pages({ environmentId, input: { environmentId, spaceId, limit: 1 } })
      : null,
  );
  const catalog = useEnvironmentQuery(
    readable ? spacesEnvironment.list({ environmentId, input: { environmentId, limit: 1 } }) : null,
  );
  const defaultId =
    catalog.isSuccess && !catalog.isPending ? catalog.data?.defaultSpaceId : undefined;
  const previous = useEnvironmentQuery(
    readable && defaultId
      ? spacesEnvironment.pages({
          environmentId,
          input: { environmentId, spaceId: defaultId, limit: 1 },
        })
      : null,
  );
  const space = selected.isSuccess && !selected.isPending ? selected.data?.space : undefined;
  const defaultSpace = previous.isSuccess && !previous.isPending ? previous.data?.space : undefined;
  // oxlint-disable-next-line t2code/react-effect-budget -- Load the same durable operation journal used by page placement before enabling library commands.
  useEffect(() => {
    run(owner.hydrate());
  }, [owner]);
  const { journal, busy, hydrated } = snapshot;
  const pending = journal.pending;
  const blocked = busy || !hydrated || !!pending || availability !== "writable";
  const choose = (value: Intent, initial = "") => {
    setIntent(value);
    setTitle(initial);
    setOpen(true);
  };
  const allowed = intent?.kind === "renameSpace" ? renameSpace : setDefault;
  const submit = async () => {
    if (!intent || blocked || !allowed) return;
    try {
      if (intent.kind === "renameSpace") await owner.renameSpace(intent.space, title.trim());
      else await owner.setDefaultSpace(intent.space, intent.previous);
      setOpen(false);
      setIntent(null);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't update space",
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button variant="ghost" size="icon-xs" aria-label="Space actions" />}
              />
            }
          >
            <EllipsisIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Space actions</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <MenuItem
            disabled={blocked || !renameSpace || !space}
            onClick={() => {
              if (space) choose({ kind: "renameSpace", space }, space.title);
            }}
          >
            Rename space…
          </MenuItem>
          {space &&
          !space.isDefault &&
          defaultSpace &&
          setDefault &&
          availability === "writable" ? (
            <MenuItem
              disabled={blocked}
              onClick={() => choose({ kind: "setDefaultSpace", space, previous: defaultSpace })}
            >
              Make default space…
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setIntent(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {intent?.kind === "setDefaultSpace" ? "Make default space" : "Rename space"}
            </DialogTitle>
            {intent?.kind === "setDefaultSpace" ? (
              <DialogDescription>
                Make {intent.space.title || "Untitled space"} the default instead of{" "}
                {intent.previous.title || "Untitled space"}? Both spaces and their pages stay.
              </DialogDescription>
            ) : (
              <DialogDescription>Choose a new name for this space.</DialogDescription>
            )}
          </DialogHeader>
          <DialogPanel>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                run(submit());
              }}
            >
              {intent?.kind === "renameSpace" ? (
                <Input
                  autoFocus
                  aria-label="Space title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              ) : null}
              <Button
                type="submit"
                disabled={blocked || !allowed || (intent?.kind === "renameSpace" && !title.trim())}
              >
                {intent?.kind === "setDefaultSpace" ? "Make default" : "Save"}
              </Button>
            </form>
            {pending ? (
              <div className="mt-3 space-y-2">
                <p role="status" className="text-sm text-muted-foreground">
                  A previous change is still waiting to be confirmed.
                </p>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !hydrated ||
                    !readable ||
                    (pending.conflict && availability !== "writable")
                  }
                  onClick={() => run(pending.conflict ? owner.reinspect() : owner.recover())}
                >
                  {pending.conflict ? "Dismiss" : "Finish it"}
                </Button>
              </div>
            ) : null}
            {!hydrated && snapshot.error ? (
              <Button
                className="mt-3"
                variant="outline"
                disabled={busy}
                onClick={() => run(owner.hydrate())}
              >
                Retry
              </Button>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
