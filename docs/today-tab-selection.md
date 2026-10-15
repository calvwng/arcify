# Select Today tabs and save a named pinned folder

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
context menu offers only the batch save command, so singular Close, Move, Pin and
Add to Favorites commands cannot be mistaken for batch actions. A singleton keeps
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
