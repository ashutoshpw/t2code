# Spaces module implementation plan

**Date:** 2026-10-26
**Task:** 01-spaces-module

## Objective

Ship environment-scoped Spaces: a default space plus additional spaces, block-based pages with stable block IDs and nested pages, and image, PDF, and video blocks. Spaces works on web, desktop, and mobile (a smaller mobile editing set), in chat references, and through T2 Code MCP. Product implementation waits for express user approval.

## Context

- Spaces uses a separate `spaces.sqlite` beside `statev2.sqlite`, and keeps asset bytes on the filesystem. Chat storage remains separate.
- Settled: one writer per revision, with conflict errors and retained drafts; there is no real-time co-editing. The v1 block set is fixed. Mobile edits a smaller core set and renders everything else.
- Stable page and block IDs are canonical. Markdown import/export is optional and lossy. Disabling the feature keeps data.
- The source baseline is T2 Code commit [`33e8a315`](https://github.com/ashutoshpw/t2code/tree/33e8a31575256563da79cdac9a2f41b9a913dac0).

## Approach

One server-side `SpacesService` owns the data. It is not event-sourced and has its own DB connection tag, migration manifest, and idempotency table. Typed RPC, the HTTP asset route, and MCP stay thin adapters. Media is served from the existing signed `/api/assets` route through a new Spaces asset resource; Spaces does not get its own media route. Chat `@page`/`@block` mentions are new composer context-record kinds.

The first layer is a feasibility check of the web editor adapter and the mobile editor technology, done before the schema is frozen. The storage layer adds the disabled-by-default server setting and the `spaces` capability before any asset or MCP endpoint exists. Backup/restore, resumable uploads, and historical-source retention are out of v1.

## Steps

- [ ] After approval, prototype the web editor adapter and native mobile block editing; record resource budgets.
- [ ] Add the Spaces DB, migrator, DB tag, spaces/pages/blocks/revisions, idempotency, RPC scopes, setting, and capability.
- [ ] Add the Spaces asset resource, staged uploads, immutable-asset range responses, and reference-aware cleanup.
- [ ] Add the web/desktop rail entry, `/spaces` routes, sidebar, beside-chat panel, and settings toggle.
- [ ] Add the v1 block editor: stable IDs, nested pages, ordering, conflicts, drafts, and trash.
- [ ] Add `@page`/`@block` context records with bounded send-time snapshots, and a Spaces MCP toolkit.
- [ ] Add mobile screens, the core editing set, per-page durable drafts, and media; then verify across surfaces.

## Acceptance criteria

- [ ] Ownership, identity, revision, idempotency, and authorization invariants hold under focused tests.
- [ ] A conflict never overwrites newer work, and the client keeps the user's draft.
- [ ] Media works through signed URLs on local, remote, and tunnel connections, with range seeking for video and PDF.
- [ ] Mobile edits the core set without stripping content it cannot edit.
- [ ] Disabled state and older clients are handled from server-side state; chat stores bounded snapshots only.
- [ ] No unbounded reads, transfers, or maintenance passes within the recorded budgets.

## References

- [references/decisions.md](references/decisions.md): settled choices, items deferred out of v1, and open choices.
- [references/architecture.md](references/architecture.md): storage, service, RPC/scopes, capability, routes, shell, chat, and MCP.
- [references/blocks-editing.md](references/blocks-editing.md): v1 block set, web editor, mobile core set, and drafts.
- [references/media-assets.md](references/media-assets.md): asset resource, signed URLs, ranges, uploads, limits, and cleanup.
- [references/identity-recovery.md](references/identity-recovery.md): block identity, revisions, idempotency, trash, and chat snapshots.
- [references/validation.md](references/validation.md): feasibility gate, resource budgets, and verification.
- [references/delivery.md](references/delivery.md): seven-layer stack, worktrees, and release gates.
