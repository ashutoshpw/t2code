# Feasibility and validation

None of this work starts before express implementation approval. Authoring this plan involved no prototype, product code, build, server, or test runs.

## Layer 1 feasibility gate

**Web adapter.** Prototype the dedicated Tiptap schema for the v1 block set and check that it keeps stable IDs through:

- split, join, wrap, copy, explicit move, and paste;
- IME composition, selection, and undo.

Also verify save acknowledgements, dirty drafts, a concurrent MCP edit, and two views of the same page. A paginated editor must not treat unloaded blocks as deleted.

**Mobile editor.** Build a spike on iOS and Android of one native text input per focused block, editing paragraph, heading, and list items:

- bold, italic, and inline code must round-trip, and links must be preserved;
- the keyboard must behave across block boundaries;
- a virtualized list must stay smooth on a long page.

If mark preservation fails, evaluate the WebView+Tiptap fallback. Record which choice was made and why.

**Media.** Choose one PDF preview path per platform. Confirm that range seeking works through the existing asset route, both on the local path and on the tunnel path.

If any part fails, revise the contract before the schema work in layer 2.

## Resource budgets (set during layer 1)

Record numeric limits for each of these:

- library rows and payload bytes;
- per-page block window and response bytes;
- mutation nodes and bytes;
- nesting depth;
- client cache bytes and draft size;
- upload caps per media type and the environment quota;
- upload concurrency;
- decoded image pixels and active previews;
- revision retention, and the idempotency-record window;
- cleanup grace period and batch sizes.

Measure against named device profiles and local, remote, and tunnel connections, and record the results. Avoid unbounded library reads, full-space rescans, eager rendering of every asset, whole-file buffers, and background processing that has no budget.

## Verification after approval

- **Limits.** Test each recorded limit at the boundary, and one over it, with no partial mutations.
- **Data model.** Cover:
  - ownership, root ordering, and nested-page authority;
  - cycles and atomic moves;
  - revision guards, the identity rules, and idempotent replay;
  - conflicts that keep the draft;
  - trash and restore when the parent is missing;
  - that the default space cannot be deleted.
- **Persistence.** Check the Spaces migrator and its ledger in isolation. The Spaces DB tag must never resolve to the chat DB. Check dev seeding and `doctor` with `spaces.sqlite` present.
- **Media.** Cover:
  - interrupted uploads and an unknown finalize outcome;
  - a MIME mismatch;
  - URL expiry and re-minting;
  - serving after disable or delete;
  - strong-ETag `HEAD`/`206`/`416`/`If-Range` for video and PDF;
  - compression bypass;
  - remote and tunnel ranges;
  - cleanup races with new references.
- **Toggle and compatibility.** At each merged layer, the setting is off by default, the capability is absent while the feature is off, and older clients and servers behave correctly.
- **Web and desktop.** Cover:
  - paginated, virtualized library loading;
  - empty, error, and retry states;
  - cache keys that include environment, space, query, and revision;
  - deep links with `?block=`;
  - the hidden rail and its fallback entries;
  - return to the last chat;
  - the beside-chat panel's persistence migration.
- **Mobile.** Cover:
  - core-set editing;
  - marks outside the mobile set kept intact, with those blocks read-only;
  - unknown blocks;
  - drafts across app restarts;
  - receipt-checked retry;
  - native media previews.
- **Chat and MCP.** Cover:
  - `@page`/`@block` records;
  - snapshot bounds and revision metadata;
  - child-page opt-in;
  - rendering while Spaces is disabled;
  - MCP parity with the service's authorization, limits, and conflicts.
