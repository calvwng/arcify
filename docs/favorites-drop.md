# Dropping saved bookmarks into Favorites

The top Favorites strip contains Chrome-native pinned tabs, shared across spaces
in the current window. Dragging one saved bookmark there opens its current saved
HTTP(S) URL as a pinned, inactive tab. The bookmark stays in its original folder;
the active tab and active space do not change. Folders are not expanded or copied.

An existing tab can be reused only with that exact bookmark identity in the same
window. A nonnative tab must still belong to the source space. Identical URLs do
not merge different bookmarks. Native live-tab pinning and favicon reordering
continue to work; the HTTP(S) restriction applies only to newly opened tabs.

The hint and result appear below Favorites. A stale/moved/deleted bookmark,
changed window, external drag, or folder drop receives an explanation. The source
bookmark is never deleted or moved by this action. Dragging a native Favorite
back into a space retains the existing copy behavior, preserving its old saved
bookmark and creating a new saved copy when dropped into the saved section.

## Concurrent drops and partial failures

Origin-wide Web Locks serialize saved-Favorites operations across sidebar pages.
Exact tab/bookmark bindings and session creation receipts prevent repeated drops
from opening duplicates. The feature fails before mutation if its lock or initial
receipt storage is unavailable. A known-closed tab can be opened again after a
fresh all-window absence check. A moved, unpinned, or differently bound receipt
fails closed instead of stealing that tab or opening another automatically.

If Chrome cannot confirm a creation, the sidebar reports uncertainty and retains
the attempt marker. If creation succeeds but later linking fails, the new tab is
kept; a later drop can finish linking that exact tab. Position failures are shown
separately. There is no rollback that closes a tab, navigates it, or follows it
into another window. Chrome provides no atomic bookmark/tab transaction, so
fresh checks detect races at API boundaries without promising global atomicity.

Receipts are limited to the current browser session. Browser restart/restoration
can change native tab IDs; the feature does not guess an identity from a matching
URL. A deliberate reverse drop invalidates its exact completed receipt. An
unconfirmed create marker without a tab identity remains blocked for that browser
session; inspect Favorites rather than assuming a retry will open another tab.

Tests: `npm run test:unit`. The module and real-sidebar DOM tests are
`favorites-drop.test.js` and `favorites-drop-integration.test.js`.
