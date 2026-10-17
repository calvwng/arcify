# Sidebar management scroll

Closing an inactive live bookmark or temporary tab, deleting a saved bookmark,
and refreshing bookmark or membership data keep the current management position.
The active Chrome tab continues to be highlighted but is not automatically
revealed by those operations. Loading and title changes do not scroll the list.

## Navigation versus refresh

- Genuine Chrome tab activation and explicit Space selection request a one-shot
  active-tab reveal. Duplicate activation events do not request another reveal.
- The refresh coordinator exposes `activeViewChanged` separately from bookmark
  and membership invalidation. Favorites-drop cleanup invalidates bookmarks,
  rather than pretending to select a different view.
- Activation may arrive before its new row. The reveal stays pending until that
  row renders, and is discarded if the selected tab or Space has changed.
- A row that already exists but is deliberately hidden consumes its reveal
  intent. Expanding a folder later cannot revive an old activation.

## Viewport and keyboard focus

`sidebar-viewport.js` captures the current first visible rows immediately before
synchronous DOM mutations, after asynchronous reads have finished. It restores
the first surviving identity at its previous visual offset, accounting for
native scroll anchoring and clamping to the new content extent. Folder anchors
use the header rectangle rather than the rectangle spanning all their children.

A replaced focused row control follows the same bookmark identity. Close Tab
and Remove Pin are the same management-control role even though their classes
and actions differ. Removing that bookmark uses the next surviving visible
matching control, or a preceding one. Hidden descendants of collapsed folders
are excluded. Restoration uses `preventScroll` and does not steal focus from
unrelated UI. Existing edit-session and drag guards still protect active work.

When the background publishes closed-tab membership before the sidebar finishes
its removal handler, the active Space retains the bound row until the guaranteed
repaint can replace it by bookmark identity. This preserves its own keyboard
focus across either event ordering, without retaining stale rows after repaint.

## Verification

- `node --test tests/unit/sidebar-management-scroll.test.js` imports the actual
  sidebar with its DOM and Chrome event listeners. It exercises live bookmark
  close, saved bookmark removal, temporary-tab close, repeated bottom clamping,
  focus, background-first membership updates, delayed reads, loading events,
  genuine activation and activation before row adoption.
- `node --test tests/unit/sidebar-viewport.test.js` covers nested-folder anchors,
  native anchoring, replaced focus controls, collapsed-folder focus exclusion,
  unrelated focus, deleted anchors, superseded reveal and hidden-row expansion.
- `node --test tests/unit/refresh-coordinator.test.js` covers explicit navigation
  reasons alongside the existing generation, busy-state and retry tests.
- The paired Chrome fixture has a separate native SIDE_PANEL management-scroll
  case. Browser execution is performed by the approved CI workflow, not locally.
