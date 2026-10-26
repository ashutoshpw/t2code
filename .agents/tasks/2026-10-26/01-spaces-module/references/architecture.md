# Spaces architecture

Source links are pinned to [`33e8a315`](https://github.com/ashutoshpw/t2code/tree/33e8a31575256563da79cdac9a2f41b9a913dac0).

## Storage

- Each environment owns one undeletable default space and any number of additional spaces. The Spaces root resolves to the default space.
- `spaces.sqlite` sits beside `statev2.sqlite`. Derive its path, plus `spaces/assets` and `spaces/staging`, in `deriveServerPaths` and `ensureServerDirectories` ([`apps/server/src/config.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/server/src/config.ts)).
- The current migrator is hard-wired to the chat manifest and its V2 guards ([`apps/server/src/persistence/Migrations.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/server/src/persistence/Migrations.ts)). Generalize it to accept a manifest, or add a Spaces copy, keeping its own `effect_sql_migrations` ledger in `spaces.sqlite`.
- `SqlClient` is a single context tag. Give Spaces its own tag (e.g. `SpacesSql`) so Spaces code can never use the chat connection by accident. Reuse the WAL, busy-timeout, and vacuum settings from [`apps/server/src/persistence/Sqlite.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/server/src/persistence/Sqlite.ts).
- No transaction or foreign key spans the chat DB and the Spaces DB. A chat reference to a deleted page resolves to an explicit "unavailable" outcome.
- Update the dev and maintenance tooling for the second DB:
  - `migrate-dev-db` and dev seeding ([`apps/server/scripts/migrate-dev-db.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/server/scripts/migrate-dev-db.ts)) create `spaces.sqlite` empty, or copy it in read-only.
  - `doctor`, `DatabaseStorage`, and storage reporting include `spaces.sqlite`.
  - Update the `test-t2-app` SQLite fixture notes.

## Ownership and revisions

The tables are spaces, pages, blocks, page revisions, assets, asset references, and idempotency records.

- A page belongs to one space. Top-level pages have an explicit space-root order. A nested page is owned by exactly one `child_page` block. There is no second parent pointer and no ownership stored in JSON.
- A block belongs to one page and has either a page-root rank or a list-item parent ([blocks-editing.md](blocks-editing.md)). Ranks are stable, with bounded rebalancing. Nesting is acyclic and depth-limited.
- A mutation batch checks the expected revision of every affected page and space-root order, and checks for cycles and authorization, all in one Spaces transaction. A batch over the limit is rejected whole.
- Reads are paginated and consistent per revision. The search index is updated only for changed blocks. Navigation never needs full page bodies.

## Service, RPC, and scopes

- `SpacesService` is an Effect service and is not event-sourced; it does not touch `EventSink`. Typed RPC handlers in `ws.ts`, the asset resolver, and MCP handlers each decode the request, call one service method, and map errors.
- Operations:
  - spaces: list, create, rename, set default;
  - pages: create, read, move, trash, restore;
  - blocks: paginated reads and revision-checked batches;
  - search;
  - assets: mint upload, finalize, metadata, mint read URL.
- Wiring a new method involves:
  - `WS_METHODS` and `Rpc.make` in `packages/contracts/src/rpc.ts`;
  - every method, reads included, in `RPC_REQUIRED_SCOPES` ([`apps/server/src/auth/RpcAuthorization.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/server/src/auth/RpcAuthorization.ts));
  - write methods in `CLIENT_GUARDED_RPC_SCOPES`, used through `createEnvironmentRpcCommand` and its `permissionAtom`;
  - an extension to the permission behavior tests.
- Scopes: v1 reuses `orchestration:read` and `orchestration:operate` (decision 2 in [decisions.md](decisions.md)).
- Idempotency: the orchestration command receipts are tied to the chat event-sink transaction and keyed by thread or project, so they cannot be reused. Spaces keeps its own `idempotency` table in `spaces.sqlite`, written in the mutation's transaction; see [identity-recovery.md](identity-recovery.md).

## Setting and capability

- Server setting `spacesEnabled`: `Boolean` with a decoding default of `false`, following `guestSharingEnabled` ([`packages/contracts/src/settings.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/packages/contracts/src/settings.ts)). It is patched under `settings:write` and shown as a server-scoped row in Settings. Every Spaces RPC, asset resolve, and MCP tool checks it.
- Capability: add `spaces: optionalKey({ version, limits })` to `ExecutionEnvironmentCapabilities` ([`packages/contracts/src/environment.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/packages/contracts/src/environment.ts)). Older servers omit it, and the feature stays hidden in clients. The key is present only while the feature is enabled, so clients need to read just one thing.

## Routes and shell (web/desktop)

- Routes:
  - `/spaces` redirects to the default space of the selected environment.
  - `/spaces/$environmentId/$spaceId` is a space's page list.
  - `/spaces/$environmentId/$spaceId/$pageId?block=<blockId>` is a page.
- The block target goes in a search param, not the URL hash. Electron uses hash history ([`apps/web/src/main.tsx`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/apps/web/src/main.tsx)), and Settings already uses router hashes.
- Deep links use IDs, so they survive renames and moves. Authorize and resolve the current location before rendering.
- AppRail has no registry, and adding a module touches these places: the `AppRail.tsx` array, the `appRail.logic.ts` union and active-item logic, `isSidebarUtilityPage` in `mainAppLocation.ts`, the sidebar branch in `AppSidebarLayout`, the `SidebarChrome` fallback buttons (shown when the rail is hidden or on narrow screens), and command-palette navigation.
- Add `/spaces*` to `isSidebarUtilityPage` so the Threads button still returns to the last chat.
- Beside-chat panel: add a lazily loaded `space-page` surface to the `RightPanelSurface` union. Update `RIGHT_PANEL_KINDS`, persisted-state migration (which drops unknown kinds), `RightPanelSurfaceContent`, and `RightPanelTabs`.
  - The panel stores only `{environmentId, spaceId, pageId, blockId?}` per thread. Drafts belong to the document session, not the panel.
- Library lists use `@legendapp/list` (the existing virtualizer) with paginated summary RPCs.
- Desktop CSP already allows `http(s):` images, media, and frames. No CSP change is expected for media from the server origin.

## Chat references

- Add `page` and `block` kinds to the composer context records ([`packages/contracts/src/composerContext.ts`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/packages/contracts/src/composerContext.ts), modeled on `ThreadContextRecord`). Each record holds environment, space, page, and block IDs, plus the title and revision at send time. They serialize as `t2-context://v1/<kind>/<contextId>` links ([`docs/internals/composer-context-references.md`](https://github.com/ashutoshpw/t2code/blob/33e8a31575256563da79cdac9a2f41b9a913dac0/docs/internals/composer-context-references.md)), and context IDs are opaque.
- Implementation also needs:
  - entries in `contextPresentationRegistry`;
  - chips;
  - a composer trigger and menu item on web and mobile;
  - stale-record pruning;
  - cross-environment validation in `composerSend.logic.ts`.
- On send, store a bounded snapshot with source IDs, revisions, and a content hash. By default `@page` includes the page's own blocks and `@block` includes its subtree. Child pages are included only by opt-in, and each one's revision is recorded.

## MCP

- Add a `SpacesToolkit` under `apps/server/src/mcp/toolkits/` (`tools.ts` + `handlers.ts`), registered with `toolkitRegistration` in `McpHttpServer.ts`. Mark tools with `Readonly` and `Destructive` annotations, and add `spaces` to `McpCapability`.
- Tools call `SpacesService`. They share its limits and revision checks and the disabled behavior, and read-only clients are refused through `McpToolAccess`.
- Results are JSON. Media is returned as an asset ID or signed URL, never as inline bytes.
