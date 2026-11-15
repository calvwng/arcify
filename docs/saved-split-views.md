# Saved two-page Split Views

Save an existing two-page native Split View from either member's Today context
menu. The **Saved Split Views** panel opens that pair as two **new** Today tabs in
the current normal window and active Space. It does not find/reuse equal URLs,
restore native split IDs, or silently join unrelated tabs. Remove deletes the
recipe only, leaving all live tabs untouched.

Recipes are local to this extension profile and contain a generated recipe ID,
a display name, and the two ordered page URLs/titles. Only HTTP(S) pages are
supported; private windows, pinned/global tabs, other windows, and ambiguous
ownership are excluded. The list is bounded to 100 recipes. Invalid stored data
is rejected without overwriting it.

The SpaceStore queue serializes all actions. Save re-resolves the exact native
pair and ownership. Reopen makes two blank tabs, admits them to current Today
ownership, persists, invokes the existing native split action, and then navigates
only those freshly created tabs. If a mutation cannot be confirmed, created tabs
stay open; there is no automatic retry, closing, or speculative rollback.

Integration: the normal sidebar loads the UI; private sidebar/entry modules must
not import it. General Undo must reject stale receipts when the exact native tab
set, ordering, ownership or split membership differs after reopening a pair.
Saving/removing metadata does not itself change layout or invalidate a still-safe
layout receipt.

Validation: `node --test tests/unit/saved-splits*.test.js tests/unit/today-split-ui.test.js` plus full unit suite and `npm run build`.
A compatible native Split View browser is required for manual reopen validation.
