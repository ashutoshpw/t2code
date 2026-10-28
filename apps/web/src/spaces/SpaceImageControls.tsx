import { useState, useSyncExternalStore } from "react";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { AuthOrchestrationOperateScope } from "@t2code/contracts";
import type { SpaceImageInsertion, SpaceImageUploads } from "@t2code/client-runtime/spaces";
import { ImageIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";

export function SpaceImageControls({
  owner,
  insertion,
  current,
  replacementTarget,
}: {
  owner: SpaceImageUploads;
  insertion: SpaceImageInsertion;
  current: () => boolean;
  replacementTarget: import("@t2code/contracts/spaces").SpaceBlockId | null;
}) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const capability = useEnvironment(insertion.key.environmentId)?.serverConfig?.environment
    .capabilities.spaces;
  const operate = useEnvironmentScope(insertion.key.environmentId, AuthOrchestrationOperateScope);
  const supported =
    capability?.version === 2 && capability.features?.assets === true && !!capability.limits.assets;
  const writable = supported && operate && current();
  const records = state.records.filter(
    (r) =>
      r.key.environmentId === insertion.key.environmentId && r.key.pageId === insertion.key.pageId,
  );
  const run = (operation: Promise<unknown>) => {
    setLocalError(null);
    void operation.catch(setLocalError);
  };
  const error = localError ?? state.error;
  if (!supported) return null;
  const attach = (replace: boolean) => {
    if (!file || !current()) return;
    const upload = file;
    run(
      (async () => {
        await (replace && replacementTarget
          ? owner.addReplacement(insertion, replacementTarget, upload, upload.name)
          : owner.add(insertion.key, upload, upload.name));
        setFile(null);
        const record = owner
          .getSnapshot()
          .records.findLast(
            (r) =>
              r.key.pageId === insertion.key.pageId &&
              r.phase === "original" &&
              r.intent.name === upload.name,
          );
        if (!record) return;
        await owner.upload(record.id);
        await owner.insert(record.id, insertion);
        setOpen(false);
      })(),
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" onMouseDown={(event) => event.preventDefault()} />
        }
      >
        <ImageIcon />
        Media
      </PopoverTrigger>
      <PopoverPopup align="end" width="md">
        <div className="space-y-3 text-sm">
          <label className="block space-y-1">
            <span className="font-medium">Upload image, PDF or video</span>
            <Input
              key={state.records.length}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,video/mp4,video/webm"
              disabled={!writable || state.busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setLocalError(null);
              }}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!file || !writable || state.busy || !state.hydrated}
              onClick={() => attach(false)}
            >
              {state.busy ? "Uploading…" : "Upload"}
            </Button>
            {replacementTarget ? (
              <Button
                variant="outline"
                size="sm"
                disabled={
                  !file || !writable || state.busy || !state.hydrated || !!insertion.state().pending
                }
                onClick={() => attach(true)}
              >
                Replace selected media
              </Button>
            ) : null}
            {state.busy ? (
              <Button variant="ghost" size="sm" onClick={() => owner.abort()}>
                Cancel
              </Button>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-destructive-foreground">
              {error instanceof Error ? error.message : String(error)}
            </p>
          ) : null}
          {records.map((record) => (
            <div key={record.id} className="space-y-2 border-t pt-3">
              <p>
                {record.intent.name}
                {record.phase === "drafted" ? " was added. Save the page to finish." : null}
                {record.phase === "ready" || record.phase === "preparing"
                  ? " is uploaded but not yet added to the page."
                  : null}
                {["original", "minting", "upload"].includes(record.phase)
                  ? " has not finished uploading."
                  : null}
              </p>
              <div className="flex flex-wrap gap-2">
                {["original", "upload", "minting"].includes(record.phase) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!writable || state.busy}
                    onClick={() => run(owner.upload(record.id))}
                  >
                    Retry upload
                  </Button>
                ) : null}
                {["ready", "preparing"].includes(record.phase) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!writable || state.busy}
                    onClick={() => run(owner.insert(record.id, insertion))}
                  >
                    {record.replacement ? "Replace media" : "Add to page"}
                  </Button>
                ) : null}
                {error && record.handle ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!current() || state.busy}
                    onClick={() => run(owner.recover(record.id))}
                  >
                    Check upload
                  </Button>
                ) : null}
                {error &&
                !["original", "minting", "preparing"].includes(record.phase) &&
                !insertion.state().pending ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!writable || state.busy}
                    onClick={() => run(owner.newAttempt(record.id, insertion))}
                  >
                    Upload again
                  </Button>
                ) : null}
                {record.phase === "preparing" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!writable || state.busy}
                    onClick={() => run(owner.reselectPlacement(record.id, insertion))}
                  >
                    Choose placement again
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={state.busy || ["minting", "preparing"].includes(record.phase)}
                  onClick={() => run(owner.release(record.id, insertion))}
                >
                  Discard
                </Button>
              </div>
            </div>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
