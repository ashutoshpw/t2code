# Identity, references, drafts, and recovery

These are proposed invariants for review before implementation. They depend on the concurrency, history, and retention choices in [decisions.md](decisions.md).

## Block identity and mutation semantics

| Operation | Proposed identity behavior |
| --- | --- |
| Split | Keep the original ID on the first resulting part; create a new ID for the second. |
| Join | Keep the first block's ID; retire/tombstone the second with an explicit merged-link outcome. Never silently retarget its links. |
| Type conversion | Preserve the ID when the converted type can represent the same logical content. |
| Wrap in a container | Add a new container ID and preserve existing child IDs. |
| Copy or duplicate | Regenerate IDs throughout the copied subtree and remap references internal to that subtree. |
| Cut/move | Use an explicit server move operation that preserves IDs. Do not trust IDs supplied by arbitrary clipboard data. |

Undo applies to local-origin operations, not remote edits. Undoing an acknowledged server revision is a guarded compensating mutation against the exact revisions observed; a stale or structurally changed target conflicts instead of erasing newer work. This is local editor undo, distinct from restoring a historical page revision.

Restore a historical revision as a new revision after validating current ownership and structure; do not blindly replace a snapshot. If a nested page moved from page A to page B after the selected history point, restoring A must not steal it back or create duplicate ownership. Recommend rejecting that structural conflict and offering a checked restore-as-copy or selected-content restore. Apply the same rule to ordinary blocks moved between pages.

Resolve links by environment and stable block ID, with page/space IDs as navigation hints. A moved block/page resolves to its current location only after current authorization. Titles, stale hints, previous access, or a previously signed URL do not grant access. Retired, deleted, disabled, disconnected, and unauthorized references need explicit outcomes.

Trash is a reversible soft delete of a page and its nested subtree. Restore must validate current ownership and never leave the environment without its protected default space.

## Revisions and idempotency

- A bounded mutation carries expected revisions for all affected pages and containing spaces/root orders. Check revisions, cycles, and destination authorization in the same transaction. On a conflict, change nothing and return enough latest state to keep the client's draft.
- Reject an oversized subtree move atomically and unchanged; never turn it into implicit chunks or partial success.
- Scope an idempotency key to environment and operation, and to the caller where authorization or replay isolation requires it. Persist a request fingerprint and final result. A successful replay returns the original result before stale-revision checks; reusing the key with a different fingerprint fails.
- Reuse the existing server command-receipt pattern where suitable; the receipt is the basis for resolving an uncertain client retry.

T2's [EventSink receipt lookup and stored-result replay](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/server/src/orchestration-v2/EventSink.ts#L611-L625) is the source pattern to inspect during implementation.

## Chat context and historical navigation

Commit each sent message's bounded context snapshot with source IDs, source revisions, and a content hash. The selected page/block excerpt is needed for the prompt and may be retained under existing chat/provider persistence; this does not make chat storage a second full document store.

A bounded prompt snapshot can avoid retaining a complete historical page revision. Separately decide whether users must navigate the original full source after edits. Only if that is required, add a durable cross-database retention handoff with explicit states for requested, acquired, committed, released, and recovery-needed outcomes. A timeout or ambiguous message commit must not release a lease until the message outcome is resolved.

Define how retention roots behave for queued sends, forks, rollback, message deletion, and failed handoffs. Do not assume transactions span the chat and Spaces databases. For child-page inclusion, require explicit opt-in and record a vector of included source revisions; a parent revision alone does not pin child content.

## Durable client drafts

Persist drafts with environment, page, base revision, mutation ID, generation, content, and local asset handles. Hydrate before allowing a write. Clear only the generation acknowledged by the server; typing after that acknowledgement remains dirty.

Save durably on foreground edits. Suspension-time saves are best effort. On reconnect, query the mutation receipt before retrying an uncertain operation. Show local-draft, server-saved, and failed/conflicted states separately. Define draft expiry and device storage policy; do not promise offline synchronization unless separately approved.

## Upload and asset publication recovery

- Create durable upload sessions with reserved capacity, idempotent finalize, status, cancel, expiry, and recovery for unknown completion. Define a bounded restart window for smaller uploads and the threshold for resumable large video transfers during feasibility; size and quota limits remain unselected.
- Bound transfer concurrency. Stream and hash incrementally; do not buffer or hash an entire large file in memory.
- Model publication as verified staged bytes, published immutable file, then ready metadata. Filesystem publication and SQLite commit are not atomic together. Reconcile incomplete states at startup and make finalize/retry idempotent.
- Preserve originals. Validate MIME by content and enforce current environment authorization, quotas, and selected limits.

Issue scoped, expiring URLs only after authorization, and authorize every new HTTP request again. Support bounded URL renewal for an existing environment/asset while a player preserves its playback position; new range requests require current authorization. Proposed revocation behavior: an already-open response may finish only its bounded response, while new requests are denied.

Specify and verify `HEAD`, `206`, `416`, and `If-Range` behavior, including remote and tunnel paths. PDF preview support is platform-dependent and needs a download fallback. Do not assume a URL remains valid for the entire playback or that all clients render the same media.

## Reference-aware cleanup and backup

Serialize asset reference creation against deletion eligibility. Delay garbage collection, then revalidate and tombstone under the same ownership rules before deleting bytes. Account for live blocks, retained revisions, trash retention, pending reference leases, recoverable uploads, and active backups. A shared blob is collectible only when no protecting root references it.

Pin the asset set for a backup snapshot. Copy immutable files and record verified sizes/digests in a completion manifest. Validate the manifest, database snapshot, and every referenced asset in staging before swapping a restore into service. Never imply a filesystem/database atomic transaction. Include temporary uploads, revisions, backups, and retained history when reporting disk usage.
