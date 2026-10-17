# Saved pin and folder moves

Right-click a saved pin and choose **Move to**, then an existing destination
Space. Ctrl/Cmd-click toggles saved-pin selection; Shift-click selects a visible
range. Right-click a selected pin to move that batch. To move a whole folder,
right-click its header and choose **Move to**. Hidden descendants move with the
folder in their original order.

Moved items appear at the destination's root, after its existing saved items in
visible order. The current Space stays selected. Exact linked live copies in
other windows follow the saved item's Space membership without changing their
page, focus or window. Shared Favorites remain separate. A mixed Today/saved-pin
selection is not a single move operation.

If the selection changes or a partial result is reported, check both Spaces
before trying again. Arcify does not automatically retry or recreate anything.
Native-pinned or split linked copies must be resolved before this move is
available. See [the browser evidence contract](saved-move-paired-ci.md) for the
automated acceptance scope and remaining manual checks.

## Mechanics

`moveSavedItemsToSpace` moves 1–100 exact saved bookmark IDs, or one exact folder subtree, to the root of another existing Space. The sidebar captures saved titles, URLs, parent IDs, child order, and the saved-bookmark inversion setting. The destination appends in visible saved order. Today selection and Today placement settings are independent.

The controller never recreates bookmarks or tabs, changes native pin state, navigates, focuses a tab/window, or selects the destination Space. It transfers every exact linked non-global live copy, including copies in other windows and copies whose current page differs from their saved URL. Global Favorites and their `sourceBookmarkId` references remain separate. A selected native split, native-pinned linked copy, unexpected binding, or ambiguous owner blocks the batch.

## Write and recovery boundaries

- The existing SpaceStore queue serializes membership. The existing bookmark writer serializes each exact relocation.
- A cross-context saved-move lock fences sidebar startup reconciliation. Binding changes also use the existing pinned-state lock. Sidebar startup releases the saved-move lock before submitting its guarded `reconcilePins` patch, avoiding queue/lock inversion.
- Before any bookmark mutation, `SpaceStore.persist` checkpoints a prepared `spaceSavedMoveJournal` together with the existing canonical membership and tab snapshot. The journal contains exact intent, parent/ancestor fingerprints, subtree contents, linked live copies, and a session-only token.
- A move revalidates the entire batch before every native bookmark call. Recovery accepts only an observed exact prefix of the requested relocations, including unchanged subtree contents and parent orders. It never executes the untouched suffix and never rolls back or recreates bookmarks.
- The membership commit and committed receipt share the same `storage.local.set` as the canonical snapshot and rank checkpoint. Its digest binds intent, canonical arrays, and the live/pending snapshot boundary.
- If the session checkpoint failed after local commit, the authoritative local receipt repairs the pending restore suffix. Prepared recovery rebases ordering checkpoints before initialization can restore tabs.
- Missing session proof forces the existing cold recovery path. The move coordinator reassigns only existing durable records with exact saved-bookmark identity; it does not replay old numeric tab IDs or match tabs by URL.
- Unresolved concurrent edits retain the journal and stop reconciliation rather than demoting pins or assigning an uncertain copy. A zero-write or partial-prefix recovery does not retry bookmark operations. Receipt-cleanup failure does not erase an already-proven completed result.

Opt-in native group projection runs only after a normal committed move, through the existing `syncSpaceGroups` implementation. Prepared and recovery checkpoints skip group projection. Active native pages and logical Space selections remain independent.

## Verification

Unit and DOM tests cover normal/inverted saved order, nested and empty folders, duplicate URLs, closed pins, linked copies across windows, global ownership isolation, stale selections, split/native-pin blockers, interrupted menus, full-batch final-boundary validation, storage acknowledgement failures, partial bookmark commits, recovery integrity, stale startup reconciliation, and cold ID reuse. Real Chrome acceptance is a separate hosted fixture; local unit/build success does not establish browser acceptance.
