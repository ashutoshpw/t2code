# Decisions

## Settled

| Topic | Decision |
| --- | --- |
| Concurrency | Optimistic revisions; there is no real-time co-editing. Each write states the revisions it expects, and a stale write fails with a conflict while the client keeps the user's draft. MCP edits use the same rule. |
| v1 block set | Text, list, code, divider, media, and child-page blocks, defined in [blocks-editing.md](blocks-editing.md). Tables, toggles, columns, databases, comments, and embeds are deferred. |
| Mobile editing | Mobile edits a smaller core set and renders every v1 block type, as set out in [blocks-editing.md](blocks-editing.md). Mobile is not read-only as a whole. A block mobile cannot edit is read-only there, and its content is never stripped. |
| Chat references | Each send stores a bounded snapshot of the referenced content, with source IDs, revisions, and a content hash. The link opens the current page, not the historical version. |
| Default space | Created automatically per environment. It can be renamed but not deleted, so the environment always has one. |
| Storage | `spaces.sqlite` sits beside `statev2.sqlite` in the configured userdata directory. Asset bytes go under `<userdata>/spaces/assets/`. |
| Feature toggle | A server setting, off by default and shown in Settings. Turning it off keeps all data. |
| Delivery | Seven stacked PRs to `ashutoshpw/t2code`, built in sibling worktrees; see [delivery.md](delivery.md). |
| Markdown | Import/export is optional and lossy. Markdown is not the stored format. |

## Out of v1

These are deferred to keep v1 small. The schema must not rule them out.

- Real-time co-editing and offline synchronization.
- Viewing or restoring the full historical source behind an old chat reference, and the cross-database retention this would need.
- Spaces backup/restore. The `doctor` command and storage reporting still need to account for `spaces.sqlite` and its assets.
- Resumable uploads. v1 uses single-request staged uploads, capped in size.
- OCR, PDF text extraction, transcription, and transcoding.
- Private spaces and per-space ACLs.

## Open (decide before the affected layer)

| # | Question | Recommendation | Needed by |
| --- | --- | --- | --- |
| 1 | Mobile disconnected behavior | Online-first. Drafts survive app restarts and reconnects, and an uncertain save is checked against its receipt before retrying. No offline sync promise. | Layer 7 |
| 2 | RPC scopes | Reuse `orchestration:read` for reads and `orchestration:operate` for writes in v1. A client that can operate already runs agents with filesystem access, so a separate scope adds little security. Add `spaces:*` scopes only if a real use for keeping them separate appears. | Layer 2 |
| 3 | Page history UI | v1 keeps revisions for conflict handling and local undo, and has trash/restore. Leave the browse-and-restore UI for revisions out of v1; the restore rules in [identity-recovery.md](identity-recovery.md) still apply if it is added later. | Layer 5 |
| 4 | How old references render when Spaces is off | Show the chip using the stored snapshot title, marked unavailable. Keep the snapshot text that was sent. | Layer 6 |
| 5 | Numeric budgets | Set them during feasibility (see [validation.md](validation.md)). Chat limits are 10 MiB per image (80 MiB total) and 50 MiB per file; these do not carry over to Spaces, and video needs its own cap. | Layer 1 |
