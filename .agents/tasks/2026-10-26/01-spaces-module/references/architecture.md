# Spaces architecture proposal

This is a source-grounded proposal. Choices in [decisions.md](decisions.md) remain conditional until resolved before implementation freezes the affected contract.

## Environment and canonical content

- Each server environment owns one default space and may own additional spaces. The Spaces root resolves to its default space.
- Store `spaces.sqlite` in the configured userdata directory beside `statev2.sqlite`, with its own migration ledger and lifecycle. Store canonical rich block content and metadata in this database; asset bytes live at `<configured userdata>/spaces/assets/<opaque-key>`.
- Keep chat and thread data in their current database. Do not assume transactions or foreign keys span the chat and Spaces databases.
- Page and block IDs are stable within an environment. Markdown import/export is optional and lossy; it is not canonical storage.

## Proposed ownership and revision model

The relational baseline is conditional on the collaboration decision. It may use environment-scoped records equivalent to spaces, pages, blocks, revisions, and asset metadata; block content and inline properties use a versioned schema.

- Each page belongs to one space. Top-level pages have explicit space-root ordering. A nested page is owned by exactly one authoritative `child_page` block; do not add a competing page-parent tree or duplicate ownership in inline JSON.
- Each ordinary block belongs to one page and has either explicit page-root order or a parent block. Only schema-declared containers may own child blocks; candidate containers are list items, to-do items, quotes, and callouts. Treat other core types as leaves unless the approved type map says otherwise. A `child_page` block owns a page, not ordinary block children. Keep root order and each container's child order authoritative and separately addressable.
- Block ordering uses stable ranks with bounded rebalancing. Page and block nesting is acyclic and subject to a defined depth limit.
- A mutation checks every affected page revision and each affected space/root-order revision in one Spaces transaction. Validate cycles and destination authorization in that same transaction. Reject an over-limit subtree move wholly and leave it unchanged; do not split it into silent partial batches.
- Keep reads paginated and revision-consistent. Index only changed blocks; do not send full pages for navigation or search.
- Keep one default space present. A deletion/replacement flow must not leave the environment without it; decide the exact user flow before implementation.
- Page trash is reversible and applies to the nested subtree. Restore creates a new revision and follows the checked-ownership rules in [identity-recovery.md](identity-recovery.md).

## Service and capability boundary

Implement one server-side `SpacesService`. Typed RPC, HTTP asset, and MCP adapters validate and map requests but share service authorization, revision, and feature-disabled behavior. Put cross-wire schemas in `packages/contracts`; use the existing guarded-command path for client mutations.

Expose only the needed service operations: list/create/default selection for spaces; page create/read/move/trash/restore; paginated block reads and revision-checked batches; search; asset metadata/upload/finalize/read; and capability/settings. Keep bodies and result counts bounded.

Check authorization on every request against the current destination environment and space. A signed asset URL is not a substitute for current authorization on each new HTTP request.

The first storage layer adds an authoritative, disabled-by-default server setting and a versioned capability response before any asset or MCP endpoint exists. Later settings UI controls the server setting. Disabling access retains pages, revisions, assets, and historical reference metadata; it does not authorize deletion or unsupported writes by older clients.

## Routes, shell, and feature wiring

Proposed web route: `/environments/{environmentId}/spaces/{spaceId}/pages/{pageId}#block={blockId}`. Confirm route parsing and environment scoping during implementation. IDs keep deep links stable across rename and move; resolve and authorize before returning current location.

The current AppRail has inline entries; `mainAppLocation` tracks the last non-utility route; `AppSidebarLayout` composes sidebar and thread state; and the typed right-panel surface is thread-scoped. Add Spaces through those seams, preserve the last chat URL, and keep thread panels tied to their thread. Document identity and drafts belong to a document session; a thread panel may store presentation selection only.

Use a typed first-party feature descriptor with stable IDs for navigation, sidebar, panel, settings, commands, and mount/dispose only where repeated wiring warrants it. Use platform adapters; do not add a dynamic marketplace or dependency host. Library routes and deep links must handle hidden rails and disabled capability clearly.

## Editor and client surfaces

The web client already has Tiptap primitives and a chat-specific adapter. Reuse suitable primitives, not the composer schema or Markdown persistence. Spaces needs a dedicated adapter translating structural editor transactions into stable-ID, revision-checked mutations.

Before schema freeze, verify that the chosen schema can be preserved on every target surface. Unknown blocks must remain preserved or explicitly read-only; a partial or paginated editor must never delete unloaded content. Mobile has separate React Native navigation and media preview infrastructure; do not assume the web editor is available there or silently make mobile read-only.

## Chat and MCP boundary

Represent page and block mentions with structured environment, page, block, and optional space hints plus an explicit revision policy. Resolve current title, location, deletion state, and authorization by stable IDs; a stale title or former grant does not imply current access. Default `@page` to that page's own blocks, not nested pages. Bound `@block` to its subtree. Include child-page content only by explicit opt-in and track each included source revision.

Persist the bounded prompt context needed for the sent message with source IDs, revisions, and a content hash; do not copy the full Spaces corpus into chat storage. Historical full-page navigation and revision retention remain separate decisions. MCP calls use the same service, limits, authorization, and disabled behavior.

## Media boundary

Stream image, PDF, and video bytes over authenticated HTTP, not WebSocket RPC or base64 JSON. Preserve originals and allow download fallback; byte-range video must work through remote and tunnel connections. Treat PDF preview as platform-dependent until verified. Do not assume preview parity or add OCR, transcription, or transcoding by default. Upload sizes, quotas, retention, and recovery details are in [identity-recovery.md](identity-recovery.md) and [decisions.md](decisions.md).

## T2 Code source anchors

Links are pinned to T2 Code commit [`33e8a315`](https://github.com/ashutoshpw/t2code/tree/33e8a31575256563da79cdac9a2f41b9a913dac0):

- [AppRail](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/components/appRail/AppRail.tsx), [mainAppLocation](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/components/sidebar/mainAppLocation.ts), and [AppSidebarLayout](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/components/AppSidebarLayout.tsx) show current shell seams.
- [rightPanelStore](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/rightPanelStore.ts) and [RightPanelSurfaceContent](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/components/chat/RightPanelSurfaceContent.tsx) define the typed thread-panel state and renderer.
- [Chat route](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/routes/_chat.$environmentId.$threadId.tsx), [Tiptap composer adapter](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/components/ComposerPromptEditorTiptap.tsx), [composer schema adapter](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/composer-rich-text-doc.ts), and [web dependencies](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/package.json) support the editor boundary.
- [Client RPC permissions](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/packages/contracts/src/clientRpcPermissions.ts), [mobile navigation](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/mobile/src/Stack.tsx), [mobile file preview](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/mobile/src/components/FilePreview.tsx), and [mobile video preview](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/mobile/src/components/MediaVideoPlayer.tsx) show current client seams.
