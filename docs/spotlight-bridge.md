# Arcify + Spotlight bridge (protocol v1)

This optional integration keeps **Arcify authoritative** for spaces, stable IDs,
window selection, membership, ordering, and workspace operations. Spotlight owns
search, its overlay, shortcuts, and the new-tab experience. Chrome tab groups are
only Arcify's optional projection. Spotlight never writes Arcify snapshots back.

## Provenance

- Arcify baseline: `calvwng/arcify` main at
  `f714c449e1d88236de9bb45de2259abe5bf5be81` (merged PR #74).
- Spotlight upstream baseline: `phulsechinmay/arcify-spotlight` at
  `137ea1bbe503ec00e08da7d81b462e0ed87a82d1`.
- Integration branch in both user forks: `integration/arcify-bridge-v1`.
- Upstream repositories are read/fetch only. Changes belong in paired draft PRs
  in `calvwng/arcify` and `calvwng/arcify-spotlight`; no release or merge is implied.

## Install unpacked builds

Use a **test Chrome profile** first. These builds can read bookmarks and change tabs.
Keep your existing profile/bookmarks backed up using Chrome's normal export/sync.
Do not install two active copies of Arcify in the same profile: they share the
same bookmark folder namespace. Do not enable competing new-tab overrides while
validating Spotlight.

1. Clone the two `calvwng` forks and check out `integration/arcify-bridge-v1` in
   each. Use the paired PR commit SHAs for an exact reproducible revision.
2. In each checkout, run `npm ci` followed by `npm run build` (Node 22 or 24).
   `PUPPETEER_SKIP_DOWNLOAD=1 npm ci` is sufficient for builds/unit tests; omit
   that environment variable when preparing to run the repositories' browser suites.
3. Open `chrome://extensions`, turn on **Developer mode**, and **Load unpacked**
   each checkout's **dist** directory. Do not load the repository root.
4. Copy each extension's actual 32-letter ID shown by Chrome. In Arcify's options,
   use **Spotlight companion** to save the Spotlight ID. In Spotlight's options,
   save Arcify's ID. Both sides must be paired.
5. Click **Check connection** on both sides. Both must report protocol v1 connected.
   The Arcify sidebar's **Search with Spotlight** button opens Spotlight in that
   sidebar's window. The original **New Tab** button keeps its existing behavior.
6. Run the manual matrix in [bridge-validation.md](bridge-validation.md) with
   **Sync Spaces to Chrome Tab Groups** both off and on before using a real profile.

### Identity, installed builds, and updates

No Chrome Web Store ID is guessed or pinned into either manifest. Unpacked IDs may
change when a checkout moves or a different profile/path is used. An installed
build also has its own ID. Pair the IDs actually shown by Chrome, including when
mixing an installed build and an unpacked build that both implement protocol v1.
This does not make an older store release bridge-compatible.

For an update, fetch both **user forks**, check out the paired revisions, run
`npm ci && npm run build` in both, and click **Reload** for both in Extensions.
Refresh web pages with old Spotlight content scripts, then check both connections.
Keep the unpacked paths fixed to preserve their IDs. If an ID changes, re-pair both
sides. Update both when the protocol version changes. Reloading never imports a
Spotlight-owned workspace copy into Arcify.

To disconnect, use **Disconnect** in both settings pages. Arcify rejects incoming
requests immediately after its stored peer ID is cleared. Spotlight then uses its
upstream standalone behavior. A configured but missing/incompatible companion is
an explicit error: it does not silently replay a workspace action through native
Chrome APIs. After a timeout, inspect the tabs/refresh search before retrying;
Chrome may already have completed the action.

## Wire contract

Both repositories carry the same small `spotlight-bridge-protocol.js` /
`shared/arcify-bridge-protocol.js` helper. Change the protocol in paired PRs.

Every request has:

```json
{"type":"arcify-bridge","version":1,"requestId":"unique-id","command":"snapshot","windowId":123}
```

- `windowId` and tab IDs are positive integers, never Chrome's current-window sentinel.
- `requestId` is 1–80 ASCII letters/digits/underscore/period/colon/hyphen.
- Additional fields are rejected. IDs, mode, and URL fields are validated.
- Arcify accepts `hello`, `snapshot`, `activateSpace {spaceId}`,
  `activateTab {tabId}`, `openTab {url,spaceId?}`,
  `navigateTab {tabId,url}`, and `openBookmark {spaceId,bookmarkId}`.
- Spotlight accepts `hello` and `launch {mode}` where mode is `current-tab` or `new-tab`.
- `openTab` without `spaceId` uses the authoritative active space for that window.
- `openBookmark` checks the bookmark's current membership by ID, reuses only the
  same bookmark's live tab in that window, or creates one owned pin. Equal URLs in
  different spaces/bookmark nodes are not identities.
- `activateSpace` never creates a tab just because the space is empty.
- Navigating a tab preserves its existing membership. Selecting an authoritative
  live result activates the existing tab/space rather than opening a URL duplicate.

Success: `{type,version,requestId,role,ok:true,extensionId?,snapshot?,tabId?}`.
Arcify returns a fresh snapshot on all successes and `tabId` for tab operations.
Spotlight replies with its `extensionId` on hello. Failure:
`{type,version,requestId,role,ok:false,error:{code,message}}`.

Arcify snapshot:

```text
{
  windowId, capturedAt, activeSpaceId,
  spaces: [{id, name, color, bookmarkFolderId, tabIds, pinnedTabIds, temporaryTabIds}],
  tabs: [{id, windowId, title, url, active, pinned, spaceId}],
  bookmarks: [{id, spaceId, title, url, tabId}],
  warnings: [{code, spaceId, message}]
}
```

Spaces include empty spaces and remain in Arcify order. Tab membership/order is
filtered to the requested window. Chrome-pinned favorites and unowned Arcify UI/helper pages have `spaceId: null`.
Bookmark IDs are durable Chrome bookmark identities; a closed pin has `tabId: null`.
A missing/moved/unreadable bookmark folder yields a `BOOKMARKS_UNAVAILABLE`
warning for that space; live tabs and other spaces remain available. Opening a pin
still requires its exact current bookmark/folder identity and never guesses.
`capturedAt` is diagnostic, not a persisted revision or a license to overwrite state.

## Trust and lifecycle

`externally_connectable.ids: ["*"]` allows arbitrary development/installed IDs to
reach the listener, but does **not authorize them**. There are no web origin
matches. Before reading workspace data or touching tabs, both runtimes require an
exact ID match to `storage.local.arcifyBridgePeerId` and reject web sender origins.
Pair only builds you trust: a paired Spotlight can read the window's tabs and
Arcify bookmarks, select spaces, and open/navigate tabs. Pairing is profile-local,
not synced. No discovery broadcast or auto-pairing occurs.

Listeners register synchronously for MV3 worker startup. Every search/action
fetches fresh state, including after worker suspension or extension reload. Arcify
serializes bridge mutations with its SpaceStore queue and composes the same
activate/assign operations used by the sidebar. Events and stale sidebar patches
therefore cannot replace the bridge's whole state with an older snapshot.

Messages time out after five seconds. Actions are never automatically retried.
Arcify retains the last 100 action request IDs in `storage.session` to reject
conflicting reuse and return a fresh snapshot for completed duplicates. An
interrupted/pending request returns `UNCERTAIN_RESULT` rather than re-creating a
tab after worker restart. This is bounded session deduplication, not a durable
transaction guarantee across full browser restarts. Clients always generate new
request IDs and never replay actions on reconnect.

Only `http:`, `https:`, `file:`, `chrome:`, and exact `about:blank` navigation URLs
are accepted, subject to Chrome's own restrictions. Default-engine searches use
an Arcify-owned blank tab then Spotlight's existing `chrome.search` API.

## Verification commands

Arcify: `npm run build && npm run test:unit`

Spotlight: `npm run build && npm test`

With both checkouts present, run from Arcify:
`node scripts/check-spotlight-pair.mjs ../arcify-spotlight`

That smoke check compares the paired protocol sources byte-for-byte and routes
real client/server modules through mocked Chrome APIs to verify snapshots,
window-scoped opens, and version rejection.

These are builds and mocked/unit/integration tests. They are **not evidence of
extensions loaded into real Chrome**. See the explicit browser verification gap
and required manual checks in [bridge-validation.md](bridge-validation.md).
