# Select bookmarks and add a batch to Favorites

Arcify can select visible bookmark rows in the current Space and add them to the
shared saved Favorites list with one drag. Your original bookmark records stay in
their folders. This does not import folder contents or move bookmarks.

## Selection

- **Ctrl-click** on Windows/Linux or **Cmd-click** on macOS toggles a bookmark.
- **Shift-click** selects the visible range from the anchor. Ctrl/Cmd+Shift-click
  adds that range to the existing selection.
- An ordinary click still opens or activates the bookmark and clears the selected
  batch. That bookmark becomes the range anchor while its exact saved identity
  remains visible in the same Space/window view.
- Escape or a background click clears selection. Switching Spaces, reloading the
  sidebar, or losing the source context resets it. Leaving focus clears a selected
  batch; a still-valid logical range anchor may remain until its context changes.
- Ranges follow the current displayed order, including visible rows projected from
  a collapsed folder. Hidden descendants are excluded. Folder headers are not
  selected and range selection never expands a folder.
- Close/remove, rename, links and other interactive controls retain their own
  actions rather than toggling the row. A modifier click on an ordinary favicon
  selects without navigating.

Selected rows have visible feedback and an announced count. Dragging a selected
row keeps the whole selection. Dragging an unselected bookmark starts a singleton.
You can select at most **100 bookmarks for one Favorites drop**; larger drops are
refused explicitly, not truncated.

## Drag into Favorites

The native drag carries a bookmark count. The insertion line and hover message
show the destination for the ordered batch. Release there to add/reopen the exact
selected bookmark identities in their visible order. Same-URL bookmarks remain
separate Favorites; URL equality is never used to merge them.

New live instances open as inactive native pinned tabs in the source window.
Existing exact instances are reused and keep their existing focus. The saved list
is shared across Spaces/windows, but this drop does not open tabs in other windows
or switch Spaces. Retained icons and the native Ctrl+W pinned-tab confirmation keep
their existing behavior.

The initial batch destination is **Favorites only**. Dropping a selected batch on
a Space, folder, temporary-tab list or other legacy single-item destination is
rejected. It must not silently move only the physical row being dragged.

## Changes and partial failures

The selection freezes exact IDs and source context when dragging starts. A changed,
hidden, deleted, moved or rebound source invalidates that frozen drag rather than
silently shrinking the batch. The background writer checks the entire selection
before starting, then rechecks each source as it processes the batch serially.

Chrome operations are not a transaction. If a later operation fails, completed
entries stay in Favorites and the remaining entries are not attempted. The status
reports completed, failed and unattempted counts. A failed entry can already have
a saved record or an uncertain live-tab result; the operation does not close pages
or delete records to roll back.

If the worker/connection ends before a result arrives, completion is unknown. Check
Favorites before another explicit drop. There is no automatic retry. Exact saved
identities and session receipts protect repeated drops from opening duplicate
instances; an uncertain creation can deliberately block further automatic opening.
Full-browser restart identity limitations remain documented in the
[Favorite lifecycle guide](favorites-drop.md).

## Implementation and verification

The selection is temporary sidebar state, not another workspace database. The
single existing background writer owns saved Favorites and live bindings. This
feature adds no permission or cross-extension protocol requirement; standalone
Arcify and the existing paired Spotlight build remain compatible.

Automated coverage includes real production-module/DOM tests for modifier ranges,
source provenance, collapsed/changed rows, controls, partial failures and uncertain
receipts. The paired Chrome scenario uses genuine Ctrl/Shift mouse input and native
dragging, checks the visible selection/count and insertion-line pixels, and verifies
source bookmarks, exact live IDs, shared ordering and other-window isolation.
Actual browser-run results are recorded in the CI artifact, not implied by unit
checks. Native Helium side-panel layout, macOS Cmd input and OS drag-image appearance
remain separate manual checks.

### Interaction references

Zen's selected-tab drag and Essentials routing, plus Firefox's visible-tab range
selection, were reviewed as interaction references. They operate on browser tabs,
not Arcify bookmark records. Arcify's implementation is independent; no Zen/Firefox
source was copied or adapted. Zen's relevant source is MPL-2.0; its internal APIs
and container restrictions were not treated as extension APIs or Arc parity.

- [Zen selected-tab drag](https://github.com/zen-browser/desktop/blob/f3dbe29d6a94353f13168bfd29e74bf622edf218/src/zen/drag-and-drop/ZenDragAndDrop.js)
- [Zen Essentials routing](https://github.com/zen-browser/desktop/blob/f3dbe29d6a94353f13168bfd29e74bf622edf218/src/zen/tabs/ZenPinnedTabManager.mjs)
- [Zen license](https://github.com/zen-browser/desktop/blob/f3dbe29d6a94353f13168bfd29e74bf622edf218/LICENSE)
- [Firefox selection handlers](https://github.com/mozilla/gecko-dev/blob/master/browser/components/tabbrowser/content/tab.js)
