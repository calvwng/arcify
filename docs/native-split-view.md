# Native Today Split View

Arcify uses the browser's own `chrome.tabs.createSplit([firstId, secondId])`
and `chrome.tabs.unsplit(splitViewId)` methods. Both must be available. The
[Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-createSplit)
documents these methods from Chrome 155; a Helium build must expose compatible
methods. Arcify does not embed pages, duplicate tabs, or change the browser.

## Scope and gestures

- Select exactly two ordinary live Today tabs in the active Space, then choose
  **Create Split View** from the context menu. Space toggles row selection;
  Shift+F10 or the Context Menu key opens the keyboard menu.
- Drag one Today row onto another row's separately labeled **Split View** target.
  The ordinary before/after drop zones keep their reorder meaning.
- **End Split View** identifies the exact existing pair and keeps both pages open.
- Favorites, saved pins, helper/extension pages, incognito windows and already
  split tabs cannot be used to create a pair. Both tabs must have the same native
  window, group and pinned state. No automatic pin/group conversion is attempted.

## Order and failure handling

Native Split View requires adjacent tabs. If the selected tabs are apart, the
serialized Space writer moves only the later native tab immediately after the
earlier one and makes the corresponding minimal canonical relocation. Other
tabs retain their relative order. Native left/right order determines the pair;
the inverted sidebar display preference does not reverse browser panes.

Before each mutation, Arcify rechecks exact IDs, URLs, indices, ownership,
active Space, normal window, saved bindings, native group and split state.
After any adjacency move it verifies the full native order, persists canonical
order with optional group projection suppressed, and revalidates before the
native API call. Split success is confirmed through fresh native pair state.

A failed native call after a completed move reports that the adjacency change
remains. Arcify does not retry, close tabs, restore an old order over newer native
changes, or make replacement tabs. A later explicit action is a new request.

If a native split appears during a pin/Favorite save, the live promotion is
refused and any already-saved bookmark or Favorite link is reported as a partial
result. Only this attempt’s exact live binding/reservation is cleaned up; saved
links and unrelated bindings are retained. Reverse moves also check exact live
ownership before releasing it. If a saved-pin deletion already completed before
a later native-state change, Arcify reports that partial effect without recreating
the bookmark or retrying the move.

Split IDs and row snapshots are session-only. No new permission, durable split
identity or URL-based partner matching is introduced.

## Existing-pair protection

Single-member moves, duplication, pin/Favorite promotion and saving Today tabs
to a pinned folder require ending the native split first. Optional group projection preserves
split membership and native group relationships. Compatible known-group metadata
(including active/inactive collapse) can still update, and unrelated Spaces still
project. Incompatible structural grouping and cosmetic whole-window group order
wait until Split View ends. Native split updates schedule another projection.
New opener children are inserted after a freshly verified intact pair, or appended
when that insertion edge is uncertain. External browser actions can still change
native split state; Arcify reconciles those changes rather than intercepting them.

## Verification

Unit tests cover exact-ID validation, native API availability, order preservation,
nonadjacent partial effects, navigation/move races, projection/promotion guards,
keyboard accessibility, explicit split drop routing and duplicate-drop suppression.
The isolated local implementation does not launch Chromium. Real browser API and
trusted input acceptance is performed by the separately approved sandboxed GitHub
fixture; Helium-specific visual behavior remains a separate acceptance check.
