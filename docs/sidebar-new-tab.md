# The Today New Tab row

The sidebar has one **+ New Tab** row, immediately below the Today divider and
above Today tabs. It stays there in empty Spaces and with inverted tab ordering.
It is a native keyboard-accessible button, outside the sortable/selectable tab
items. The separate **Search with Spotlight** footer button is removed. The
footer remains a stable home for selection notices, launch status, URL-copy
feedback, and the guided tour's insertion anchor.

Clicking the row first uses the paired Spotlight `hello` and existing
`launch { mode: 'new-tab' }` flow. Spotlight retains its existing overlay/helper
reuse, draft/input handling, and focus behavior. Ctrl+T is unchanged. This change
does not add an omnibox-focus fix or alter Chrome/Spotlight's shortcut handling.

If no companion is configured, or its read-only handshake explicitly reports
absence, missing reciprocal pairing, or an unsupported version/capability,
Arcify creates one ordinary new tab in the clicked window and selected Space.
The URL is omitted, so Chrome's configured default new-tab provider applies,
including any installed new-tab override. The fallback is not a forced Google,
blank, or Spotlight URL. A returned tab is explicitly assigned by exact native
ID before activation; a different active native tab's Space or opener cannot
redirect its ownership.

The row announces progress and coalesces clicks while its request is pending.
Successful Spotlight and ordinary fallback launches clear that feedback; no
persistent success message reserves sidebar space. Actionable errors stay visible.
The worker also coalesces concurrent New Tab requests for the same window and
Space. It captures the active native tab and rejects stale source-window,
Space, pairing, navigation, or focus changes before dispatch. A cold worker uses
the existing SpaceStore initialization gate. It does not hold the workspace
queue while waiting for Spotlight.

After a launch is dispatched, a timeout, closed response channel, or launch error
may hide a completed action. Arcify reports that the user should check their
tabs; it never automatically creates another tab or retries that launch. A
failed fallback creation/assignment/activation is likewise reported without
creating another tab. Pending-request coalescing is lifetime-local, not a claim
of persistent deduplication for a new click after worker/browser restart.

## Checks

- `tests/unit/sidebar-new-tab.test.js`: placement, native accessibility, pending
  input coalescing, status, editor/focus retention, and untouched Ctrl+T handling.
- `tests/unit/sidebar-new-tab-launch.test.js`: exact source validation, cold
  initialization, handshake versus dispatched failures, window/Space/pairing/
  navigation fences, repeated requests, default-provider fallback, and partial
  native outcomes.
- `tests/unit/sidebar-active-view.test.js`: the real sidebar moves the same button
  across empty/nonempty Spaces and metadata replacement/deletion, retaining the
  shared notices and tour anchor.
- `tests/unit/spotlight-bridge.test.js`: registered fallback through the real
  SpaceStore queue, with default-provider URL and incidental opener identity.

Run `npm run test:unit` and `npm run build`. Mock DOM/API tests do not establish
native Chrome or Helium focus/shortcut behavior; paired browser checks are a
separate layer.

## Sticky placement and live-tab drops

The row stays in its normal Today flow slot, then sticks to the top of the Space content scrollport without covering the Space header or Favorites. Its theme background remains opaque in normal, hover, drag and busy states. Eligible single live-tab drags temporarily offer Move to new window with a fixed-size window/arrow icon. Folders, closed bookmarks, multi-selection and native Split tabs are rejected. Normal New Tab clicks and keyboard activation are unchanged; cancelling or completing a drag cannot synthesize a new launch.

See [Move to New Window](move-to-new-window.md) for exact identity, ownership, partial-failure and no-replay behavior. DOM tests cover lifecycle and source rejection. The prepared hosted case tests real sticky/theme geometry and genuine drag/drop/cancel/stale input in its disposable profile; native acceptance is pending.
