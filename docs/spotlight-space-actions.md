# Optional paired Space actions (`spaceActionsV1`)

This is an additive protocol-v1 feature. Arcify remains the sole Space/bookmark
writer. Spotlight only describes an exact current context and submits one of four
bounded commands. This slice has no Favorites, native pin, Split View, arbitrary
Move To, rename, mute, duplicate, or close command, and adds no permissions.

## Negotiation and compatibility

A new Spotlight client sends `hello` with the unique allowlisted feature array
`["globalFavoritesV1", "spaceActionsV1"]`. Arcify advertises `spaceActionsV1` only
when the caller supplied it. `actionContext` and all four mutations require the
marker. Existing snapshot shapes and existing optional Favorites fields are
unchanged. An older peer may reject the new marker; Spotlight may retry a
read-only hello with the earlier marker and then a bare hello, but must never
fall back to legacy writes to implement these actions.

All commands retain the ordinary envelope: `type: "arcify-bridge"`, `version: 1`,
a unique request ID (1–80 `[A-Za-z0-9_.:-]` characters), an exact positive integer
`windowId`, `command`, and `supportedFeatures`. No surplus fields are accepted.

## Exact context

`actionContext` adds `{tabId}`. The supplied ID must be the active tab in the
specified normal, non-incognito window. There is no previous-tab, last-focused
window, opener, group-name, or equal-URL fallback. The response has the normal
success envelope, `extensionId`, `snapshot`, and `actionContext`:

```js
{
  windowId, spaceId, bookmarkFolderId, pairingGeneration, sourceTabId,
  tab: null | {
    id, url, title, section: "today" | "saved",
    bookmark: null | { id, parentId, title, url }
  }
}
```

Every key shown is required. `pairingGeneration` is the exact persisted pairing
generation, or `null` only for legacy pairings without one. IDs are nonempty
strings of at most 200 characters; tab/window IDs are positive safe integers.
Captured titles are at most 1,024 characters without controls. URLs use the
existing v1 safe-URL allowlist and 16,384-character bound. Today has
`bookmark: null`; saved context has the exact bookmark ID and captured metadata.

The selected Space and its exact associated bookmark root must be valid and
unambiguous. A helper page, native pin, global Favorite, split pane, unresolved
recovery tab, or ambiguous member gets `tab: null` while valid selected-Space
context remains usable. In particular a Spotlight new-tab helper never borrows
the page visited before it. A stale/closed/inactive supplied source ID fails with
`STALE_CONTEXT` rather than guessing.

## Commands and results

All four mutations echo the entire captured `context`. The envelope window must
match the context. Success includes the standard envelope and fresh `snapshot`,
without `extensionId`, plus only the documented result IDs:

| Command | Additional request data | Additional success data |
| --- | --- | --- |
| `openSettings` | none | `{tabId}` |
| `createSpaceFolder` | `{title}` | `{folderId}` |
| `pinCurrentTab` | none; context must be Today | `{tabId, bookmarkId}` |
| `removeCurrentPin` | `{confirmed: true}`; context must be saved | `{tabId, bookmarkId}` |

Settings creates Arcify's own options page in the exact source window. It never
focuses an existing settings page in another window. The source page is retained.

Folder titles are trimmed nonempty plain text, maximum 256 characters with no
controls. Creation is in the selected Space root using the existing folder
policy; the bookmark API is the commit. A folder-only action does not depend on
an unrelated Space-state persist succeeding.

Pin creates one new bookmark for the exact Today tab, using its captured current
URL and Arcify display title. It does not reuse or change an existing same-URL
bookmark. The exact binding is persisted before membership changes.

Remove Pin means **delete this exact saved Space bookmark and keep all its exact
linked live copies open as Today tabs**. Spotlight must show that meaning in an
explicit confirmation. This is not Close Tab, remove native Chrome pin, or remove
a Global Favorite. All live copies and their windows are checked; ambiguous,
incognito, global, native-pinned, helper, or split copies reject the operation.
Separate same-URL bookmarks and their bindings are untouched.

Pin/removal retain live page identities, URLs, selected Spaces, focus, and native
order during execution. They skip immediate native group projection. Existing
ordinary reconciliation remains available: when the user has group sync enabled,
a later normal projection can apply its existing native ordering preference.

## Queue, race, and failure boundaries

The bridge journal and SpaceStore queue serialize commands. Pin uses the existing
queued bookmark writer; both transitions use the shared binding lock. Remove is
extracted from the existing tab-menu operation, with the sidebar's original
behavior preserved. These internal helpers never re-enter `store.run()`.

Every mutation boundary rechecks the exact source tab, selected Space/root,
captured URL and saved metadata, current bindings/membership, and current pairing
generation after awaited reads. A temporary native/storage-event fence rejects
changes during those reads, ignores unrelated background tab updates, and
recognizes only exact delayed events from its own confirmed writes. Persist's optional guard also reaches restored
metadata, local/session writes, and Favorite selection-checkpoint writes. The
paired path does not roll back or recreate a bookmark/binding after a failed or
revoked post-commit guard.

Chrome APIs have no multi-resource compare-and-swap transaction. A native/Sync
change can still race the final API call. Confirmed bookmark writes followed by
binding, membership, receipt, journal, or display failures return `PARTIAL_COMMIT`.
An unconfirmed bookmark call returns `UNCERTAIN_RESULT`. The message directs the
user to check Arcify; the client must not automatically retry either outcome.

The bounded session journal retains at most 100 request fingerprints. Repeating
a completed request ID returns its recorded result and refreshed snapshot, never
re-executes it. Reusing an ID with different data fails. Pending outcomes remain
uncertain, including after service-worker reload; there is no automatic replay.
Confirmed action results are journaled before ancillary snapshot refresh.

## Verification

`spotlight-space-actions.test.js` exercises the real bridge queue/journal and
shared actions with API mocks: helper context, same-URL identities, exact saved
metadata, all linked copies, current-tab changes/closure/movement/navigation,
Space/root changes, generation replacement/revocation during reads and writes,
partial bookmark/binding/storage/journal failures, repeated request IDs, and no
cross-window focus or native reorder. It also checks the real SpaceStore persist
guards. `favorite-continuity.test.js` checks every optional selection-checkpoint
write boundary; existing tab-menu tests protect sidebar removal semantics.

These are automated API/DOM tests, not an interactive Chrome or Helium run.

The separately negotiated next slice is documented in [Space navigation](spotlight-space-navigation.md). Its new commands do not expand the meaning of `spaceActionsV1`.
