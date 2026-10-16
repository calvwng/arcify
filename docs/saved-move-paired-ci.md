# Saved pin and folder Move: paired Chrome evidence

The mandatory full runner adds cases 44 and 45 before the unchanged Favorite lifecycle and browser-restart ending. Those additions retained every original 43 case. With the separate theme, recovery and initial action additions the full plan now requires 49 cases; the separate Favorite lifecycle (5) and native Split View (4) plans remain unchanged. No quick mode, skipped result, retry on the same profile, or window-B exemption can satisfy the full report.

## Real-browser fixture

`paired-chrome-saved-move.mjs` runs only in the existing non-root GitHub Actions Chrome job, using both production extension builds and the normal browser sandbox. It creates nonce-scoped localhost pages and disposable bookmark identities. No existing user data or browser is involved.

Both group-sync settings exercise:

- Trusted context-menu and destination clicks on a verified native side panel, plus real Control multi-selection, Back and Escape cancellation.
- A closed saved pin, a two-root saved-pin batch, and a nested folder containing live, closed and empty descendants. The inverted setting is checked independently against canonical bookmark order.
- Exact linked live copies in two windows, including active copies in both windows and inactive descendants. Same-URL bookmarks and pages remain distinct; an unselected same-URL saved identity stays in its original Space.
- The same bookmark as a separate global Favorite. Its durable record, session ownership and authenticated projections remain global. An unrelated native Chrome pin keeps its native pinned state.
- Native tab ID, window, URL, pending navigation, active state, pin state, page document identity, time origin and typed input. Passive native events reject transient activation, creation, closure, replacement, rewindowing or window focus changes even if the final state appears correct.
- Exact bookmark IDs, names, URLs, parent changes, sibling/descendant order, empty folders and creation timestamps. Passive bookmark events allow precisely one `onMoved` per selected root, with no recreation, removal, rename or replay.
- Canonical saved ownership, saved persistence metadata, and authenticated snapshots in both windows. With sync enabled, exact destination groups and order are required in every affected window; unrelated projection, group metadata and global grouping remain unchanged.
- Mounted Spotlight queries in both windows refresh moved closed/live results without retyping or reload, with authenticated per-window invalidation and the same search documents. Spotlight presents a bound saved pin as a bookmark result and suppresses its duplicate open-tab row; the fixture checks that presentation against the exact saved ID and per-window live binding.
- Deliberate stale destination/source rejection and a genuinely changed folder descendant. A linked tab subsequently pinned through Chrome's real API must reject before any bookmark move; the fixture never unpins it to force success.
- A witnessed extension reload with exact moved native IDs and bookmark ownership preserved. Reload does not claim full-browser restart recovery; the unchanged final restart case remains required, and backend recovery unit tests cover saved-move journal boundaries.

Every case removes only its disposable fixture data, restores the original window-B active tab/Space, and then passes the runner's original complete window-B equality gate. During the move, the validator permits only explicitly expected all-linked membership changes. It does not disable that gate or use a general exemption.

## Local checks and limits

Importing the evidence module and running its pure validator tests does not launch Chrome. Mutation tests deliberately corrupt identities, hierarchy/order, both window snapshots, global ownership, native pinning, group projection, trusted input and reload continuity and require rejection. The runner's strict count/order/status tests require all 49/5/4 selected cases exactly once.

No browser fixture is run locally. Real acceptance requires the final combined commit's hosted workflow; passing pure tests or a production build is not browser evidence. Backend storage-failure and crash-journal tests are intentionally separate from real Chrome evidence: the browser fixture does not inject fake storage errors or manufacture split IDs. Native Split View descendants and ambiguous bindings fail closed in backend tests. Physical keyboard hardware, Helium and user-profile behavior remain unverified.

The first hosted run at `6f6f370` passed the three sync-off saved moves and their complete identity checks, but stopped at an incorrect fixture expectation for an `open-tab` search row. Its captured rows already showed the destination Space on the saved bookmark results. The follow-up corrects that result-type expectation and strengthens its exact window/bookmark/live-binding checks; full browser acceptance remains pending a successful exact-head rerun.

The next run at `6edac08` passed those moves, both mounted Spotlight refresh checks, and stale/native-pin rejection, then reached the witnessed reload comparison. Its deliberately unsupported toolbar-pin negative fixture had no durable Space record, so the existing reload path correctly dropped that pin's ephemeral saved binding and name alias. The fixture now closes only that owned negative-test tab before the reload baseline and verifies all other native/saved state plus the original bookmark remain unchanged. The full reload checks still require every moved copy and binding.

Reload also legitimately regenerates live window provenance keys and compacts vacant ranks among pending Today restoration records. The evidence comparator validates these fields semantically: exact snapshot identities/order/metadata, exact live ranks/windows/native indices, one unique consistent live key per window, unchanged pending keys/indices, pending ranks unchanged or compacted to their prior merged ordinal, and identical complete live-plus-pending order in each Space/section. Missing records, changed saved bindings, reordered pending neighbors or crossing live anchors remain hard failures. No runtime behavior changes or completed browser acceptance are claimed by this test-only correction.
