# Pending product decisions

The recommendations below are proposals for review, not approved product behavior. Resolve each decision before freezing the schema or user-facing promise it affects.

| # | Pending decision | Recommendation for review |
| --- | --- | --- |
| 1 | Optimistic revision conflicts or real-time collaborative editing? | Start with optimistic revisions and retained drafts if that meets the use case. If real-time editing is required, choose one authoritative collaborative representation and treat relational search/display data only as projections. |
| 2 | Which core blocks ship, and are data tables, formulas, or comments in scope? | Review paragraphs, headings, inline formatting, lists, to-do items, quotes, code, dividers, callouts/bookmarks, images, PDFs, videos, and child-page blocks as a candidate core set. Confirm the exact set before schema freeze. |
| 3 | Online-first editing or offline synchronization? | Consider online-first writes with durable local drafts and explicit reconnect/conflict handling. Do not promise full offline synchronization without a separate merge and storage contract. |
| 4 | Does access follow environment authorization, or do spaces need private/per-space ACLs? | Consider using the environment's existing access model initially, without another ACL system. Decide explicitly before implementation if users need private spaces or differently authorized collaborators. |
| 5 | Does a sent reference store an immutable bounded prompt snapshot or resolve live, must users later navigate the full historical source, and how do old references render when Spaces is disabled? | Consider a bounded send-time snapshot with source IDs, revisions, and a content hash for reproducibility. Decide separately whether full historical page navigation requires durable source-revision retention and a cross-database lease handoff. Keep old references explicit and available as metadata; decide their disabled-state presentation without erasing them. |
| 6 | Which previews/processors ship, and what are practical upload, quota, and retention budgets? | Consider preserving originals with image/PDF preview and range-capable video playback where supported, plus download fallback. Keep OCR, extraction, transcription, and transcoding out unless explicitly selected and budgeted. Set numeric limits during feasibility. |
| 7 | What is the native mobile editing contract: full parity or a smaller core set? | Decide the native editing set alongside the core block set. Preserve unknown blocks or render them read-only; do not default the whole mobile feature to read-only. |

## Settled scope

- One default space per environment plus additional spaces.
- Stable, independently addressable block-based pages, including nested pages.
- Separate `spaces.sqlite` beside configured `userdata/statev2.sqlite`; asset bytes on the filesystem.
- Image, PDF, and video assets inside pages.
- A Spaces library/module integrated with web, desktop, and mobile; page presentation beside chat where supported.
- Page/block chat references and access through T2 Code MCP.
- Enable/disable access while retaining content.
- Optional, potentially lossy Markdown import/export; Markdown is not canonical storage.
- Future implementation as dependent stacked PRs in sibling worktrees.

## Numeric limits

Spaces upload limits, quotas, revision retention, cleanup grace periods, resumable-upload thresholds, and backup budgets remain unset. Existing chat limits of 10 MB for images and 50 MB for files are not adopted Spaces limits and do not set a video maximum.
