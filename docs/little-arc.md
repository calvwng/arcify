# Little Arc prototype

Status: unpublished cloud implementation. This is not approved for deployment. The existing menu/Split fixes keep their deployment priority.

## Scope

The paired Spotlight action accepts a complete HTTP(S) link and opens a compact, ordinary browser window. The destination is a real top-level native tab, not an iframe. An adjacent `Little Arc · Open in Space` control tab offers a browser-window selector and a Space selector.

The original browser window is selected when its exact ID survives. If it has closed, the user must explicitly choose another normal, non-private window. Choosing a Space moves the same native page tab into that Space's Today section. It creates no bookmark, Favorite, archive entry, replacement page, or new destination window. No page or control window is automatically closed.

Spotlight leaves ordinary URL navigation first. The secondary action is `Open link in Little Arc`; the explicit query `little arc https://example.com` promotes it. Older paired builds do not advertise `transientWindowsV1`, so they do not expose the action. Existing protocol feature negotiation remains unchanged.

No `contextMenus`, `sessions`, host, or other manifest permissions were added. Browser link menus, external OS links, and Helium changes are outside this slice.

## Ownership and transaction boundaries

- `transient-window-store.js` owns a bounded, strict session-only registry. It stores exact window/controller/page IDs and a random controller marker, not browsing URLs.
- The registry hydrates before either SpaceStore or FavoriteStore initializes. A separately named known-positive predicate is used for event provenance; the general fail-closed predicate must not label ordinary cold-worker events as confirmed transient.
- Creation holds the SpaceStore queue through controller-only window creation, exact-ID journaling, page creation, and page-ID journaling. Native `onCreated` events that arrive before the API result wait behind that boundary.
- Exclusion applies to recorded tab IDs and whole transient windows. Native drag-out/replacement does not silently grant Space ownership. Closure of the control tab alone does not release a live page.
- Space adoption, same-session replay, URL-based restore matching, Today insertion/openers, tab and window snapshots, active Space selection, patch/import/assign, cleanup, Favorite ownership/continuity, archive/reopen, and group projection all reject quarantined identities.
- Transient IDs are not global Favorite IDs. In particular, group exclusion does not ungroup temporary pages as a side effect.
- Promotion validates the exact page, controller, destination window, Space UUID, and bookmark-folder identity. It rejects native Split, pinned, incognito, already-owned, missing, or changed identities.
- Dragging a primary page through another transient window creates multiple quarantine claims. Promotion refuses that ambiguous history before moving rather than returning a success that a later reconciliation could undo. Recovery for this advanced case is not part of this prototype.
- A `moving` receipt is persisted before the one native tab move. Only the exact page receives temporary admission while the chosen Today membership is persisted and read back. The registry releases exclusion after the committed receipt succeeds.
- Pending or uncertain native outcomes are never replayed, recreated by URL, rolled back, or auto-closed. The live page remains visible and quarantined if final Space persistence is uncertain. The control UI conservatively locks further submissions after any submitted error, including timeout or transport failure. Reloading the control document can enable a new explicit choice only when the registry still proves the operation never left its ready phase.
- The one-shot call count is bounded. An unresolved native API promise does not release the queue behind a timeout while its mutation might still complete.

## Explicit restored-window recovery

When an intact exact controller marker proves a restored window, the controller lists eligible live HTTP(S) pages in that window. Nothing is preselected, even if only one page exists. Same-URL pages remain distinct native-ID choices. Pinned, private, native Split, internal/extension, already-owned, and cross-record-claimed tabs are not eligible.

`Use this page` records the user's explicit exact-ID choice in the session registry. It does not move, activate, recreate, close, bookmark, or assign any page. The selection is journaled as uncertain before becoming ready; controller/page identity and authority are fenced through both writes. Interrupted or uncertain selections remain quarantined with no replay. Every nonchosen tab remains excluded.

Recovered records carry strict `recovered: true` provenance and no originating-window ID. A separate `Open in Space` action therefore requires an explicit ordinary browser window and Space. Only that later action moves the chosen same native tab into Today. A subsequent cold restart requires explicit selection again; there is no persisted URL or assumed original page.

## First-version restart boundary

Worker suspension/restart with surviving `storage.session` is supported through exact IDs. Browser restart, extension reload/update, or disabling the extension clears that registry. A later cold start with an intact exact control marker quarantines that restored window as an orphan. It deliberately does not guess which web tab is the original page or promote it automatically.

If the user manually closes/navigates the control tab, or drags a quarantined page into an ordinary window, and then fully restarts the browser, that restored web page has no reliable surviving identity. An intact marker proves only its own restored window; it cannot identify a page restored somewhere else. The approved first-version behavior is to let that page behave like an ordinary restored tab, eligible for normal Space adoption. There is no startup hold, automatic cross-window recovery, URL guessing, or closure of unknown pages. The Spotlight action warns before launch: “After restart: no control tab → ordinary tabs”. The control tab persistently explains the missing-controller and cross-window boundary, including extension reload/update when session state is cleared. Chrome's current sessions API exposes query/restore methods but no tab/window custom-value methods. Adding the `sessions` permission would not provide Firefox's `getTabValue`/`setTabValue` capability.

Sources verified October 20, 2026:
- [Chrome session-storage lifecycle](https://developer.chrome.com/docs/extensions/reference/api/storage#session)
- [Chrome sessions reference](https://developer.chrome.com/docs/extensions/reference/api/sessions)
- [Mozilla browser compatibility data for sessions](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/api/sessions.json)

The bounded same-window recovery above is implemented and covered by offline unit and mocked integration tests. Same-session closure, navigation, or drag-out does not immediately release quarantine: the ordinary-tab boundary applies only after session authority is cleared. Regression tests change restored native IDs, clear all session storage, and prove ordinary adoption without native moves, closures, or same-URL identity guesses for each missing-controller/cross-window case. Real browser restore order, marker availability, and native navigation/form-state behavior still need supported browser acceptance before rollout.

## Verification

Cloud checks cover lifecycle journals, same-URL non-identity, normal/invalid origins and destinations, duplicate submission, storage/API uncertainty, exact admission, native-event races, worker recovery, explicit same-window orphan selection, Space/Favorite/archive/group exclusion, control DOM behavior, and existing cross-feature regressions. The Arcify/Spotlight production builds include the new files.

Run locally in each cloud checkout:

```sh
# Arcify
npm run test:unit
npm run build
git diff --check

# Spotlight
npm test
npm run build
git diff --check
```

No native paired-browser acceptance or EVOO/Helium acceptance has been performed. Source-only acceptance cases are isolated in the `little-arc` paired run mode; their requirements and limits are documented in [Little Arc paired CI](little-arc-paired-ci.md). The existing workflow has a local-only, explicit opt-in acceptance mode for this isolated slice; no workflow publication or dispatch has occurred. The repository's paired Chrome fixture is restricted to its dedicated GitHub Actions environment; do not bypass that restriction, change sandbox policy, or label source/DOM tests as native acceptance.

## Before publication or deployment

1. Confirm the approved warning and restart boundary in supported native-browser acceptance. Exact-controller same-window recovery is implemented; missing markers and pages restored elsewhere deliberately behave as ordinary restored tabs after session authority is cleared.
2. Run the prepared `little-arc` source-only cases in a later authorized supported paired Chrome job using the exact patched pair. The cases cover trusted launch, absence of adoption, same-tab/document/form transfer, explicit same-window duplicate-URL recovery after real extension reload, cancelled/stale choices, and controller/unchosen-page preservation. Add or manually verify the remaining native cases: back/forward and login state, source closure, drag-out/replacement, full browser restart, worker termination at every journal boundary, and non-replay after uncertain writes.
3. Visually verify compact-window/control-tab usability, keyboard access, long titles/URLs, light/dark appearance, and focus after transfer in the supported browser environment.
4. Re-run the complete paired regression suite on the exact unpublished pair after publication is authorized. Preserve existing menu/Split fixes and their release order.
