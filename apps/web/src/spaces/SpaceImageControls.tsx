import { useState, useSyncExternalStore } from "react";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { AuthOrchestrationOperateScope } from "@t2code/contracts";
import type { SpaceImageInsertion, SpaceImageUploads } from "@t2code/client-runtime/spaces";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

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
  if (!supported) return <p>Media uploads are not advertised by this environment.</p>;
  return (
    <section aria-label="Page media" className="space-y-2">
      <p>
        Media originals share two local slots and 75 MiB total (image 10 MiB, PDF 25 MiB, video 50
        MiB). They remain until saved or explicitly released. Upload cancellation does not delete
        remote bytes.
      </p>
      <label>
        Choose image, PDF or video
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
      <Button
        variant="outline"
        disabled={!file || !writable || state.busy || !state.hydrated}
        onClick={() => {
          if (!file || !current()) return;
          setLocalError(null);
          run(
            owner.add(insertion.key, file, file.name).then(() => {
              setFile(null);
            }),
          );
        }}
      >
        Keep original locally
      </Button>
      <Button
        variant="outline"
        disabled={
          !file ||
          !replacementTarget ||
          !writable ||
          state.busy ||
          !state.hydrated ||
          !!insertion.state().pending
        }
        onClick={() => {
          if (!file || !replacementTarget || !current()) return;
          run(
            owner
              .addReplacement(insertion, replacementTarget, file, file.name)
              .then(() => setFile(null)),
          );
        }}
      >
        Keep original to replace selected media
      </Button>
      <p>
        Choose a saved known media block to replace it. Its ID, placement and rich caption remain;
        changed targets require a new explicit attempt.
      </p>
      {file ? <p>{file.name} is selected but not yet stored.</p> : null}
      {state.busy ? <p role="status">Finishing one media operation…</p> : null}
      {state.busy ? (
        <Button variant="outline" onClick={() => owner.abort()}>
          Abort active byte upload
        </Button>
      ) : null}
      {error ? <p role="alert">{error instanceof Error ? error.message : String(error)}</p> : null}
      {records.map((record) => (
        <div key={record.id} className="space-y-2">
          <p>
            {record.intent.name} ·{" "}
            {record.replacement ? `Replacement for ${record.replacement.before.id}` : "New media"} ·{" "}
            {
              {
                original: "Stored locally",
                minting: "Upload reply unresolved",
                upload: "Upload retained",
                ready: "Ready to insert",
                preparing: "Insertion needs recovery",
                drafted: "Media draft ready",
              }[record.phase]
            }{" "}
            · original retained
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!writable || state.busy || ["preparing", "drafted"].includes(record.phase)}
              onClick={() => run(owner.upload(record.id))}
            >
              Upload / retry original
            </Button>
            <Button
              variant="outline"
              disabled={!current() || state.busy || !record.handle}
              onClick={() => run(owner.recover(record.id))}
            >
              Check original upload
            </Button>
            {["ready", "preparing"].includes(record.phase) ? (
              <Button
                variant="outline"
                disabled={!writable || state.busy}
                onClick={() => run(owner.insert(record.id, insertion))}
              >
                {record.phase === "preparing"
                  ? "Finish retained insertion"
                  : record.replacement
                    ? "Apply retained replacement"
                    : "Insert media at page end"}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={
                !writable ||
                state.busy ||
                ["original", "minting", "preparing"].includes(record.phase) ||
                !!insertion.state().pending
              }
              onClick={() => run(owner.newAttempt(record.id, insertion))}
            >
              Upload a NEW copy
            </Button>
            <Button
              variant="outline"
              disabled={state.busy || ["minting", "preparing"].includes(record.phase)}
              onClick={() => run(owner.release(record.id, insertion))}
            >
              Release local original
            </Button>
          </div>
          {record.phase === "preparing" ? (
            <Button
              variant="outline"
              disabled={!writable || state.busy}
              onClick={() => run(owner.reselectPlacement(record.id, insertion))}
            >
              Release unused placement and choose again
            </Button>
          ) : null}
          {record.phase === "drafted" ? (
            <p>
              Save the page draft. Release verifies the acknowledged media or an unsent removal;
              unresolved receipts retain the original.
            </p>
          ) : null}
          {record.phase === "minting" ? (
            <p>
              A missing mint reply can only be retried with the same live caller. Reconnect/reload
              cannot prove that caller without a known upload handle.
            </p>
          ) : null}
        </div>
      ))}
      {state.records
        .filter((r) => !records.includes(r))
        .map((r) => (
          <p key={r.id}>
            Another original is retained for page {r.key.pageId} in environment{" "}
            {r.key.environmentId}. Open that page to resolve it.
          </p>
        ))}
    </section>
  );
}
