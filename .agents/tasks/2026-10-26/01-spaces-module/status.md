# Status

- **State:** planned
- **Updated:** 2026-10-26

## Notes

- Revised after a review against the code:
  - Media now uses the existing signed asset route.
  - Spaces has its own idempotency table, migrator, and DB tag.
  - Routes moved to `/spaces/...?block=`.
  - Mobile editing is now native new work.
  - Backup/restore, resumable uploads, and historical retention are deferred out of v1.
- Settled: no real-time co-editing; the v1 block set is fixed; mobile edits a smaller core set.
- Product implementation awaits express user approval. Five smaller decisions stay open, each tied to a layer.
- Plan-only PR is authorized.
