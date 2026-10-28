# Spaces

Enable **Spaces** in **Settings → Labs** for the environment you want to use. It is off by default. Select one environment if another selected server needs an update.

Open Spaces from the app rail, the sidebar's navigation controls when the rail is hidden, or **Open Spaces** in the command palette. You can assign a shortcut in Settings → Keybindings; none is assigned by default.

Browse existing spaces and pages in the selected environment. Scroll through the current page list, or use **Next pages** and **Next spaces** to browse another window. **First pages** returns to the beginning of that branch. An empty later window does not mean the branch has no pages. On an environment that supports nested pages, expand a page to browse its direct children. Collapse branches to release them when the navigation limit is reached. Refresh pages if another device moves or renames them. You can use Up and Down to move between page rows, Home and End to reach the first or last row, and Tab to reach links and navigation controls.

In web and desktop, **All pages** shows pages across the selected environment, while **Media** finds images, PDFs and videos used by its pages. Open an item to visit its page. Pin a page from its page bar or library row to keep it in the sidebar. **Recents** lists up to 50 recently opened pages; pins and recents are shared by devices connected to the same environment. Trashed pages are hidden until restored. These views require a supporting environment; recording recents and changing pins require operate permission.

Choose **Create** at the top of the Spaces sidebar (or **New page** in a space's library) to add an untitled page to the current space and open it. The **+** beside **Spaces** creates a space. A space's **…** menu renames it or makes it the environment's default. The default space cannot be deleted. A page's **Rename** button changes its title. These metadata changes have no Undo. Resolve any affected page draft before renaming it. If another device changes a selected revision, inspect again and choose a new intent. Recover an uncertain operation's exact receipt before trying another creation or rename.

Search from a space library with **Search**; **Next results** appears when more results exist. Empty windows can still have a next page. Search may report that its index is building; retry explicitly. Opening a result or a child-page marker resolves its current page or surviving block, including moves and merges, when the environment supports current-source navigation.

With the environment's operate permission, edit a page's text and formatting, then choose **Save draft** to commit your changes. Click an empty page to start writing, and type **/** for a command menu (headings, lists, to-do, quote, callout, code, divider). Select text to show a toolbar for bold, italic, strikethrough, inline code, links and **Turn into**. Select a heading to choose H1, H2 or H3, a callout to change its icon, or code to set its language label (code is not executed). The page's **More** menu holds local undo/redo, split, join, move, delete, media removal and saved undo/redo. Select text and use the toolbar's **Link** button to add a link; place the caret in an existing link to edit or remove the whole link. Links support HTTP, HTTPS and mailto. To mention a page or block, select text or a position in supported rich text or a media caption, then choose **Insert page or block mention…**. Search and browse First/Next results in the current environment; if the editor position changes, close the chooser and select it again. Mentions keep their stored fallback label and target; activate one to resolve its current title and location, including moves and merges. Select a whole mention to replace or format it; arrow keys skip it, and adjacent Backspace/Delete removes the whole mention with local Undo available. Partial page windows allow text edits but restrict block insertion, splitting and joining. Unsupported content stays read-only.

On an environment with asset support, choose an image, PDF or video and keep its original locally before uploading. Insert ready media at the end of a complete page window, then save the page draft. Two local original slots share 75 MiB: up to 10 MiB per image, 25 MiB per PDF or 50 MiB per video; release an original after its save is confirmed or its unsent insertion is resolved. Unresolved uploads and saves retain the original. If the server has removed unreferenced media, an explicit new upload uses a new identity; it cannot replace an uncertain save. A lost upload creation reply may need the original live connection to recover.

Image previews open explicitly, with at most four previews, 48 megapixels combined and one enlarged image across views. Close another preview if the limit is reached. Refresh an expired or failed signed URL, or prepare a download of the original. Open a PDF or video explicitly; only one can be open across views. PDFs load through range requests and display up to 2,000 pages. Refresh a failed or expired URL to reopen at the retained PDF page or video position; playback may need Play again. Close the preview to release it, or download the original if the file cannot be displayed. Edit a supported media caption in the page editor using its text and link controls. To replace saved media, select its block, choose a file and keep it as a replacement original; upload it, then apply the retained replacement and save. Replacement keeps the block link, placement and caption. If the target changes during upload, cancel or begin an explicit new attempt. **Block → Remove media block** removes it from the document when you save, without deleting the original file directly. Local Undo can restore unsaved captions, replacements and removals in the current view. Saved caption and replacement changes support the last saved Undo/Redo; saved media insertion or removal does not. Copying or pasting media blocks remains unsupported.

Local undo covers edits made in the current view. **Undo saved change** and **Redo saved change** submit a new revision-checked change for the last content or formatting save, when no draft is open. Saved content insertion, deletion, splitting and joining have no saved Undo; large saves may exceed the retained-history limit. A conflict keeps the attempted draft without overwriting newer server work. Keep the page open if draft storage fails, and retry storage before continuing. An uncertain save must resolve its receipt before you can discard the draft.

Page and block placement controls offer one guarded Undo or Redo for the last bounded action when its original position and affected pages can be proven. Save or resolve affected drafts first, including drafts in another view. Trash and restore offer a bounded visibility inverse when the current batch and placement still match. Recovery may use the server's shown fallback placement; an unproven inverse is unavailable. Permanent deletion requires an inspected trashed-root selection and explicit irreversible confirmation; it has no Undo. Metadata changes stop offering the earlier placement or recovery inverse. These controls do not browse past revisions or undo arbitrary structural edits.

After opening a saved chat, visit a page and choose **Open beside chat** to keep the page in a panel. Both views share the same draft. Threads returns to your previous chat. Page links can include a block target in the URL query. An already loaded target is selected without replacing the shared draft. An unloaded target stays explicit: resolve the current source if it moved, then save or resolve any draft before using First/Next windows. The app does not scan the page to find it. The page location shows its current space and parent pages; refresh the location if it changes elsewhere.

Turning Spaces off keeps its data. Reading pages requires the destination environment's read permission; changing the setting requires permission to change its settings.

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
