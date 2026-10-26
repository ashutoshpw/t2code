# Delivery and future verification

This plan-only PR is authorized. Product implementation requires express user approval.

The plan describes a future seven-layer implementation stack. Once explicitly approved, implementation authorization covers the agreed stack as a whole; do not add a separate authorization gate for each layer. Revisit approval only if the requested scope materially changes. Do not create implementation worktrees before that approval.

## Proposed seven-layer stack

Create each dependent branch from its intended parent's local commit, in a sibling worktree. The PR target is `ashutoshpw/t2code`. After a parent merges, rebase or retarget its child and verify that the child diff contains only its own layer.

| Order | Branch | Base | Scope |
| --- | --- | --- | --- |
| 1 | `feat/spaces-feasibility` | `main` | Dedicated editor-adapter feasibility prototype, stable-identity operation review, native-schema compatibility, and measured resource-budget worksheet. Review results before schema freeze. |
| 2 | `feat/spaces-storage` | `feat/spaces-feasibility` | Separate database, migrations, default/additional spaces, pages, blocks, revisions, service/contracts, authorization, and authoritative disabled-by-default setting plus versioned capability. |
| 3 | `feat/spaces-assets` | `feat/spaces-storage` | Staged filesystem lifecycle, bounded streaming, metadata, previews, recovery, backup/restore, and reference-aware cleanup. |
| 4 | `feat/spaces-shell` | `feat/spaces-assets` | Web/desktop library and page routes, AppRail/sidebar, beside-chat presentation, and settings UI. |
| 5 | `feat/spaces-editor` | `feat/spaces-shell` | Stable-ID editing, nested pages, ordering, conflict handling, and approved history behavior. |
| 6 | `feat/spaces-chat-mcp` | `feat/spaces-editor` | Bounded chat page/block references and MCP operations backed by the shared service. |
| 7 | `feat/spaces-mobile` | `feat/spaces-chat-mcp` | Native navigation, approved editing contract, and image/PDF/video access. |

Future worktrees belong under `/home/ashutosh/PROJECTS/exps`, alongside the existing checkout at `/home/ashutosh/PROJECTS/exps/t2code`. Proposed worktree directory names are `t2code-spaces-feasibility`, `t2code-spaces-storage`, `t2code-spaces-assets`, `t2code-spaces-shell`, `t2code-spaces-editor`, `t2code-spaces-chat-mcp`, and `t2code-spaces-mobile`. These are future locations only; do not create them before express implementation approval.

Each layer is a focused, reviewable PR with its own relevant checks. The stack's single implementation approval applies to all seven agreed layers; ordinary review and CI still apply. Do not combine the stack into one large PR or leave a child diff carrying duplicate parent changes.

## Release and capability gates

- The storage layer adds the server-authoritative disabled-by-default setting and versioned capability before any asset or MCP endpoint. Add its settings UI later. Every merged layer remains safe while disabled, including for older clients.
- Release only when the approved behavior matrix is ready across promised web, desktop, mobile, local, remote/tunnel, chat, and MCP paths.
- Keep unresolved schema, reference-retention, media-budget, and native-scope choices in [decisions.md](decisions.md) until they are resolved before the relevant layer freezes its contract.
- Use [validation.md](validation.md) for the feasibility gate, resource limits, and future verification coverage. No product checks are run while authoring this plan.
