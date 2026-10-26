# Spaces module implementation plan

**Date:** 2026-10-26
**Task:** 01-spaces-module

## Objective

Plan environment-scoped Spaces with a default and additional spaces, stable block-based pages (including nested pages), and image, PDF, and video assets. The plan covers web, desktop, mobile, chat references, and T2 Code MCP; product implementation waits for express user approval.

## Context

- Spaces uses a separate `spaces.sqlite`; canonical rich block content stays in that database, while asset bytes live on the filesystem. Chat storage remains separate.
- Stable page and block IDs are canonical. Markdown import/export is optional and lossy; the earlier single-Markdown, no-block proposal is superseded. Feature disablement retains data.
- The source baseline is T2 Code commit [`33e8a315`](https://github.com/ashutoshpw/t2code/tree/33e8a31575256563da79cdac9a2f41b9a913dac0).

## Approach

Use one server-side Spaces service with typed contracts and thin web, desktop, mobile, HTTP, and MCP adapters. Keep document drafts in their own session, separate from per-thread panel presentation.

Once explicitly approved, implementation authorization covers the agreed stack as a whole. Make editor and native-schema feasibility the first stack layer, before freezing storage. Add the authoritative disabled-by-default server setting and versioned capability in the storage layer, before asset or MCP endpoints. Keep unresolved product choices conditional.

The delivery reference records the stack's dependency order.

## Steps

- [ ] After express implementation approval, evaluate the editor adapter and native-schema feasibility before schema freeze.
- [ ] Resolve the pending collaboration, block-set, offline, access, reference, media-budget, and mobile-scope decisions.
- [ ] Add separate storage, migrations, default/additional spaces, page and block ownership, revisions, guarded mutations, and capability reporting.
- [ ] Add staged filesystem assets, authenticated streaming, preview, recovery, backup, and reference-aware cleanup.
- [ ] Add the web/desktop library, routes, navigation, settings UI, and beside-chat presentation.
- [ ] Add stable-ID editing, nested pages, ordering, conflict handling, and approved history behavior.
- [ ] Add bounded chat references and MCP operations through the shared service.
- [ ] Add native mobile navigation, approved editing, and media access; then verify the approved platform matrix.

## Acceptance criteria

- [ ] Schema and editor behavior follow explicit ownership, identity, revision, authorization, and recovery invariants.
- [ ] Moves, restores, chat references, uploads, and backups obey the bounded atomicity and recovery rules in the references.
- [ ] Web, desktop, and mobile expose the approved capabilities; disabled state and older-client behavior are server-authoritative.
- [ ] Chat stores bounded send context and reference metadata, not a second full Spaces corpus.
- [ ] The approved release matrix passes focused and integrated verification without unbounded reads, transfers, or maintenance work.

## References

- [references/architecture.md](references/architecture.md) — environment storage, ownership, service, routes, and surface boundaries.
- [references/decisions.md](references/decisions.md) — settled scope and product choices that remain open.
- [references/identity-recovery.md](references/identity-recovery.md) — block identity, revisions, references, drafts, and recovery invariants.
- [references/validation.md](references/validation.md) — feasibility gate, resource budgets, and future verification.
- [references/delivery.md](references/delivery.md) — seven-layer stack, worktrees, authorization boundary, and release gates.
