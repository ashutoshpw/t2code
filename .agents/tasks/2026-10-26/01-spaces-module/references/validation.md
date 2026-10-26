# Feasibility and validation

This work is for after express implementation approval. The current task makes no prototype, schema, product code, build, install, server, browser, or test changes.

## First-layer editor and native feasibility gate

Before freezing the canonical schema, build a bounded adapter prototype around a dedicated Spaces schema. Check stable IDs and structural transactions across split, join, wrap, copy, explicit move, paste, IME composition, selection, and undo. Verify save acknowledgements, dirty drafts, concurrent MCP edits, and two views of the same page. The prototype is a feasibility layer, not approval to expand product scope.

At the same gate, compare the schema with native mobile capabilities and decide how unknown/future blocks survive on every surface. Preserve unknown content or show it read-only; never drop it. A paginated editor must not treat unloaded blocks as deletions. If the prototype or native compatibility fails, revise the contract before storage schema work.

## Resource budget worksheet

Set numeric targets during the approved feasibility layer; do not invent them in the plan. Record deterministic limits for:

- library list rows and serialized bytes;
- per-page block windows and response bytes;
- mutation nodes and encoded bytes;
- client cache bytes;
- upload concurrency, transfer sizes, and resumable-upload threshold;
- media decoder memory, decoded image pixels, and active previews;
- recovery, reindex, cleanup, backup, and restore batch sizes.

Measure timings against named representative device profiles and local, remote, and tunnel profiles, then record the actual results. Avoid unbounded library reads, full-space rescans, eager rendering of every asset, whole-file memory buffers, and background OCR or transcoding without an approved budget.

## Validation plan after implementation approval

- Test boundaries deterministically at configured row, byte, node, cache, concurrency, decoder, and maintenance limits. Exercise one-over-limit rejection without partial mutations.
- Verify paginated library loading, empty/error/retry states, virtualization, and cache keys containing environment, space, query, and revision. Discard stale responses after environment/space/query changes.
- Cover ownership, root ordering, nested-page authority, uniqueness, cycles, atomic moves, revision guards, identity rules, idempotent replay, conflict draft preservation, and checked restore behavior.
- Cover upload interruption, unknown finalize outcome, MIME mismatch, authorization changes, range requests, URL renewal, expiry, remote/tunnel access, cleanup races, backups, and staged restore validation.
- Check disabled-by-default capability behavior at every merged layer, older-client handling, settings UI, and retained data.
- Integrate web, desktop, and mobile across the approved core block set and media matrix. Include native navigation/edit behavior, unknown blocks, thread-panel presentation, deep links, hidden rails, and return to the last chat location.
- Verify chat snapshots, revision metadata, child-page opt-in/revision vectors, handoff recovery if full historical navigation is approved, and MCP parity with service authorization and bounds.

The release matrix and all numeric limits remain pending product decisions. No check in this list is performed during this documentation review.
