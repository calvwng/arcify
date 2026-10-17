# Select Today tabs, move Spaces, or save a pinned folder

Ctrl-click (Windows/Linux) or Cmd-click (macOS) toggles individual Today tabs.
Shift-click selects a visible range; Ctrl/Cmd+Shift-click adds a range. Modifier
clicks do not activate pages, including clicks on their favicons. Space toggles a
focused row, Enter activates it, and Escape clears selection.

Selections use exact live tab IDs in the active Space and sidebar window.
Same-URL tabs remain distinct. Ranges follow the current displayed order, including
inverted order, and exclude hidden rows. An ordinary click activates the tab and
seeds the next Shift anchor. Harmless rerenders can retain a selected live ID and
URL, but navigation, closure, lost ownership or source hiding removes that row.

Pinned-bookmark and Today selections are separate. A gesture in one section clears
the other section's selection and anchor. Shift never ranges across that boundary.
The existing pinned-bookmark selection, collapsed-folder projection, and Favorites
drag behavior remain unchanged.

## Save the selection

1. Select up to 100 Today tabs.
2. Right-click any selected row and choose **Save N tabs in new pinned folder…**.
3. Enter the folder name and choose **Create folder**.

Right-clicking an unselected row replaces the batch with that singleton. A batch
context menu offers supported selection actions (save, move, and eligible Split
View actions), so singular Close, Pin and Add to Favorites commands cannot be
mistaken for batch actions. A singleton keeps
its ordinary context commands. Folder names are trimmed, must not be blank, and
are limited to 256 characters. Cancel, Escape and backdrop dismissal create nothing
and send no save request.

The new folder is a child of the current Space's pinned bookmark root. Its children
appear in the same visible order as the selection, even when the order setting is
inverted. The existing live tabs stay open with their IDs, URLs and native pinned
state unchanged. Each successful tab receives its own saved bookmark identity and
moves from Today to the new pinned folder; it is not reopened. Saved URL bindings
continue to support Back to Pinned URL and existing title overrides are respected.
Another window's tabs and shared Favorites are not adopted into the folder.

Batch dragging Today tabs is not part of this command. Dragging a selected row in
a batch is refused with guidance to use the context menu. Dragging an unselected
row clears that batch and preserves the ordinary singleton drag behavior.

## Move the selection to another Space

1. Select one or up to 100 ordinary Today tabs, then right-click a selected row.
   A focused Today row also opens its menu with Shift+F10 or the Context Menu key.
2. Choose **Move to Space…**, then choose an existing destination Space.

The destination picker excludes the current Space and unbacked/ambiguous Space
identities. It does not create or restore a Space. Names are display labels; the
request identifies the existing destination and its exact backing bookmark folder.
Arrow keys, Home and End navigate the picker; Enter or Space chooses an item.
Back or ArrowLeft returns to the original menu. Escape, outside gestures, switching
menus, leaving the sidebar, and hiding the page dismiss it without moving tabs.

The selected live IDs move into the destination's Today section in their displayed
order, at its visible bottom, including when tab order is inverted. The logical
current Space stays selected. Native tab IDs, URLs, active page, browser window and
focus stay unchanged. Moving the active page can therefore leave that same page
visible while its Today row belongs to another Space. No saved pins or shared
Favorites are relocated, and the New Tab behavior is unchanged.

With native group sync enabled, the destination group stays expanded if it contains
the active page. This keeps that page visible without switching the logical Space.
With sync disabled, the operation changes Arcify membership without native grouping
or tab-strip reordering.

The menu freezes the complete visible source projection. A changed selection,
window, Space, root, inversion, URL, row identity or visible order requires reopening
the menu. Both destination identity and source selection are revalidated before a
single request; the serialized background writer rechecks authoritative live state.
Deleted/stale destinations and unsupported sources, including native Split View
members, are rejected. No activation fallback is attempted.

Partial results report the confirmed completed count and instruct you to inspect both
Spaces. A missing, malformed, contradictory or uncertain result is never presented
as a successful batch. An unknown transport result is not automatically retried.
An attempted operation refreshes the sidebar from authoritative storage, and a
refresh failure is reported alongside the operation result.

See [the Move contract and recovery details](today-space-move.md) for exact-ID
validation, atomic ordering checkpoints, failure receipts and native group behavior.

## Freshness, supported sources and partial saves

The context menu freezes the exact selected IDs, URLs, visible order, Space,
bookmark root, window and inversion setting. A changed view requires a new context
menu rather than silently shrinking or changing the batch. After name confirmation,
the background validates the entire selection before creating even an empty folder.
It rejects moved, closed, navigating, already-bound or global Favorite tabs,
non-normal/private windows, private tabs, a replaced/moved root and stale membership.

HTTP(S), file, FTP, chrome and about URLs can be saved as ordinary bookmarks.
Extension pages (including the startup launcher), JavaScript and data URLs are not
accepted. If any selected source is unsupported, the entire request is rejected
before writes; unsupported items are not silently skipped. This command does not
navigate to or execute any bookmark URL and does not change the Spotlight protocol's
URL allowlist.

Writes use the existing serialized bookmark writer with fresh live-source checks
inside its queue. Tab metadata is read again before each bookmark creation. Exact
new bookmark-to-tab bindings use the existing cross-document pinned-state lock.
If a tab changes while binding is written, only this operation's matching new
association is released; someone else's newer binding is never removed.

Chrome bookmarks, live tabs and extension storage are not an atomic transaction.
If a later write or validation fails, processing stops. A newly created empty folder
or partially populated folder remains, and no tabs or bookmarks are deleted to undo
it. The result reports the number of fully saved tabs and additional created
bookmarks needing attention. Unconfirmed association cleanup is explicitly reported.
An uncertain response says to inspect Pinned before retrying. Nothing is retried
silently and no remaining entries are attempted after the failure.

## Verification

Node tests exercise the production selection and dialog modules against a DOM,
the real sidebar context-menu/dialog/backend path with fake Chrome APIs, and the
production SpaceStore queue and bookmark writer. Coverage includes exact same-URL
identity, inversion, modifier activation suppression, section boundaries, cancel,
unselected drag, private/global sources, whole-batch stale preflight, concurrent
folder edits, close/move/navigation during creation and binding, and partial or
unknown results. Build and unit results are reported separately from Chrome CI;
these tests do not claim native pointer, geometry or OS modifier validation.

Move UI coverage also exercises the production context menu and sidebar against a
DOM: single/multiple selection, both order settings, same-URL identities, exact
request serialization, source/destination freshness, Back/keyboard navigation,
once-only dispatch, partial/unknown receipts, and refresh-gate release across
Escape/outside/blur/hidden/pagehide/removal/superseding exits. The sidebar projection
test uses a fake writer response; backend and Chrome results are separate evidence.

The paired Chrome fixture keeps a typed Spotlight query mounted while saving four
of six Today tabs (including equal-URL tabs). It checks the exact authoritative
bookmark bindings and a real paired invalidation before returning to Spotlight.
Hidden search pages deliberately defer rendering until a genuine tab return; the
fixture foregrounds that same document, without typing or reloading, then requires
four bookmark results, two remaining open-tab results, and the unchanged query and
manually selected web-search row. The saved-folder screenshot requires an expanded
folder with all four exact live rows visible. Focused fixture tests guard this
ordering and reject stale results, lost selection, and collapsed/hidden evidence;
only the real Chrome run can establish browser acceptance.

The exact Arcify `5365079` / Spotlight `019b527` checkpoint passed this native
scenario, including the visible expanded folder, exact four live identities and
unchanged mounted search selection. See [the dated full/focused results](bridge-validation.md#verified-ordinary-favorite-and-today-selection-checkpoint-2026-10-15).
This evidence does not pre-approve later context-menu features.
