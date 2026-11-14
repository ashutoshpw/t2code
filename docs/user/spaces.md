# Spaces

Enable **Spaces** in **Settings → Labs** for the environment you want to use. It is off by default. Select one environment if another selected server needs an update.

Open Spaces from the app rail, the sidebar's navigation controls when the rail is hidden, or **Open Spaces** in the command palette. You can assign a shortcut in Settings → Keybindings; none is assigned by default.

Pick a space in the sidebar to see its page tree. Expand a page to see its sub-pages, and use the arrow keys to move between rows. **Next pages** and **Next spaces** appear when a list has more to show. An empty batch does not always mean there is nothing after it.

**All pages** lists every page in the environment, and **Media** lists the images, PDFs and videos used by pages. Open an item to visit its page. Search from a space's library; **Next results** appears when there are more matches.

Choose **Create** at the top of the sidebar to add an untitled page with its title selected, or the **+** beside **Spaces** to create a space. A space's **…** menu renames it or makes it the default space.

## Write on a page

Click the title at the top of a page to rename it. Hover above the title and choose **Add icon** to give the page an emoji icon. Click the page body to start writing; changes save automatically a moment after you stop typing and when you leave the page. If a save fails, **Retry** appears below the page. After a conflict with another device, your edits stay on this device and you can discard them.

An open page updates when it is changed on another device or by an agent. If you have unsaved edits, they stay and the page shows the conflict when it saves.

- Type **/** for a command menu: headings, lists, to-do, toggle list, quote, callout, code, divider, **Tabs**, **Synced block**, **Database**, **Linked view of database** and **Page**, which creates a sub-page below the block and opens it with its title selected. Markdown shortcuts also work, such as `# `, `- `, `1. `, `[] `, `> ` and three backticks. Type `>> ` for a toggle list: Enter at the end of an open toggle's first line starts its first nested block, and the arrow collapses or expands it for you only. Toggles open as expanded and are read-only on mobile. Press Enter on an empty block to leave a list or quote.
- **Tabs** groups content into named tabs. Double-click a tab to rename it, drag tabs to reorder them, and use **+** to add one. The tab you have open is remembered only on your screen.
- **Synced block** keeps the same content on several pages; see [Synced blocks](#synced-blocks).
- Select text for a toolbar with bold, italic, strikethrough, inline code, links and **Turn into**. Press Cmd/Ctrl+Z to undo and Cmd/Ctrl+Shift+Z to redo.
- Change a heading's level from **Turn into**. Click a callout's icon to pick another emoji. Code blocks have a language menu, **Copy code** and a line-wrap button; code is not run.
- Hover a block to show **+** (add a block below) and a handle. Drag the handle to reorder blocks, or click it for **Turn into**, duplicate, delete and move.
- To mention a page or block, choose **Insert page or block mention…** from the page header's **@** button.
- The editing **More** menu in the page header has split, join, move, delete, **Remove media block** and **Undo saved change** for the last saved edit.

## Synced blocks

A synced block shows the same content on more than one page. Create one with **/Synced block** and choose **Copy and sync** on it, or choose **Copy and sync** from any block's handle to wrap that block. Then paste on another page: the copy shows the original's content and a **Synced from** label. Edit any copy and the original changes everywhere; open copies refresh as it changes.

- **Unsync** on a copy turns just that copy into ordinary blocks. **Unsync all**, on the original, does it for every copy.
- If the original is deleted or moved to Trash, its copies show a notice with **Remove**.
- Synced blocks cannot contain tabs, databases, sub-pages or other synced blocks.
- Shared pages show synced content read-only.

## Comments

Comment on a whole block or on selected text. Hover a block and choose the comment button, or
select text and choose **Comment**. Press **Ctrl+Alt+M** (**Cmd+Option+M** on Mac) to comment on
the block you are in. On wide windows comments appear beside their blocks; otherwise open them from
the comment count in the page header or **Show comments** in the command palette.

Reply, edit or delete your own comments, and **Resolve** a thread when it is done. Resolved threads
stay under **Resolved**, where you can reopen them. If the commented text is edited away, the comment
stays on its block.

To have an agent act on a comment, choose **Send to session** in the comment box: pick an existing
session or start a new one in a project, and choose **Ask to edit** (the agent changes the page) or
**Just message**. The comment shows the session's status and links to it. The agent can reply in the
comment thread; only you can resolve it. Each comment can be sent once; to send again, reply and
send the reply.

Shared page links never show comments.

## Media

Choose **Media → Upload** in the page header to add an image, PDF or video to the page. To swap a file, select its block and choose **Replace selected media**. The block keeps its place and caption. Edit the caption in the page. To remove media, select its block and choose **More → Remove media block**; the file itself is not deleted. Previews open when you ask for them; if a preview link expires, refresh it.

## Databases

A database is a set of pages, called rows, that share properties such as a status, a date or an owner. Type **/** and choose **Database** to add one inline on a page. A page that holds only a database opens as a full-page database. Every row is a page: open it to see its properties above a body you can write in. A database holds up to 25,000 rows, 100 properties and 50 views.

Each database has saved views. Add one to look at the same rows another way, and each view keeps its own filters, sorts, grouping and visible properties.

- **Table** is a grid for editing many rows at once.
- **Board** groups rows into columns, such as status, and is the one to use for workflow.
- **List** is a compact line per row.
- **Gallery** shows cards, with a cover or a property as the preview.
- **Calendar** places rows on a date property. A range shows up to 500 items.
- **Timeline** draws rows as bars from a start to an end date.

Views can filter, sort, group and sub-group, and show a calculation (count, sum, average and so on) in a column footer or group header.

### Properties

Properties are text, number, select, multi-select, status, date, checkbox, URL, email, phone, files, relation, rollup, formula, created time, last edited time and unique ID. Deleted properties can be restored.

- **Relation** links rows to rows of another database. Choose the database, whether a row links to one page or has no limit, and whether to show the link on the other database too. The target database cannot be changed afterwards.
- **Rollup** summarizes a property of the related rows, for example the sum of their estimates or the earliest date. A rollup cannot read another rollup.
- **Formula** calculates a value from the row's other properties. `prop("Price") * prop("Quantity")` multiplies two numbers, and `dateBetween(prop("Due"), today(), "days")` counts the days from today to the due date. Formulas can chain calls with a dot, name values with `let`, branch with `if` and `ifs`, and work on lists with `current` and `index`. A formula can read properties one relation away; to reach further, add a formula or rollup on the related database. While you type, the editor explains errors and offers completions. Regular expressions in formulas have no lookahead, backreferences or group modifiers.

### Linked views, sub-items and templates

Choose **Linked view of database** from the **/** menu to show an existing database somewhere else. It shows the same rows, and each linked view keeps its own filters, sorts and layout.

While the original database is in the trash, a linked view shows a message instead of rows until you restore it. A database whose block was removed keeps its rows for 30 days and comes back if you undo the removal (editor undo or **Undo saved change**) in that time. Emptying its page from the trash cannot be undone. After 30 days its rows are removed permanently. A database whose page is in the trash is kept until the trash is emptied.

Sub-items let rows have child rows of the same database. Turn them on in a table or list view's layout settings, then show them in a hierarchy or as plain rows.

Templates pre-fill new rows. Use **New template** in the new-row menu, edit it like any row, and set one as the default. A row made from a template copies its icon, properties and body, but not its title.

### Good to know

- Formulas that use `now()` or `today()` are for display. They cannot be filtered, sorted, grouped or used in a rollup, and they do not appear on shared links.
- Empty values stay empty through arithmetic.
- Dates without a time zone, and `formatDate`, use the time zone of the machine running T2 Code.
- Numbers you type on the web follow your browser's regional format, so `1,5` is one and a half where commas mark decimals.
- Nested sub-items hide children that do not match the filter, and are off while grouping or searching.
- After a large change, calculated values fill in over a few seconds.

Agents can read and edit databases through the same Spaces access as pages. Refer to properties by their names when you ask. An open database shows edits made by other people, other devices and agents as they happen, without a refresh.

## Pages: move, trash and restore

The **…** menu in the page header has **Move to…**, **Add sub-page**, **Copy link**, **Move to trash** and **View trash**. Pin a page with the star in its header to keep it in the sidebar's **Pinned** list; **Recents** lists up to 50 recently opened pages. Pins and recents are shared by devices connected to the same environment.

- **Move to…** opens a picker where you can search, open a page to browse inside it, or choose a space's top level. A toast confirms the move and offers **Undo**.
- **Move to trash** takes you to the parent page, and a toast offers **Undo**. **View trash** lists trashed pages with **Restore** and **Delete permanently**. Permanent deletion asks you to confirm and cannot be undone.
- If a page change didn't finish, a note under the header offers **Finish it** or **Dismiss**.

After opening a saved chat, visit a page and choose **Open beside chat** to keep the page in a panel. Both views share the same draft. Threads returns to your previous chat. Page links can include a block target in the URL query. An already loaded target is selected without replacing the shared draft. An unloaded target stays explicit: resolve the current source if it moved, then save or resolve any draft before using First/Next windows. The app does not scan the page to find it. The page location shows its current space and parent pages.

Turning Spaces off keeps its data. Reading pages requires the destination environment's read permission; changing the setting requires permission to change its settings.

## Share a page

Share a page and its sub-pages with someone who has no T2 Code account. Page links are a beta, and they need [T2 Connect](./remote-access.md) linked on the machine that runs T2 Code.

1. On that machine, turn on **Settings → Labs → Page links**.
2. Choose **Share…** in the page's **…** menu, or **Share page** in the command palette. On mobile, choose **Share** on the page.
3. Copy the link, or send it from the share sheet on mobile.

Anyone with the link can read the page and all its sub-pages, read-only, without signing in. Nothing above or beside the page is reachable. Viewers see the page as it was when they opened it and reload to see changes. A **Shared** button on the page shows the link again. Use **Create new link** to replace it, or **Stop sharing** to end it.

Databases on a shared page appear read-only. Viewers can switch between the views saved on the page and open a row to read it, but they cannot search, filter or edit. Each view shows 50 rows at a time and only the properties it displays, up to 500 rows per view. Board columns show 10 rows at a time and stop at 200 rows each, so a board can show more than 500 in total. Calendars and timelines show as a month list. Sub-pages and databases inside an opened row are not shown. To keep rows off a link, filter them out in every view on the page; hiding a board column is not enough. A relation column shows the titles of related rows even when the view's filter excludes them, so hide the column to keep those titles off the link. Rollup and formula columns show their result as calculated from all related rows, including ones the filter excludes, and a formula can use properties the view hides, so hide those columns too when the values are private. Formulas that use `now()` or `today()` do not appear. A linked view appears only when its original database is also inside the shared page.

A link stops working when:

- you stop sharing or create a new link,
- seven days pass,
- the shared page is moved to trash or deleted,
- **Page links** is turned off, or
- the machine's T2 Connect address changes.

A database stops showing when its original is moved to the trash. The machine must stay online for viewers to open the link. Images, PDFs and videos on the shared pages are visible to viewers, so share only what you are comfortable showing.

## Use a page or block in chat

On web and desktop, type `@` and search for a page or block in the chat's environment.
Spaces results appear alongside files and threads. Search reads one window at a time;
use **More Spaces results** to continue, including after an empty window. If the index
is building, retry when it is ready.

A Page reference includes its own blocks. A Block reference includes that block's
subtree. Child pages are excluded by default. Turn **Include child pages** on in the
picker for the next selection, or change the selected reference's checkbox above the
composer before sending. The picker returns to off after a selection. These choices
are saved with your draft. To change the scope of a copied sent snapshot, remove it
and select its source again.

Content is captured when you send, using the environment's current read access.
The message keeps that text excerpt and the source revisions; later page edits do
not change the sent snapshot. Opening its chip visits the current source, which may
have moved or merged. If Spaces is disabled, disconnected, denied or the source is
no longer available, the stored snapshot remains, but its current-source link is
unavailable. A new send recaptures current content; it stops and keeps the draft if
a referenced source cannot be captured.

A message can reference at most eight Spaces selections. Each snapshot includes at
most eight source pages and 100 block IDs, with additional text and traversal limits.
Large or deep selections can be shortened, including with child pages enabled; the
chip's details say when its stored snapshot was shortened. Select a smaller page or
subtree when the omitted content matters. Media contributes its caption and type,
not file bytes. Snapshots do not keep deleted source pages or media available.

On mobile, type `@`, choose **Page…** or **Block…**, then type your search words.
Use **Next results** to continue bounded windows, including empty ones. Child pages
start off; change **Include child pages** before selecting, or tap a retained draft
chip to change its scope. Tap a draft or sent chip for snapshot details and **Open
current source**. Unloaded blocks still require manual First/Next page browsing.
Selection requires a current connection with read access, inline context and Spaces
capture support. Unsupported or ambiguous pasted references are refused before insertion.

See [prompt recovery](./composer.md#prompt-stash) for web/desktop local storage,
attachment and retry limits, and [outside agents](./outside-agents.md#spaces) for MCP access.

## On mobile

On mobile, open **Spaces** from the thread list, Settings, or the command palette, then choose an environment. Enable it from that environment’s Settings page. Use **First** and **Next** to browse windows, including an empty window that offers a continuation. Open child pages from the page or library.

Tabs show as a switcher at the top of each tab group, and synced blocks show their original content. Both are read-only on mobile. Open pages update when they change elsewhere.

Databases open on mobile in every view type, drawn as lists and cards suited to a phone. Calendars and timelines show as a month agenda, and **Open database** on a page's database shows the full list. Views apply as saved on desktop; change filters, sorting, layout, properties, formulas, relations and templates there. Open a row to read it and edit its title, text, number, checkbox, select, multi-select, status, date, URL, email and phone values, and use **New row** to add one. Cell changes save right away and are not kept as a draft; if one cannot be sent, retry or discard it. Dates are entered as YYYY-MM-DD; dates with a time and formatted text are edited on desktop. Long views stop at 500 rows, or 200 per group, and point you to desktop for the rest.

Read comments, reply, resolve or reopen them, and send a comment to a session. Highlights for commented text are not shown on mobile; the quoted text appears in the comment.

Search the selected mobile environment with **First results**, then **Next results** for another window. An empty window with a continuation is not the end. If the index is building, retry explicitly. Search titles and snippets belong to that result window; select a result, then **Open current source** to resolve its current title and location. Child-page and mention links select a current-source action too, using the destination environment’s read permission. Deleted, trashed and unavailable references stay explicit. Finish the active input before opening a source; retained page drafts are kept. A linked block outside the loaded window requires manual First/Next browsing. **Reveal loaded block** attempts to show an already loaded row; it does not search other windows.

With operate permission, create or rename a space and create root pages from the mobile library. Rename a page after opening it. Finish any local edits before creating a child page or moving a page. Child creation requires a complete parent body. **Move page** checks its current position, then lets you choose a destination space and root position, or browse child pages and choose a position inside a complete page body or list. Partial bodies and some large hierarchies are unavailable here. **Undo last action** and **Redo last action** require a proven current inverse; they restore logical placement, not retired marker links or historical positions.

On an environment that supports block moves, choose **Move blocks / subtrees** from an open page. Select contiguous roots in one container; their descendants move with them. Prove the selection, then choose a destination page body or list and confirm its position. The source and destination must fit complete loaded windows. Resolve affected drafts first. Content and IDs stay intact; mixed or noncontiguous origins are unavailable on mobile.

Use **Move page to Trash** on an open page, or **Trash and restore** to browse recovery windows. Inspect the selected pages and their current placement before confirming a restore. Independently trashed batches stay separate. Visibility Undo is available only when its current batch and ownership can be proven. To permanently delete a trashed subtree, choose **Inspect permanent deletion…**, review its named pages, type **DELETE**, then confirm the irreversible action. Permanent deletion includes independent batches within the inspected subtree and has no Undo. If an operation’s outcome is uncertain, use **Recover exact operation** before making another library change. If that operation prevented a page from opening, choose **Retry opening page** after recovery finishes. Clearing connection caches keeps this recovery state.

With a current app and environment and permission to operate, choose **Edit text** on a supported paragraph, heading, quote, or list item. Select text and use **Bold**, **Italic**, or **Inline code**; a mixed selection applies that mark to the whole selection. At a caret, the mark applies to subsequent typing. Existing links are preserved. **Undo input** and **Redo input** affect only the focused native input. **Done editing** retains the draft locally and lets you scroll or choose another block; **Save** sends it. To-dos also have **Toggle to-do**. Code, callouts, unsupported marks, and future/rest content stay read-only with **Copy original block** available. On a complete page, **Add block at page end** offers a paragraph, heading level 1–3, bulleted or numbered item, to-do or divider. Use **Edit text** on a new text block, then **Done editing** and **Save**. **Delete core block** confirms removal of a supported leaf or fully loaded supported list subtree from the draft; Save commits it. Finish active input first. Partial windows, unsupported descendants and child-page markers cannot be deleted this way. After saving, use **First / refresh** before another add/delete operation. Link authoring, changing an existing heading’s level, split/join shortcuts and other formatting remain unavailable on mobile.

After saving, **Undo saved content** or **Redo saved content** can compensate the last supported text, mark, or to-do replacement when its current content and revision still match. Finish the active input and save or resolve other drafts first. These controls are separate from native input history and structural placement/visibility Undo. A failed local write keeps the attempted compensation; retry local storage and use **Save** or **Retry exact save** to resolve it. An unknown receipt stays uncertain and retains its draft.

A draft with an uncertain save or a newer saved revision shows its status and keeps its local content. **Retry exact save** checks the previous outcome; a pending save must be resolved before discarding. Finish composition or recover a rejected input before leaving its editor. If you confirm **Discard unpublished input**, the retained page draft stays. **Discard local draft** replaces the loaded draft with current saved content after confirmation. Clearing connection caches leaves page drafts on the device. Older environments keep page text read-only. Connections without operate permission remain read-only.

For supported image blocks, choose **Open image** to view one image at a time. **Refresh image URL** renews an expired or failed signed read; **Save / share original** prepares the original for the device’s share sheet. Close another Spaces image before opening a second. Image viewing requires the destination environment’s read permission and assets support. Finish active input first. Camera/photo imports and conversion remain unavailable in mobile Spaces.

For PDF or video blocks, choose **Open pdf** or **Open video**. One PDF or video can be open across Spaces views. **Renew source / retain position** obtains a fresh signed read and restores the last reported PDF page or video seek/play intent. PDF preview downloads a temporary complete file (up to 25 MiB and 2,000 pages); it is not range streaming. Video is limited to 50 MiB. Close the viewer if another source is waiting for cleanup. **Save / share original** remains available when viewing fails.

To add an original file, finish active input and choose **Choose image file**, **Choose PDF file** or **Choose video file**, then **Upload original**. On a complete page, insert it at page end and use **Save / retry exact page save**. Files are retained unchanged locally before uploading: PNG/JPEG/GIF/WebP up to 10 MiB, PDF up to 25 MiB, MP4/WebM up to 50 MiB. Two original slots share a 75 MiB total across Spaces pages. **Recover upload status** checks an uncertain upload; **Release local original** removes its file only when its upload and page-draft ownership can be resolved. A lost first grant without a retained upload handle can remain unresolved after restart; its original is kept. Clearing connection caches keeps retained originals.
