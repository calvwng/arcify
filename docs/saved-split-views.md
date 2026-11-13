# Inline pinned two-page Split Views

**Pin Split View** on either member of a native Today split creates one ordinary
bookmark-backed row in the active Space's Pinned tree. There is no separate saved
splits section. The row uses the existing Rename, Remove Pin, ordering and folder
controls. The bookmark title is the pair's name. Closing the pair keeps its pin;
Remove Pin deliberately removes only the shortcut, not its open pages.

Clicking an intact, witnessed live pair focuses it without duplicating pages.
Otherwise the existing guarded split engine creates exactly two new Today tabs
and splits them before navigation. Equal URLs are never evidence of identity.
The row replaces the two Today rows only while the background verifies an exact
normal-window, same-Space, two-member native split witness. A closed member,
changed split, missing receipt or uncertain metadata reveals Today rather than
hiding or closing an unrelated page. Witnesses are session-only; browser restart
reattachment is not implemented by this change.

A live pair can be reordered or placed in folders within its Space. Moving its
pin (or containing folder) to another Space is currently refused with a clear
close-first message while any witnessed member remains open. This is a safety
limitation, not full live compound-transfer support. Native Bookmark Manager or
Sync edits cannot be intercepted; their changed ownership invalidates the old
presentation witness and reveals its pages in their original Today location.

## Storage, migration and fallback

Recipes still contain only explicit HTTP(S) page URLs/titles and a generated ID.
The new `splitPinsV1` record binds an exact created bookmark ID to a recipe; its
URL is an inert local `saved-split.html` landing page. That URL never authorizes
pair reuse. Native bookmark clicks and unsupported consumers get the inert page,
not an automatic pair. Synced/imported/copied markers without the local record
remain unclaimed. Only normal-window sidebar requests can operate these pins.
Favorites and Spotlight do not gain a new cross-extension split protocol here.

Legacy recipes have no original Space provenance. Migration chooses the first
stable Space ID once and persists its destination, announces it in the existing
status area, and preserves a one-time legacy backup. Migration opens no tabs.
Users can move resulting closed pins normally. Each bookmark creation uses the
shared canonical bookmark writer and a durable intent. Only a returned creation
ID or an explicit recovery choice authorizes association. Known no-write failures remove the intent so later explicit
attempts may retry; an unknown actual create is not retried or adopted by URL.
Independent recipes still migrate, and the status area reports retained failures.
Unconfirmed intents expose the bounded explicit review described below; no
automatic retry or identity inference is performed.

Intentional removal reclaims the recipe and pin record atomically on the next
pin/migration action, so removed pins do not reappear or permanently consume the
100-active-recipe limit. It never deletes live pages. Legacy backup data is kept.
An older build ignores the new metadata and may show an inert/unavailable marker;
restore a compatible backup rather than treating a marker as a normal web page.

## Verification

`node --test tests/unit/split-pin*.test.js tests/unit/saved-splits.test.js
 tests/unit/today-split-ui.test.js tests/unit/sidebar-pin-initialization.test.js`
plus the full unit suite and `npm run build`.

The native paired Chrome fixture exercises the ordinary pin row: focus without
duplication, missing-witness behavior without URL guesses, close retaining its
pin, reopen, and unpin retaining live pages. Helium acceptance remains separate.

## Interrupted creation review

A compact **Review saved pair recovery** button appears only for pending/deferred pin receipts. Opening it does not adopt anything. **Use this bookmark** explicitly associates the selected exact marker (ID, title, Space and folder shown) with the displayed saved pair after fresh validation. Matching URLs alone never confer ownership. Other copied markers are untouched, and recovery neither opens tabs nor reconstructs live witnesses.

If no marker is visible, **Keep recipe for later** retains the recipe and marks its receipt deferred. This releases the global pending-save block without retrying creation; later migration also skips it. The review remains available if a late marker appears. Recipes count toward the existing 100-pair safety limit. Creating a replacement when the old marker is permanently missing remains a separate, unimplemented explicit flow; no uncertain creation is silently replayed.

The first recovery/defer mutation atomically keeps a one-time `splitPinRecoveryBeforeV1` snapshot of pin metadata and recipes. The new deferred phase is not understood by earlier experimental #86 builds; those builds reject this metadata instead of changing it. Rollback after deferral therefore requires a compatible build or a deliberately restored, verified pre-recovery backup. Do not simply downgrade to an earlier #86 build and expect pending/deferred operations to work.
