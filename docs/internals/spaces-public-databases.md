# Public links and databases

A page share link is anonymous and read-only. When a shared page contains a database, the link
exposes it through one rule set, decided on the server from the token and stored data on every
request. The viewer supplies ids and a window position only.

## What a link exposes

- A database is in scope when its home page is in the shared tree. A linked view of a database
  whose home is outside the tree answers unavailable.
- Only the views listed on that block are readable, and each view's saved filter is the only gate
  on rows. Rows, row pages and their assets are refused when the saved filter does not return them.
- Each view exposes its title, visible properties and the properties its layout needs, nothing else.
- Relation, rollup and formula cells appear only when everything they read is inside the tree.
  Related rows show a title and icon, nothing more. Volatile formulas and formulas in error are
  omitted.

## Traps

- Query cursors hold the sort values of the last row, so a hidden sort property would leak
  through them. The share service seals every cursor and binds it to the share, page, block and view.
- Option lists are per window. A select option that no returned row uses is data (a private name),
  so it must not be sent.
- `readWithAdmission` can write. Public routes use plain reads only, and never reach a mutation.
- `relatedPages` from row hydration is neither scope- nor liveness-checked. The sanitizer filters it.
- The sanitizer builds every output object key by key from an allow-list. Spreading a stored or
  wire record into an answer leaks every field added later.
- Hidden board groups are a courtesy, not a boundary: date views and the row route do not check
  them. The saved filter is the boundary, and the user guide says so.
- Database routes have their own concurrency limit so anonymous queries cannot starve page reads.

See [the share exposure code](../../apps/server/src/spaces/sharedDatabases/Exposure.ts) and
[the share service](../../apps/server/src/spaces/PageShareService.ts).
