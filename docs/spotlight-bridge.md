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
   save Arcify's ID. **Either side can be saved first.** A first save may show
   **Awaiting approval**: its ID is saved locally, but the other extension has not
   accepted the reciprocal ID yet. Save both IDs explicitly; neither side auto-trusts
   an incoming request. The **Copy ID** buttons can help avoid transcription errors.
5. After both saves, click **Check connection** in Arcify and **Refresh status** in
   Spotlight. Both must report connected. A saved ID alone is not a live connection.
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

## Examples to try

- Search for an Arcify space by name and select it. Empty spaces can be selected
  without creating a tab; a subsequent new-tab URL/search opens in that space.
- Search for a live tab in another space. Selecting it focuses that exact tab and
  its owning space in the current window, without reopening its URL.
- Search for a saved Arcify pin. Spotlight reuses its bound live tab in this window
  or opens that exact bookmark. Equal URLs in different spaces remain distinct.
- Use Spotlight's current-tab mode to navigate the same tab while preserving its
  workspace. New-tab mode creates a tab in the selected Arcify space.
- Use **Search with Spotlight** in the Arcify sidebar to launch Spotlight for that
  window. Optional native tab-group sync does not determine bridge membership.

### Open the Arcify sidebar from Spotlight

With matching capability-aware builds paired, search for **Open Arcify sidebar**
in Spotlight's new-tab page or an ordinary HTTP(S) page's overlay. Select the
command with a real click or Enter. Arcify opens its own native panel for that
source tab; Spotlight does not close/navigate the page or create another tab.
An unsupported browser, missing/revoked companion or uncertain reply leaves an
error and a manual Arcify-toolbar fallback. There is no automatic retry.

The existing off-by-default **Browser startup** setting in Arcify also coordinates
an optional startup suggestion. When the unchanged, active startup tab is already
Spotlight's new-tab page, Arcify offers a one-shot preselection. The page must be
ready, visible, empty and untouched. Typing, changing selection, hiding/leaving the
page or dismissing the suggestion cancels automatic selection. Spotlight never
creates or foregrounds an extra startup tab. The existing launcher remains a
fallback when a compatible suggestion is unavailable; intentional interaction or
an uncertain delivered offer is consumed without creating a competing prompt.
See [startup-launcher.md](startup-launcher.md) for the precise fallback rules.

Chrome normally focuses its omnibox on a new tab. A selected Spotlight row does
**not** guarantee that a bare startup Enter reaches it. Focus Spotlight if needed;
Helium's initial focus and full startup/session restoration require manual checks.
Outside the accepted startup offer, an empty-query sidebar command is not silently
selected merely because other results are absent.

### Pinned-row controls

A live space pin shows **− / Close Tab (keep pin)**. It closes the live tab while
retaining its saved bookmark. Its closed bookmark row shows **× / Remove Pin
(delete bookmark)**; that action deletes the exact saved pin. It is not an archive
or a promise of recovery. Ordinary temporary tabs retain **× / Close Tab**. This
is the requested control mapping; the existing live/closed gating and handlers
are unchanged.

## Live logical-state refresh

Arcify sends a small, optional paired invalidation when authoritative membership,
order, active-space or space metadata changes, including changes with native group
sync disabled. Relevant Arcify bookmark changes also invalidate saved-pin/space
metadata. The signal contains only a window ID; Spotlight obtains a fresh snapshot
through the existing authenticated read path and never copies Arcify's database.

Notifications are coalesced and bounded. The sender checks its current saved peer,
and Spotlight checks reciprocal identity, strict version/payload and window scope
before refreshing. Query text and explicit result selection survive refreshes;
accepted invalidation discards older in-flight results. Hidden pages refresh when
visible again. Worker startup provides a best-effort refresh signal; no polling or
persistent notification queue is added. Pair changes, missing peers and timeouts do
not replay actions. Older v1 Spotlight builds reject this optional command safely
and still refresh on ordinary queries/focus; update both for live logical changes.

## Wire contract

Both repositories carry the same small `spotlight-bridge-protocol.js` /
`shared/arcify-bridge-protocol.js` helper. Change the protocol in paired PRs.

Every ordinary workspace/launch request has:

```json
{"type":"arcify-bridge","version":1,"requestId":"unique-id","command":"snapshot","windowId":123}
```

- `windowId` and tab IDs are positive integers, never Chrome's current-window sentinel.
- `requestId` is 1–80 ASCII letters/digits/underscore/period/colon/hyphen.
- Additional fields are rejected. IDs, mode, and URL fields are validated.
- Arcify accepts `hello`, `snapshot`, `activateSpace {spaceId}`,
  `activateTab {tabId}`, `openTab {url,spaceId?}`,
  `navigateTab {tabId,url}`, and `openBookmark {spaceId,bookmarkId}`.
- Spotlight accepts `hello`, `launch {mode}` where mode is `current-tab` or `new-tab`,
  `startupSuggestion {tabId}` for a single existing new-tab page, and optional
  `invalidate` with only the envelope’s `windowId` (no workspace content).
- Optional `hello.capabilities` advertises `openSidebar` from Arcify and
  `startupSuggestion` from Spotlight. Absent capability means unsupported; older
  v1 companions retain their existing behavior. `startupSuggestion` replies with
  `accepted:true`, or `accepted:false` plus `user-interaction`, `not-ready` or
  `not-eligible`. This offer never opens the panel by itself.
- `openTab` without `spaceId` uses the authoritative active space for that window.
- `openBookmark` checks the bookmark's current membership by ID, reuses only the
  same bookmark's live tab in that window, or creates one owned pin. Equal URLs in
  different spaces/bookmark nodes are not identities.
- `activateSpace` never creates a tab just because the space is empty.
- Navigating a tab preserves its existing membership. Selecting an authoritative
  live result activates the existing tab/space rather than opening a URL duplicate.

Success: `{type,version,requestId,role,ok:true,extensionId?,snapshot?,tabId?,capabilities?,accepted?,reason?}`.
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
exact ID match to `storage.local.arcifyBridgePeerId` and reject web sender origins
for these general workspace/launch requests.
Pair only builds you trust: a paired Spotlight can read the window's tabs and
Arcify bookmarks, select spaces, and open/navigate tabs. Pairing is profile-local,
not synced. No discovery broadcast or auto-pairing occurs.

The separate, sidebar-only gesture endpoint uses exactly
`{type:"arcify-sidebar",version:1,requestId}`. No caller-supplied window, tab, URL
or other field is accepted. A genuine renderer Enter/click sends directly to
Arcify. Its listener performs one callback-style read of the current saved peer
and immediately calls its own `sidePanel.open({tabId:sender.tab.id})`; it never
passes this operation through the asynchronous workspace queue or a cached
receiver-side trust decision. Chrome still enforces user activation. Responses
carry the same type/version/requestId, `role:"arcify"`, and `ok`/structured error.
No workspace snapshot is exposed by this endpoint.

It accepts only the paired extension ID, active non-incognito top-level source tab
and strict browser-supplied context: either the exact paired new-tab extension
origin/path, or the paired content script's HTTP(S) URL/origin matching its source
tab. Nested frames, opaque/file origins, mismatches and already-observed outbound
navigation are rejected. This narrow content-script route does not change the
general bridge's origin checks or expose a website message gateway. Sender tab
metadata is Chrome's message-time snapshot, not a second live tab lookup after the
storage callback; the stable tab ID is passed to Chrome, which resolves the target.
Renderer pairing/capability preparation happens before interaction and is
invalidated by pairing changes. Late replies cannot restore a revoked selection.
No new manifest permission is required in either extension.

Listeners register synchronously for MV3 worker startup. Every search/action
fetches fresh state, including after worker suspension or extension reload. Arcify
serializes bridge mutations with its SpaceStore queue and composes the same
activate/assign operations used by the sidebar. Events and stale sidebar patches
therefore cannot replace the bridge's whole state with an older snapshot.

Ordinary bridge and sidebar-command messages time out after five seconds. Startup
coordination uses a shorter 1.5-second timeout and consumes uncertain delivery to
avoid a second automatic prompt. Actions are never automatically retried.
Arcify retains the last 100 action request IDs in `storage.session` to reject
conflicting reuse and return a fresh snapshot for completed duplicates. An
interrupted/pending request returns `UNCERTAIN_RESULT` rather than re-creating a
tab after worker restart. This is bounded session deduplication, not a durable
transaction guarantee across full browser restarts. Clients always generate new
request IDs and never replay actions on reconnect.

Only `http:`, `https:`, `file:`, `chrome:`, and exact `about:blank` navigation URLs
are accepted, subject to Chrome's own restrictions. New-tab default-engine searches use an Arcify-owned blank tab then Spotlight's
existing `chrome.search` API. Current-tab text searches validate the exact source
against a fresh authenticated snapshot, check its live window and the configured
peer, then call `chrome.search` once. They never blank the existing page while
waiting for a bridge response. The sidebar's bridge launch ensures Spotlight is
open rather than toggling an already-open overlay closed. Closed saved-pin opens
initialize the same title override and exact bookmark binding as sidebar opens.

## Verification commands

Arcify: `npm run build && npm run test:unit`

Spotlight: `npm run build && npm test`

With both checkouts present, run from Arcify:
`node scripts/check-spotlight-pair.mjs ../arcify-spotlight`

That smoke check compares the paired protocol sources byte-for-byte and routes
real client/server modules through mocked Chrome APIs to verify snapshots,
window-scoped opens, and version rejection.

These commands are builds and mocked/unit/integration tests, **not evidence of
extensions loaded into real Chrome**.

The separate `Paired extension smoke` GitHub Actions job builds both pinned
revisions and runs `npm run test:paired-chrome` on an independently provisioned
runner. Its JSON report and screenshots document actual Chrome coverage, including
the tested revisions and IDs. It never disables sandbox/web security or bypasses
an installation policy. The paired PRs link the exact run and its result.

See [bridge-validation.md](bridge-validation.md) for the interactive cloud-browser
policy restriction, CI coverage boundaries, and remaining manual checks.

## Optional persistent Favorites (protocol v1)

Arcify advertises `persistentFavorites` in `hello.capabilities` when its
worker-owned saved Favorites store is available. New snapshots include ordered
`favorites: [{ id, title, url, sourceBookmarkId, tabId }]`; provenance and the
current-window exact live binding may be null. These global Favorite bindings
point only to native-pinned tabs outside Space membership. Saved HTTP(S) URLs and
titles remain unchanged when the live tab navigates.

`openFavorite` accepts only the usual envelope, `windowId`, and `favoriteId`.
It focuses that Favorite's exact current-window instance or opens its saved URL,
then returns the usual `tabId` plus fresh snapshot. It uses the same pairing,
strict payload validation, normal-window checks, request journal and SpaceStore
queue as other actions. It never accepts a caller-supplied replacement URL.

Favorite list and session-binding changes invalidate current normal windows.
The notification remains optional and best effort. Older v1 peers that do not
advertise this capability keep their existing space/bookmark/tab behavior.
See [favorites-drop.md](favorites-drop.md) for close/removal, restart, native-pin
adoption and profile-local durability limits.
