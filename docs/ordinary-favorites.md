# Ordinary live Favorites

The default remains native-pinned Favorite tabs. Settings → “Open Favorites as ordinary tabs” opts future opens and explicit adoptions into unpinned live pages with global Favorite ownership. The preference is prospective in either direction: opening an already bound Favorite does not change its pin state, and toggling the preference never changes existing live instances.

An ordinary Favorite remains available across Spaces. Space switching retains its existing focus behavior; activating a Favorite does not select a different Space. Each normal window may have its own exact instance of a saved Favorite. Equal URLs remain separate Favorite identities. Closing the page keeps the saved link. Reopening uses the current preference and saved URL. The ordinary option avoids the native-pinned close behavior. The disposable Chrome harness verifies one native XTEST Ctrl+W; physical keyboard hardware and Helium acceptance remain separate manual checks.

## Updating the pair

Update both builds, reload Spotlight first and then Arcify, and refresh existing
Spotlight pages/overlays. Confirm both peers show Connected before enabling the
ordinary-tab option. The first upgrade cannot recover an association an older
build never journaled. Saved links remain, but unproven live pages are not matched
by URL. Ordinary live pages use normal-width browser tabs rather than native pins.

## Ownership and transactions

FavoriteStore is the authoritative exact-tab owner, including known-ID pending receipts. SpaceStore loads and validates that ownership before restoring, adopting, importing, or persisting tabs. Global owners are excluded from Space membership, last-tab references, restore candidates, tab snapshots, window-layout matching, cleanup, deletion, autoarchive, and native group projection. The group projector is the only group writer; exact promoted Favorite tabs are ungrouped even when group sync is off.

A new ordinary page is created inactive and pinned as a safety barrier. Its exact returned ID and ownership are persisted before the page is unpinned. A lost create response leaves an unknown-ID pending receipt and a pinned page; it never triggers a URL search or an automatic duplicate create. Known-ID failures retry the exact receipt. Explicit adoption reserves a known tab before mutation and does not close pages or change source bookmarks. A derived exclusion acknowledgment is rebuilt during Space initialization for verified adoption receipts; it only records that SpaceStore removed membership and is not a source of identity or reload continuity proof.

Ordinary ownership tolerates native pin changes. Legacy bindings without a mode retain their previous semantics: manual unpin releases ownership. An explicit reverse drag releases only that window's live binding, retains the saved Favorite, and assigns the page to a Space. Remove Favorite releases all known live instances, keeps pages open, and retains source bookmarks. Native move collisions preserve the destination binding and both pages; the extra ordinary page becomes a Space tab. Observed replacement events transfer exact identity; missed replacements are never guessed.

The durable Favorite record remains exactly `{id,title,url,sourceBookmarkId}`. The separate icon cache is unchanged. Live mode is stored only in session bindings/attempts (`mode: "ordinary"`, absent for legacy native mode). New `closeTab` and `releaseTab` commands validate exact current identities in the shared worker queue. Space cleanup/deletion commands authenticate extension-page senders, validate targets, and recheck ownership before closing tabs.

## Reload and restart limits

See [the paired witness mechanics and failure boundaries](favorite-continuity.md)
for the exact metadata and authorization checks.

The optional continuity adapter journals ownership separately from saved links. It can recover only when a configured, authenticated Spotlight session still witnesses the exact Arcify epoch/revision. The adapter runs before Space initialization and owns all session/journal writes. Failed ownership persistence blocks subsequent ownership-dependent work until the current receipt is safely persisted. A surviving own session can refresh the peer witness; an old local journal cannot enroll its own old epoch as proof.

A full browser restart, loss of both extension sessions, an unavailable/unpaired/unsupported peer, or unproven continuity leaves saved Favorites closed. Restored ordinary pages may be adopted as normal Space tabs and managed by the ordinary cleanup rules. Clicking a saved Favorite can then create a second page. No URL, title, group, or numeric-ID inference repairs this limitation. Close live ordinary Favorites before downgrading to an older Arcify build; older builds preserve saved links but cannot maintain this ownership model.

### Attach an existing page after restart

Right-click a closed saved Favorite (or focus it and press Shift+F10), choose
**Attach existing tab…**, select the existing page, then confirm **Attach to this
Favorite**. Cancel or Escape leaves ownership unchanged. This explicitly attaches
that tab to that saved Favorite in the current window. It keeps the current video
or page, saved shortcut URL, and current native pin state; it does not open, close,
navigate, or focus browser tabs. An unpinned page becomes an ordinary Favorite
even when the preference for future opens uses native pins. Other windows and
equal-URL Favorites retain their separate identities.

The dialog lists eligible tabs in the current window, prioritizing the saved
shortcut's site as a suggestion only. Nothing is preselected. Duplicate addresses
remain separate rows with tab numbers. The current page URL is displayed separately
from the saved shortcut; it is not written over the shortcut or used as ownership
proof. Space bookmarks, other Favorite owners, pending navigations, private,
transient, and split-view tabs are excluded. Up to 200 candidates are displayed.

Confirmations expire after two minutes and are lost on worker restart. Navigation
(including an observed same-address reload), movement, closure, replacement, or
changed ownership requires reopening the dialog. The worker rechecks the page,
Favorite, window, and Space placement before and after persisting ownership. Until
confirmation, PR77 Today layout recovery and Space membership retain authority.
After confirmation, the exact global Favorite is excluded from Today storage and
native Space group projection. Existing session-witness recovery is unchanged.
An independent durable provisional marker makes an interrupted attachment fail
closed on initialization, including witnessed reload recovery. Failed rollback
forces reinitialization before any later ownership choice. Older builds do not
understand this marker; finish or cancel attachment before downgrading.

This is explicit recovery, not automatic browser-restart identity restoration.
No browser-persisted document token is available here: navigation invalidation uses
browser tab events and fresh tab reads. A navigation after the ownership commit
continues in the now-attached Favorite normally. Browser/Helium acceptance remains
separate from mocked API tests.

## Verification

`tests/unit/ordinary-favorites.test.js` uses actual FavoriteStore, SpaceStore, the shared queue, and group projector with mocked Chrome APIs. It covers startup exclusions, duplicate layouts, prospective settings, exact adoption, pending retries, create response loss, group sync off/on, cleanup/deletion, close/release, window moves/replacement, private/transient validation, and adapter initialization ordering. Existing default-mode suites remain mandatory. Browser/keyboard checks are separate acceptance evidence; unit tests do not claim extension-reload or physical-keyboard acceptance.

The required [native Ctrl+W CI scenario](../tests/NATIVE_CTRL_W_CI.md) uses one
XTEST chord in the disposable GitHub display, with exact foreground Chrome
identity and independent native tab/target destruction checks. It also checks
cross-Space reuse with group sync off/on, both extension reloads and the full
browser-restart boundary. The exact `5365079` / Spotlight `019b527` checkpoint
passed all 37 full and 5 focused cases; see [the dated evidence](bridge-validation.md#verified-ordinary-favorite-and-today-selection-checkpoint-2026-10-15).
Later changes require their own exact-head run. Physical keyboard hardware and
Helium acceptance remain manual.
