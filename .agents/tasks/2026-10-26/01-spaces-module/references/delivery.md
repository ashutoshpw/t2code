# Delivery

This plan-only PR is authorized. Product implementation requires express user approval. A single approval covers the whole agreed stack below. Revisit approval only if the scope changes materially. Do not create implementation worktrees before approval.

## Seven-layer stack

Create each branch from its parent's local commit, in a sibling worktree. PRs target `ashutoshpw/t2code`. After a parent merges, rebase or retarget its child so the child's diff contains only its own layer.

| Order | Branch | Base | Scope |
| --- | --- | --- | --- |
| 1 | `feat/spaces-feasibility` | `main` | Web Tiptap adapter prototype, mobile native block-editing spike, PDF path choice, range check, and recorded budgets. Gate review before the schema freezes. |
| 2 | `feat/spaces-storage` | `feat/spaces-feasibility` | `spaces.sqlite`, the manifest-driven migrator, the `SpacesSql` tag, schema, `SpacesService`, contracts, RPC scopes, the idempotency table, `spacesEnabled`, the `spaces` capability, and dev/`doctor` tooling. |
| 3 | `feat/spaces-assets` | `feat/spaces-storage` | The `spaces-asset` resource on the existing asset route, strong-ETag ranges, staged uploads, startup reconciliation, and reference-aware cleanup. |
| 4 | `feat/spaces-shell` | `feat/spaces-assets` | `/spaces` routes, AppRail and fallback entries, sidebar, command palette, the beside-chat `space-page` surface, and the settings toggle. |
| 5 | `feat/spaces-editor` | `feat/spaces-shell` | The v1 block editor: stable IDs, nested pages, ordering, conflicts, per-page drafts, and trash/restore. |
| 6 | `feat/spaces-chat-mcp` | `feat/spaces-editor` | `page`/`block` context records with snapshots, plus the `SpacesToolkit` MCP tools. |
| 7 | `feat/spaces-mobile` | `feat/spaces-chat-mcp` | Mobile screens, the core editing set, durable per-page drafts, media previews and uploads, and mobile mentions. |

Worktrees will live under `/home/ashutosh/PROJECTS/exps`, beside `t2code`, as `t2code-spaces-feasibility`, `-storage`, `-assets`, `-shell`, `-editor`, `-chat-mcp`, and `-mobile`. Each layer is a focused PR with its own relevant checks (`vp run check:changed` plus focused tests).

## Release gates

- Each merged layer is safe while disabled, including for older clients.
- Release only when the approved matrix passes: web, desktop, mobile core set, local, remote, tunnel, chat, and MCP.
- Resolve the open decisions in [decisions.md](decisions.md) before the layer named for each one.
- Update `docs/user/` with a concise Spaces section in layer 4, and extend it in layers 6 and 7. Add a `docs/internals/` note only for the two-database and asset-revocation constraints.
- AGENTS.md says implementation plans are not committed. Keep this plan PR open as a review document rather than merging it, unless the repository owner decides otherwise.
