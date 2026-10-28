import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceId, SpacePageSummary, SpaceSummary } from "@t2code/contracts/spaces";
import type { SpaceRootReorder } from "@t2code/client-runtime/spaces";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import { useEnvironmentQuery } from "../state/query";
import { spacesEnvironment, useSpacesAvailability } from "../state/spaces";
import { PencilIcon, PlusIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { Input } from "../components/ui/input";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { spaceRootReorder } from "./sessionRuntime";

interface Props {
  environmentId: EnvironmentId;
  spaceId: SpaceId;
  page?: SpacePageSummary;
  current?: () => boolean;
}
type Intent =
  | { kind: "createSpace" }
  | { kind: "createPage"; space: SpaceSummary }
  | { kind: "renameSpace"; space: SpaceSummary }
  | { kind: "setDefaultSpace"; space: SpaceSummary; previous: SpaceSummary }
  | { kind: "updatePage"; page: SpacePageSummary };
const run = (work: Promise<unknown>) => {
  void work.catch(() => {});
};

export default function SpaceLibraryControls(props: Props) {
  const registry = useContext(RegistryContext);
  const [result] = useState(() => {
    try {
      return { owner: spaceRootReorder(registry, props.environmentId) };
    } catch (error) {
      return { error };
    }
  });
  if (!result.owner)
    return (
      <p role="alert">
        {result.error instanceof Error ? result.error.message : "Library storage unavailable."}
      </p>
    );
  return <Library {...props} owner={result.owner} />;
}
function Library({
  environmentId,
  spaceId,
  page,
  current,
  owner,
}: Props & { owner: SpaceRootReorder }) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [title, setTitle] = useState("");
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const availability = useSpacesAvailability(environmentId);
  const readable = canBrowseSpaces(availability);
  const newSpace = useAtomValue(spacesEnvironment.createSpace.permissionAtom(environmentId));
  const renameSpace = useAtomValue(spacesEnvironment.renameSpace.permissionAtom(environmentId));
  const setDefault = useAtomValue(spacesEnvironment.setDefaultSpace.permissionAtom(environmentId));
  const newPage = useAtomValue(spacesEnvironment.createPage.permissionAtom(environmentId));
  const renamePage = useAtomValue(spacesEnvironment.updatePage.permissionAtom(environmentId));
  const selected = useEnvironmentQuery(
    open && readable && !page
      ? spacesEnvironment.pages({ environmentId, input: { environmentId, spaceId, limit: 1 } })
      : null,
  );
  const catalog = useEnvironmentQuery(
    open && readable && !page
      ? spacesEnvironment.list({ environmentId, input: { environmentId, limit: 1 } })
      : null,
  );
  const defaultId =
    catalog.isSuccess && !catalog.isPending ? catalog.data?.defaultSpaceId : undefined;
  const previous = useEnvironmentQuery(
    open && readable && defaultId && !page
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
  const blocked =
    busy || !hydrated || !!pending || availability !== "writable" || (!!current && !current());
  const choose = (value: Intent, initial = "") => {
    setIntent(value);
    setTitle(initial);
  };
  const allowed =
    intent?.kind === "createSpace"
      ? newSpace
      : intent?.kind === "renameSpace"
        ? renameSpace
        : intent?.kind === "setDefaultSpace"
          ? setDefault
          : intent?.kind === "createPage"
            ? newPage
            : renamePage;
  const submit = async () => {
    if (!intent || blocked || !allowed || (current && !current())) return;
    if (intent.kind === "createSpace") await owner.createSpace(title);
    else if (intent.kind === "renameSpace") await owner.renameSpace(intent.space, title);
    else if (intent.kind === "setDefaultSpace")
      await owner.setDefaultSpace(intent.space, intent.previous);
    else if (intent.kind === "createPage") await owner.createRootPage(intent.space, title);
    else await owner.renamePage(intent.page, title);
    setIntent(null);
  };
  const result = snapshot.libraryResult;
  return (
    <>
      {page ? (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <PencilIcon />
          Rename
          <span className="sr-only"> page…</span>
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Create and manage…"
                onClick={() => setOpen(true)}
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Create and manage…</TooltipPopup>
        </Tooltip>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setIntent(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>{page ? "Page title" : "Space library"}</DialogTitle>
          <DialogDescription>
            Changes use the details selected here. If another device changes them, refresh and
            choose again. Resolve affected page drafts first. Metadata changes have no Undo. The
            default space cannot be deleted.
          </DialogDescription>
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              {page ? (
                <Button
                  variant="outline"
                  disabled={blocked || !renamePage || !!page.trash}
                  onClick={() => choose({ kind: "updatePage", page }, page.title)}
                >
                  Rename {page.title || "Untitled page"}
                </Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={blocked || !newSpace}
                    onClick={() => choose({ kind: "createSpace" })}
                  >
                    New space
                  </Button>
                  <Button
                    variant="outline"
                    disabled={blocked || !newPage || !space}
                    onClick={() => {
                      if (space) choose({ kind: "createPage", space });
                    }}
                  >
                    New root page
                  </Button>
                  <Button
                    variant="outline"
                    disabled={blocked || !renameSpace || !space}
                    onClick={() => {
                      if (space) choose({ kind: "renameSpace", space }, space.title);
                    }}
                  >
                    Rename space
                  </Button>
                  <Button
                    variant="outline"
                    disabled={blocked || !setDefault || !space || space.isDefault || !defaultSpace}
                    onClick={() => {
                      if (space && defaultSpace)
                        choose({ kind: "setDefaultSpace", space, previous: defaultSpace });
                    }}
                  >
                    Make default space
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || !readable}
                    onClick={() => {
                      selected.refresh();
                      catalog.refresh();
                      previous.refresh();
                    }}
                  >
                    Refresh library metadata
                  </Button>
                </>
              )}
            </div>
            {intent ? (
              <div className="space-y-2">
                {intent.kind === "setDefaultSpace" ? (
                  <p>
                    Make {intent.space.title || "Untitled space"} the default instead of{" "}
                    {intent.previous.title || "Untitled space"}? This changes the environment's
                    default; both spaces and their pages remain.
                  </p>
                ) : (
                  <label>
                    {intent.kind === "createSpace"
                      ? "New space title"
                      : intent.kind === "createPage"
                        ? "New root page title"
                        : "New title"}
                    <Input value={title} onChange={(event) => setTitle(event.target.value)} />
                  </label>
                )}
                <Button
                  variant="outline"
                  disabled={blocked || !allowed}
                  onClick={() => run(submit())}
                >
                  {intent.kind === "setDefaultSpace"
                    ? "Confirm default space"
                    : intent.kind === "createSpace"
                      ? "Create space"
                      : intent.kind === "createPage"
                        ? "Create root page"
                        : "Confirm rename"}
                </Button>
              </div>
            ) : null}
            {pending ? (
              <div className="space-y-2">
                <p role="status">
                  Retained {pending.request.operation}.{" "}
                  {pending.rejection
                    ? "The server refused this intent before commit. Inspect explicitly to choose a new intent."
                    : pending.conflict
                      ? "Conflicted. Inspect explicitly to choose a new intent."
                      : "Resolve the exact receipt before changing affected pages."}
                </p>
                {"title" in pending.request.input ? (
                  <p>Attempted title: {pending.request.input.title || "(empty title)"}</p>
                ) : null}
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
                  {pending.conflict ? "Inspect new intent" : "Recover exact receipt"}
                </Button>
              </div>
            ) : null}
            {!hydrated && snapshot.error ? (
              <Button variant="outline" disabled={busy} onClick={() => run(owner.hydrate())}>
                Retry library storage
              </Button>
            ) : null}
            {snapshot.notice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {snapshot.notice}
              </p>
            ) : null}
            {result?.page ? (
              <Link
                to="/spaces/$environmentId/$spaceId/$pageId"
                params={{ environmentId, spaceId: result.page.spaceId, pageId: result.page.id }}
                search={{}}
                className="underline"
              >
                Open {result.page.title || "Untitled page"}
              </Link>
            ) : result?.space ? (
              <Link
                to="/spaces/$environmentId/$spaceId"
                params={{ environmentId, spaceId: result.space.id }}
                className="underline"
              >
                Open {result.space.title || "Untitled space"}
              </Link>
            ) : null}
            {snapshot.error ? (
              <p role="alert">
                {snapshot.error instanceof Error
                  ? snapshot.error.message
                  : "Library operation failed; retained data has been kept."}
              </p>
            ) : null}
            {selected.error || catalog.error || previous.error ? (
              <p role="alert">{selected.error || catalog.error || previous.error}</p>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
