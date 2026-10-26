# Identity, revisions, and recovery

## Block identity

| Operation | Identity behavior |
| --- | --- |
| Split | The first part keeps the original ID; the second part gets a new ID. |
| Join | The first block keeps its ID. The second is tombstoned with a `merged_into` link, so its references resolve to the survivor rather than being retargeted silently. |
| Type conversion | Keeps the ID when the new type can hold the same content, which covers text↔heading↔list↔quote. |
| Indent/outdent | Keeps IDs; the block changes parent or rank. |
| Copy/duplicate | Generates new IDs for the whole copied subtree and remaps references inside it. |
| Cut/move | Handled as an explicit server move that keeps IDs. IDs found in clipboard data are never trusted. |

Undo covers only local operations. Undoing a change the server has already acknowledged is a guarded compensating mutation against the exact revisions observed. If the target has since changed, it fails with a conflict instead of erasing newer work.

## Revisions and conflicts

- A batch carries the expected revision of every affected page and space-root order. Revisions, cycles, and authorization are checked in one transaction. On a conflict, nothing changes, and the response includes enough current state for the client to keep and rebase its draft.
- A subtree move over the limit is rejected whole. It is never split into implicit chunks or allowed to partly succeed.
- MCP and agent edits follow the same rules. An agent edit that conflicts with an open draft shows up as a conflict in that client; nothing is merged silently.
- Revision retention is bounded by the budget set in feasibility. Retained revisions protect their assets from cleanup.

## Idempotency

- Each mutation carries a client-generated `mutationId`. The `idempotency` table in `spaces.sqlite` stores environment, operation, `mutationId`, a request fingerprint, the resulting revision, and the response. It is written in the same transaction as the mutation.
- A replay with the same fingerprint returns the stored response before the stale-revision check runs. The same `mutationId` with a different fingerprint fails.
- After a reconnect, clients look up the `mutationId` before retrying an uncertain save. Expire records after a bounded window, sized during feasibility.

## Trash and restore

- Trash is a reversible soft delete of a page and its nested subtree. Restore creates a new revision after checking current ownership: if the parent `child_page` block is gone, the page restores to the space root.
- Trash is emptied explicitly. Permanent deletion releases asset references for cleanup ([media-assets.md](media-assets.md)).
- The default space cannot be deleted.
- If revision restore is added later (see [decisions.md](decisions.md)), it must check structure. A nested page or block that moved elsewhere after the chosen point is not pulled back. The restore offers restore-as-copy instead.

## Resolving references

- Links resolve by environment and stable ID. Page and space IDs are navigation hints only.
- A moved block or page resolves to its current location, and only after authorization. A stale title, stale hint, or expired URL does not grant access.
- Tombstoned (merged), trashed, deleted, disabled, disconnected, and unauthorized targets each have a defined outcome in the UI and in MCP.

## Chat snapshots

- Each sent message commits its bounded context snapshot, with source IDs, revisions, and a content hash, through the existing chat context-record persistence.
- This does not make chat a second document store. Opening the reference shows the current page.
- Historical-source navigation and cross-database retention are out of v1.
