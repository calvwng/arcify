# Browser New Tab helper alias regression

The first publication of the six review fixes introduced a false stale-source
rejection for Spotlight running as Chrome's New Tab override. Native paired run
`40915329529`, job `123593911187`, failed the remaining-New-Tab activation case:
20 cases passed, one failed, and 28 were not run. Its screenshot showed
`STALE_HELPER_SOURCE`; the intended target remained inactive. The other nine
paired jobs passed, but that did not qualify the full pair.

The failing pair was Arcify `dc75a678bf68d9c9a37fca7e1cbb1bcabd0ef5b6` and
Spotlight `75aa85e1a1ff3dcdb222374c801fa98d1818c4a0`. The source helper was created
at native `chrome://newtab/`, while its Chrome-attested renderer URL was the
Spotlight extension's `newtab.html`. The new capture and receiver checks
incorrectly required those different identities to be equal. Earlier helper
fixtures used matching native and document URLs and therefore missed this case.

The correction keeps the authenticated packaged document in `source.url` and
records the exact browser-attested native value separately in `source.nativeUrl`.
Capture allows only the literal document URL or the two aliases already
recognized by `isBrowserNewTabAlias`: `chrome://newtab` and `chrome://newtab/`.
This is not general URL normalization. Later native reads must match the exact
captured value, and the peer's nonce grant binds both values. Both strict wire
schemas require the separate native value. Foreign documents, lookalike URLs,
changed aliases, and tampered grants remain rejected.

Queue, navigation, move-away/move-back, pairing and final dismissal fences remain
in place. A successful switch may make the source helper inactive; inactivity
alone must not prevent the already-authorized exact helper dismissal. No active
tab lookup or active-only reuse fallback is added to this path.

The published helper module fails the new exact-alias harness with
`STALE_HELPER_SOURCE`; the corrected module passes the same assertions for both
aliases. Additional regressions exercise real background dispatch and receiver
checks, successful switching followed by inactive-helper dismissal, foreign
documents, native representation changes without events, reloads, move-away and
back, and altered grants. The native fixture's activation, source closure, and
tab-count assertions are unchanged. Independent review found no remaining
source blocker; exact-pair native CI remains the qualification boundary.

Local validation on Node 25.2.1/npm 11.6.2: Arcify's full unit suite passed
8,271 tests with four existing skips; Spotlight passed 2,603 tests in 88 files
with coverage. Both production builds, Arcify packaging, 71 paired contract
regressions and the mocked pair smoke passed. Focused alias coverage includes
30 Spotlight alias/background tests and 103 provider tests (one inherited
skip). No local native-browser or installed Helium testing was performed.

The corrected companion is Spotlight `b8b193c1f803179f86ab2e2397e5f1169256f49d`
(verified tree `9fc79e8a0cd30def6a2eca9cf935d085eb4fc8a7`). All active Arcify
workflow, runner and test pins use that exact commit. The 252 affected pin tests
passed after the update. Both existing PRs remain draft and unmerged.
