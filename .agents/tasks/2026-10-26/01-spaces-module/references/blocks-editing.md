# Blocks and editing

## v1 block set

Each block has a type, an ID that is stable across the environment, a versioned `content` payload, and either a page-root rank or a parent container plus a rank.

| Group | Types | Notes |
| --- | --- | --- |
| Text | `paragraph`, `heading` (levels 1–3), `quote`, `callout` (icon + rich text) | Leaves that hold rich text. |
| Lists | `bulleted_item`, `numbered_item`, `todo_item` (checked flag) | The only **containers**: list items can own nested child blocks. |
| Code | `code` (language label; no execution) | Plain-text leaf. |
| Layout | `divider` | Empty leaf. |
| Media | `image`, `pdf`, `video` (asset ID + optional caption) | Store the asset ID only, never a URL. See [media-assets.md](media-assets.md). |
| Structure | `child_page` | The single authoritative owner of a nested page. |

Inline marks are bold, italic, strikethrough, inline code, link, page mention, and block mention. Mentions store environment, page, and block IDs and resolve to current titles when rendered.

Only list items act as containers. This keeps nesting and moves simple while still allowing nested lists and to-dos. Quote and callout hold rich text only.

Deferred block types: toggle, table, columns, database/board views, formulas, comments, synced blocks, bookmarks/embeds (which need outbound fetching), equations, audio, and generic file blocks. Unknown and future types decode as `unknown`. Every client preserves them and renders a read-only placeholder.

## Web and desktop editor

- Build a dedicated Tiptap schema and adapter for Spaces. Do not reuse the composer's Markdown-backed document mapping (`composer-rich-text-doc.ts`); reuse only the dependencies and the `ReactNodeViewRenderer` chip pattern.
- The current dependencies cover the text, list, and code nodes. Add `link`, `placeholder`, and an ID plugin, plus custom nodes for media, callout, and child page. Reordering uses a drag handle, either `@dnd-kit` (already used) or the Tiptap drag-handle extension.
- Map editor transactions to stable-ID, revision-checked mutation batches, as described in [identity-recovery.md](identity-recovery.md). Never treat unloaded blocks as deleted.
- Use `/` for an insert menu and Markdown input shortcuts (`#`, `-`, `[]`, `>`, ```` ``` ````). `@` inserts a page/block mention.
- Load the editor code lazily, both on the page route and in the beside-chat panel.

## Mobile core set

Mobile has no rich-text or block editor today. The chat composer is a native text view whose model is a string plus chips. Mobile editing is therefore new native work.

| Mobile can | Mobile renders but does not edit |
| --- | --- |
| Edit text in `paragraph`, `heading`, `quote`, and list/to-do items, with bold, italic, inline code, and existing links preserved | `code`, `callout`, and unknown blocks (with copy available) |
| Toggle to-do checks | Blocks containing marks outside the mobile set (such as strikethrough or mentions), which show an "edit on desktop" indicator |
| Insert paragraph, heading, list, to-do, and divider blocks; delete blocks | — |
| Move a block up or down; indent or outdent list items | Drag reordering, multi-block selection, and moves between pages |
| Insert image/PDF/video from the photo library or files | — |
| Create, rename, open, and trash child pages; navigate spaces | Inserting new page/block mentions (they render and open) |

Editor technology is decided in the feasibility layer. The recommendation is **one native text input per focused block**, inside a virtualized block list rendered from the shared schema. Editing one block at a time matches the stable-ID mutation model and avoids WebView IME and keyboard problems. The fallback is Tiptap in a WebView, used only if native mark preservation fails. Either choice means a native rebuild.

A mobile edit must round-trip any marks and content it does not understand. If it cannot, that block is read-only on mobile.

## Drafts

Persist drafts per page with environment, page, base revision, mutation ID, generation, block content, and local asset handles. Hydrate a draft before allowing writes. Clear only the generation the server acknowledged; text typed after that acknowledgement stays dirty. Show local-draft, saved, and conflicted states separately.

- Web/desktop: store drafts per page in IndexedDB or the existing client persistence, keyed by environment and page.
- Mobile: use a durable expo-sqlite table, or one atomic file per page. Do not use the single whole-file `composer-drafts` store, and do not use the clearable `client_cache` table.
