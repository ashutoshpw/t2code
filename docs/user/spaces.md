# Spaces

Enable **Spaces** in **Settings → Labs** for the environment you want to use. It is off by default. Select one environment if another selected server needs an update.

Open Spaces from the app rail, the sidebar's navigation controls when the rail is hidden, or **Open Spaces** in the command palette. You can assign a shortcut in Settings → Keybindings; none is assigned by default.

Browse existing spaces and pages in the selected environment. Scroll through the current page list, or use **Next pages** and **Next spaces** to browse another window. **First pages** returns to the beginning of that branch. An empty later window does not mean the branch has no pages. On an environment that supports nested pages, expand a page to browse its direct children. Collapse branches to release them when the navigation limit is reached. Refresh pages if another device moves or renames them. You can use Up and Down to move between page rows, Home and End to reach the first or last row, and Tab to reach links and navigation controls.

In a space's library or page tree, choose the **+** button (**Create and manage…**) to create a space or its first root page, rename the space, or make it the environment's default. The default space cannot be deleted. A page's **Rename** button changes its title. These metadata changes have no Undo. Resolve any affected page draft before renaming it. If another device changes a selected revision, inspect again and choose a new intent. Recover an uncertain operation's exact receipt before trying another creation or rename.

Search from a space library with **Search**; **Next results** appears when more results exist. Empty windows can still have a next page. Search may report that its index is building; retry explicitly. Opening a result or a child-page marker resolves its current page or surviving block, including moves and merges, when the environment supports current-source navigation.

With the environment's operate permission, edit a page's text and formatting, then choose **Save draft** to commit your changes. An empty page can start with **Insert → Add paragraph**. Select a heading to choose H1, H2 or H3, a callout to change its icon, or code to set its language label (code is not executed). Use **Turn into** to change a block's type, and **Block** for split, join, move, delete and media removal. Select text and use the toolbar's **Link** button to add a link; place the caret in an existing link to edit or remove the whole link. Links support HTTP, HTTPS and mailto. To mention a page or block, select text or a position in supported rich text or a media caption, then choose **Insert page or block mention…**. Search and browse First/Next results in the current environment; if the editor position changes, close the chooser and select it again. Mentions keep their stored fallback label and target; activate one to resolve its current title and location, including moves and merges. Select a whole mention to replace or format it; arrow keys skip it, and adjacent Backspace/Delete removes the whole mention with local Undo available. Partial page windows allow text edits but restrict block insertion, splitting and joining. Unsupported content stays read-only.

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

The Spaces context picker is available on web and desktop. A native mobile picker
is not available yet. See [prompt recovery](./composer.md#prompt-stash) for local
storage, attachment and retry limits, and [outside agents](./outside-agents.md#spaces)
for MCP access.
