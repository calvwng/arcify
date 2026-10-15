# Move Today tabs to an existing Space

`moveTodayTabsToSpace` moves 1–100 exact live Today tab IDs from the current logical Space to another existing Space. It retains the current logical Space and native active tab. It never opens, closes, navigates, pins, activates, or transfers a tab to another window; it never changes bookmarks or global Favorites.

## Internal request and response

The sidebar sends one runtime request:

```js
{
  type: 'moveTodayTabsToSpace',
  windowId, spaceId, bookmarkFolderId,
  destinationSpaceId, destinationBookmarkFolderId,
  inverted,
  entries: [{ tabId, url }]
}
```

Entries are the selected subset in captured visible Today order. Duplicate IDs, unsupported fields/URLs, current-Space destinations, duplicate Space/folder provenance, saved pins and bookmark bindings, global Favorites, native pins, unresolved restore ownership, and native split members are rejected. Equal URLs never substitute for exact tab IDs.

The handler uses the existing `SpaceStore.run` queue. It verifies fresh source and destination backing folders, active logical Space, ordinary window, live IDs/window/URLs, sole Today ownership, order and the invert setting. It rechecks after persistence's asynchronous reads immediately before the canonical write, and after persistence returns. It does not auto-retry.

The batch is appended at the bottom of the destination's visible Today order. With ordinary order, the canonical destination array appends the selected IDs. With inverted order, it prepends the reverse of the selected visible sequence. Existing destination IDs, including those in other windows, retain their relative canonical order. The source removes only the selected IDs. Source/destination order hints are cleared to respect this explicit membership edit; unrelated Spaces' restore hints remain intact.

Responses are:

```js
{ success: true, batch: { total, completed: [tabId], remaining: [], uncertain: false, destinationSpaceId } }
{ success: false, error, batch: { total, completed: [tabId], remaining: [tabId], uncertain, destinationSpaceId } }
```

`completed` and `remaining` are disjoint, unique subsets in request order. Valid-request preflight failure supplies `completed: []`, all IDs in `remaining`, and `uncertain: false`. Malformed requests or invalid senders need not supply a batch. Failed/unknown transport is not proof of a no-op.

After an attempted write fails, a fresh durable membership/snapshot readback and fresh live-tab validation establish the completed IDs. Closed, moved, navigated, split, newly pinned or otherwise changed IDs are not substituted or silently claimed complete. A partially observed or unreadable result is uncertain. The handler never overwrites a possibly committed result as rollback, and never retries the request. The UI should present partial or uncertain results without offering an automatic retry.

## Persistence, recovery and optional groups

The existing single canonical `spaces` write, Space continuity snapshot, session checkpoint and storage change notifications remain in use. Spotlight continues reading that authority and receiving existing invalidations; no paired protocol changes are required.

The local `spaceRankCheckpoint` is ordering bookkeeping, not another membership list. Its versioned rank list and SHA-256 digest bind it to the exact complete durable tab snapshot. It is written atomically with that snapshot so a failed session write cannot resurrect stale pre-move ranks, including coincident old/new ordinals. Startup uses it only with a live `spaceSession` and a verified digest; absent, malformed or snapshot-mismatched checkpoints retain the legacy session fallback. Unproven browser-restart recovery ignores the local checkpoint.

When optional Chrome group sync is off, Move makes no native group/order changes. When enabled, the existing projection may regroup/reorder tabs within their existing windows. Before adding a native active tab to an existing collapsed destination, the projection expands it and revalidates the partition. It never collapses a group containing a fresh active member, including an unowned inherited member. Thus an active moved tab can belong to a non-current logical Space without forced focus changes. Optional projection errors remain deferred; canonical membership is authoritative.

## Verification

Unit regressions cover normal/inverted visible-bottom placement, empty destinations, exact duplicate-URL IDs, protected tabs, request/sender provenance, late changes before commit and during readback, one-write/failed-write receipts, source selection, group-sync off/on active-member safety, rank-checkpoint fallback and reload after session failure, and unrelated partial restoration. Paired-browser integration is a separate required check; unit tests do not claim browser-level focus verification.
