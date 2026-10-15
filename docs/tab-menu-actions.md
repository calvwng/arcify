# Tab and Space-pin context actions

Right-click a single Today tab or saved Space pin. The action belongs to the clicked row, never an unrelated active tab.

- **Copy Link:** copies the live tab's current URL, or the exact closed pin's saved URL. A closed/moved live tab fails instead of falling back to the active tab.
- **Rename:** Today tabs use an Arcify-only alias keyed by live tab ID. A blank name resets the page title. Live and closed Space pins update the existing bookmark title by exact ID. Saved Favorites remain unchanged. Live rows also retain double-click Rename; closed pins use the menu so starting an edit cannot open their page.
- **Edit Pinned URL:** accepts a complete supported URL for a live or closed Space pin. It preserves the title, bookmark ID, containing folder, and sibling order. It changes future opens and Back to Pinned URL, without navigating an open tab. The existing current-page shortcut is called **Use Current URL for Pin** and also preserves the saved title.
- **Mute / Unmute Tab:** live rows only, reading current mute state before applying the change.
- **Duplicate Tab:** ordinary live Today tabs only. Uses Chrome duplication, assigns the new tab to the original current Space adjacent to the source in canonical Today order, and copies no saved binding or Arcify alias. Other tabs and their ordering remain intact. If creation succeeds but assignment cannot be confirmed, the UI reports that partial result and does not retry or close the duplicate.
- **Remove Pin:** removes saved Space membership by exact bookmark ID while retaining open pages as Today tabs. **Close Tab (Keep Pin)** closes only the live instance.

## Selection and stale-state boundaries

Multiple Today tabs retain the existing **Save tabs in new pinned folder** action. Multiple selected pins show a single-item-edit hint; no singleton action is presented as a bulk edit. Ranges and actions do not cross Today/Space-pin boundaries. Favorites editing and expanded Move To destinations are outside this change.

The background action handler shares SpaceStore's serialized queue and validates current Space, window, ownership, bookmark parent, and live binding. Editors compare their original saved metadata or alias/URL baseline before writing. Closed, moved, rebound, deleted, native-pinned, global-Favorite, and cross-window live targets are rejected. Equal URLs never substitute for identity. Name input is plain text; saved URL schemes are restricted to HTTP, HTTPS, file, FTP, chrome, and about. Control characters, unsupported schemes, and oversized values are rejected.

Chrome bookmarks does not expose transactional compare-and-swap. The handler rechecks before writing and verifies the resulting metadata, but native Bookmark Manager/Sync edits can still race an individual Chrome API call. Partial saved-edit/refresh failures are reported without silently retrying.

Aliases are projected into Spotlight snapshots, tab search, and recent results without changing protocol shape. Snapshot title projection uses the exact saved pin title at the pinned URL and the real page title after navigation. Alias add/rename/remove and pin-binding URL changes invalidate affected live windows. Sidebar metadata-only storage changes explicitly repaint even when Space membership is unchanged.

## Automated verification

- `tests/unit/tab-menu-actions.test.js`: real handler and SpaceStore queue, exact-ID twins, live/closed saved edits, cross-window bindings, stale ownership and metadata, URL/name validation, copy/mute/duplicate, partial failures, sender validation.
- `tests/unit/tab-menu-ui.test.js`: actual dialog/actions DOM, Cancel/Escape/backdrop, text sanitization, focus return, repeated clicks, active-Space change, errors and selection boundaries.
- `tests/unit/today-sidebar-integration.test.js`: actual sidebar module, context menus, Chrome listeners, dialog/backend integration, same-URL Today folder save, saved title/navigation, metadata-only repaint, clicked copy/mute/duplicate and stale saved pin.
- `tests/unit/tab-title-projection.test.js`, `spotlight-bridge.test.js`, `spotlight-invalidation.test.js`, and `startup-launcher-background.test.js`: alias projection/search/recent results, exact saved bindings, strict wire shape and scoped invalidation.
- `tests/unit/space-context-sidebar.test.js` and combined Today sidebar tests: newer Space/Tab gestures close the prior menu, discard stale asynchronous menu/editor lookups, and cancel only unsubmitted editors. Submitted writes still report their results.

The isolated paired runner includes the genuine-input Tab menu module described in
[the paired fixture contract](tab-menu-paired-ci.md), including required screenshots,
source-page preservation and an authenticated invalidation followed by a genuine
return to the same mounted Spotlight query. The [paired run at Arcify `3f450f3`](https://github.com/calvwng/arcify/actions/runs/38719535714)
with Spotlight `019b527` passed all 39 full-suite cases, including these actions,
on Chrome 155.0.8059.39. Native sidebar-panel layout and Helium-specific manual
acceptance remain outstanding; the menu module exercises ordinary sidebar tabs
in a disposable CI profile.
