# Saved Favorites

The top Favorites strip is a saved list shared across Spaces and normal,
non-private windows in this browser profile. The list survives browser restarts;
it does not sync across devices. Each Favorite has a stable ID, saved title and
saved HTTP(S) URL, independently of its open tab and independently of any source bookmark.

- Drag a saved bookmark into Favorites to save a Favorite and open an inactive
  pinned tab. Its source bookmark stays in its original folder.
- Repeated drops of the same source bookmark reuse its saved Favorite. Different
  bookmark IDs stay distinct even when their URLs match.
- Drag an ordinary live tab, or choose **Add to Favorites** in its context menu,
  to save it. Adding never activates a different tab or changes Spaces.
- **Open** and **Closed** labels describe the instance in this window. Clicking
  an open Favorite activates its exact tab without resetting its navigation.
  Clicking a closed Favorite opens its saved URL in this window.
- Ctrl+W and **Close Tab (Keep Favorite)** close only the live tab. The saved icon
  remains. **Remove Favorite** explicitly removes the shared record and unpins
  its known live tabs, keeping pages open and source bookmarks unchanged.
- Drag saved icons to reorder the shared list. This uses stable relative IDs,
  without sending a stale sidebar's whole list or moving unmanaged browser pins.

## Existing browser pins

Existing Chrome-native pins remain visible with a **Pin** label. The notice below
Favorites explains the opt-in transition: right-click a pin and choose **Keep as
saved Favorite** to preserve its icon after closing. Nothing is automatically
adopted by title, folder name or URL; upgrading never opens or closes user tabs.
Native-only pins retain their native drag/reorder behavior separately from the
saved list. Dragging an open Favorite back into a Space unpins its live tab while
retaining its saved icon. Dropping into the Space's saved section creates a new
bookmark copy and preserves any original source bookmark. Open a closed Favorite
before moving its live tab into a Space.

## Validation and failures

Only drag handlers on the current sidebar's own rows authorize a drop. External
URL/text transfers, forged dragging classes, folders, moved/deleted bookmarks,
changed source identities and stale window/Space selections are rejected. The
background worker revalidates exact source identity, current ownership and safe
URLs at mutation boundaries. The source bookmark is never moved or deleted.

All saved mutations run through the background FavoriteStore, serialized with
SpaceStore. Durable records and browser-session bindings are separate. Exact
creation receipts prevent uncertain operations from opening duplicate tabs;
partial failures keep the new page and report the issue. The status below the
strip announces pending, success, warning or failure. No rollback closes pages,
resets navigation or follows an uncertain tab into another window.

Upgrades retain earlier native-drop attempt receipts. An unknown outcome, or a
known receipt without exact current-window pinned-tab/bookmark provenance,
blocks another open. A fresh all-window query proving the old tab is gone can
permit a new page. A matching URL never clears uncertainty, and an upgrade does
not erase the old receipt automatically.

Browser restart and extension reload/update/disable clear live session identity
([Chrome session-storage behavior](https://developer.chrome.com/docs/extensions/reference/api/storage#session)).
Remaining or restored tabs stay unmanaged browser pins unless explicitly adopted;
matching URLs never imply identity. A sleeping worker restart keeps session state.
Clicking a saved icon can therefore open a separate page from a restored pin.
This is intentional conservative handling of ambiguous restoration.

## Regression coverage

Run `npm run test:unit` and `npm run build`. No local browser launch is required
for these checks; real-extension browser coverage runs in the parent CI workflow.

- `saved-favorites-ui.test.js`: real DOM controller tests for open/closed labels,
  stable IDs, exact-ID activation, context close/remove/adoption, stale close
  guards, stale render suppression, keyboard activation, drag provenance and
  bookmark-client request shape.
- `favorites-drop-integration.test.js`: imports the real sidebar, DOM modules and
  FavoriteStore against mocked Chrome APIs. The preexisting integration cases
  remain, now exercising the worker route. They cover startup pin races, root and
  nested sources, repetition/concurrency, equal-URL identities, rejected external
  and folder drops, stale/moved/deleted sources, partial failure/retry, reverse
  drag copy behavior and delayed unpin/close/window races. Added cases cover
  Ctrl+W-equivalent close/reopen, navigation preservation, explicit removal,
  native-only adoption/reorder and shared-list invalidation.
- `favorite-store.test.js`: worker-level lifecycle, restart, concurrency and
  persistence security coverage.

Assertions deliberately changed where the behavior changed: saved order no
longer issues native tab moves; new Favorite instances do not create a competing
source-bookmark binding; close/unpin leaves a closed saved icon instead of an
empty strip. Source preservation and no-accidental-close assertions remain.

### Native-only writer retirement: all 27 original unit cases

The unused sidebar-native writer was removed. Its security and failure tests now
exercise the actual background writer, rather than a dead parallel implementation.
The following map refers to test titles in `favorite-store.test.js` unless a file
is explicitly named. All original full-sidebar integration cases are retained.

| # | Original unit case | Current regression and intentional change |
| --- | --- | --- |
| 1 | One inactive native pin; fresh bookmark; no source writes | `saved bookmark creates independent durable Favorite, original tree untouched, and unbound pins remain visible` |
| 2 | Fresh URL instead of cached row URL | `fresh bookmark URL fetched before durable commit wins over an old sidebar URL`; controller request test never transmits row URL |
| 3 | Equal URLs, foreign windows and unbound twins | `duplicate bookmark URLs retain distinct Favorite IDs, tabs and provenance`; `legacy candidate in another window or with missing exact binding is never inferred from URL` |
| 4 | Exact owned live tab reused after navigation/internal URL | `live saved bookmark adoption uses exact bookmark binding despite navigation and removes Space membership`; new durable URLs are deliberately HTTP(S)-only, with explicit rejection tests for internal/file/executable URLs |
| 5 | Exact native pin without Space membership | `explicit bookmark drop adopts exactly bound legacy native pin without URL dedup or a second page` |
| 6 | Concurrent panels coalesce exact source | `simultaneous panels, repeat adds and opens create at most one exact instance per window`; full-sidebar repeated-drop test |
| 7 | Bookmark deleted during asynchronous lookup | `bookmark deleted during asynchronous source lookup cannot commit or create a Favorite`; full-sidebar stale moved/deleted source case |
| 8 | Live binding changed/tab moved/closed before pin | `live source … after receipt preparation cannot be pinned or replaced` variants; initial stale binding/window variants |
| 9 | Closed row cannot steal another Space's nonnative binding | `closed source cannot steal or silently replace a nonnative exact binding in another Space` |
| 10 | Missing lock/failed attempt storage stops before opening | `failed pending-receipt storage blocks create, and shared queue recovers for later requests`; worker queue replaces sidebar Web Locks for saved mutations |
| 11 | Binding failure preserves page; retry recovers exact receipt | `exact create receipt recovers after a later write failure without opening a duplicate`; full-sidebar partial failure/retry |
| 12 | Uncertain create blocks cross-document retries | `uncertain create never retries across later request IDs or worker recreation` |
| 13 | Returned ID storage failure retains safe marker | `a returned tab identity whose receipt write fails is retained in memory; restart blocks rather than duplicates` |
| 14 | Partial position failure never deletes/duplicates tab | `add and reorder use stable beforeId shared order; stale destinations never write or create`; full-sidebar saved reorder asserts zero native moves; controller preserves worker errors. Saved ordering no longer calls Chrome's tab-move API |
| 15 | Tab closes/moves/unpins during binding persistence | `tab … during binding persistence is never reported as a successful Favorite` variants |
| 16 | Source mutates after create; preserve page and report failure | `bookmark changed immediately after create keeps the exact new page and reports stale source without destructive rollback` |
| 17 | Own-row provenance; reject payload/forged class | Retained unchanged in `favorites-drop.test.js`; real-sidebar folder/external/forged/stale identity tests; saved-ID provenance in `saved-favorites-ui.test.js` |
| 18 | Completed receipt recovers lost legacy binding | `completed saved ownership survives loss of legacy Utils provenance without duplicate adoption`; worker-recreation regression. Completed saved ownership uses one authoritative session binding, not a competing receipt/Utils pair |
| 19 | Known-closed receipt can reopen; failed lookup is not closure | `a failed exact get cannot prove closure or authorize a duplicate create`; close/reopen lifecycle tests |
| 20 | Moved/unpinned/conflicting receipt cannot overwrite identity | Late-binding mutation variants; `exact tab replacement and move rebind across windows without URL matching or tab mutation`; `moving into an occupied Favorite window keeps destination binding and exposes incoming native pin without merging`. Explicit reopen after a verified native unpin now creates a new independent instance, preserving the old page |
| 21 | Identity changes while receipt binding is saved | `legacy adoption revalidates exact source binding after durable record persistence`; late live binding-change regression |
| 22 | Independent Utils writers preserve both bindings | Retained in `favorites-drop.test.js` with the actual Utils implementation and origin lock |
| 23 | Startup cleanup freshly preserves native pin; removes closed tab | Retained in `favorites-drop.test.js`; actual-sidebar startup pin-race case also remains |
| 24 | Live source cannot create second same-source native Favorite | `explicit bookmark drop rejects multiple legacy native candidates or a conflicting live source before writes`; concurrent same-source open tests |
| 25 | Multiple exact native candidates fail closed | Same explicit multiple-candidate regression, with no first-match selection |
| 26 | Receipt for URL A cannot relink to edited source URL B | `partial create for saved URL A never relinks its Favorite to edited source URL B`; immutable durable A may now safely recover its exact A page |
| 27 | Revalidate bookmark/ownership after receipt persistence | `in-flight bookmark URL or membership changes after receipt preparation never open a tab`; late live source membership/binding variants |
