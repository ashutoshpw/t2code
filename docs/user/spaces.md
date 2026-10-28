# Spaces

Enable **Spaces** in **Settings → Labs** for the environment you want to use. It is off by default. Select one environment if another selected server needs an update.

Open Spaces from the app rail, the sidebar's navigation controls when the rail is hidden, or **Open Spaces** in the command palette. You can assign a shortcut in Settings → Keybindings; none is assigned by default.

Pick a space in the sidebar to see its page tree. Expand a page to see its sub-pages, and use the arrow keys to move between rows. **Next pages** and **Next spaces** appear when a list has more to show. An empty batch does not always mean there is nothing after it.

**All pages** lists every page in the environment, and **Media** lists the images, PDFs and videos used by pages. Open an item to visit its page. Search from a space's library; **Next results** appears when there are more matches.

Choose **Create** at the top of the sidebar to add an untitled page with its title selected, or the **+** beside **Spaces** to create a space. A space's **…** menu renames it or makes it the default space.

## Write on a page

Click the title at the top of a page to rename it. Click the page body to start writing; changes save automatically a moment after you stop typing and when you leave the page. If a save fails, **Retry** appears below the page. After a conflict with another device, your edits stay on this device and you can discard them.

- Type **/** for a command menu: headings, lists, to-do, quote, callout, code and divider. Markdown shortcuts also work, such as `# `, `- `, `1. `, `[] `, `> ` and three backticks. Press Enter on an empty block to leave a list or quote.
- Select text for a toolbar with bold, italic, strikethrough, inline code, links and **Turn into**. Press Cmd/Ctrl+Z to undo and Cmd/Ctrl+Shift+Z to redo.
- Select a heading to choose its level, a callout to change its icon, or code to set its language label. Code is not run.
- To mention a page or block, choose **Insert page or block mention…** from the page's toolbar.
- The editor's **More** menu has split, join, move, delete, **Remove media block** and **Undo saved change** for the last saved edit.

## Media

Choose **Media → Upload** to add an image, PDF or video to the page. To swap a file, select its block and choose **Replace selected media**. The block keeps its place and caption. Edit the caption in the page. To remove media, select its block and choose **More → Remove media block**; the file itself is not deleted. Previews open when you ask for them; if a preview link expires, refresh it.

## Pages: move, trash and restore

The **…** menu in the page header has **Move to…**, **Add sub-page**, **Copy link**, **Move to trash** and **View trash**. Pin a page with the star in its header to keep it in the sidebar's **Pinned** list; **Recents** lists up to 50 recently opened pages. Pins and recents are shared by devices connected to the same environment.

- **Move to…** opens a picker where you can search, open a page to browse inside it, or choose a space's top level. A toast confirms the move and offers **Undo**.
- **Move to trash** takes you to the parent page, and a toast offers **Undo**. **View trash** lists trashed pages with **Restore** and **Delete permanently**. Permanent deletion asks you to confirm and cannot be undone.
- If a page change didn't finish, a note under the header offers **Finish it** or **Dismiss**.

After opening a saved chat, visit a page and choose **Open beside chat** to keep the page in a panel. Both views share the same draft. Threads returns to your previous chat. Page links can include a block target in the URL query. An already loaded target is selected without replacing the shared draft. An unloaded target stays explicit: resolve the current source if it moved, then save or resolve any draft before using First/Next windows. The app does not scan the page to find it. The page location shows its current space and parent pages.

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
