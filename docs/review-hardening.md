# Paired review hardening, October 29, 2026

This work addresses six findings from the joint review of the existing draft
Arcify and Spotlight pull requests. It is implemented in isolated working
copies. No installed extension, normal checkout, browser profile or user setting
was changed. Native Ctrl+W remains deferred.

## Reviewed source

- [Arcify PR #75](https://github.com/calvwng/arcify/pull/75):
  `518db3df60ec74d4d181f00005b7479939d25c02`.
- [Spotlight PR #1](https://github.com/calvwng/arcify-spotlight/pull/1):
  `56cf43b1f773eab0e7d82d0645b9a48927e05616`.

These are the starting review heads, not the final published fixes. Final
integration validation, publication identities and companion pin updates are
tracked separately by the integration owner. Both pull requests remain subject
to review and CI; this record does not authorize merging.

## Corrected behavior

1. **Space deletion checks its current bookmark target.** A missing backing
   folder or one moved outside Arcify rejects deletion before tabs are closed.
   The target is checked again around individual native tab reads and before
   subtree removal. A move discovered after an earlier close stops further
   destructive work; already completed closes are not replayed or undone.
2. **Archive retries check the current destination.** A durable created/assigned
   claim identifies the original tab but cannot establish that it still displays
   the archived URL. Every target check requires that exact URL, no pending
   navigation, and completed loading. Changed targets retain the archive entry
   without creating or navigating a replacement. Fresh creates still use their
   existing initial-load observer. Post-consume display and focus checks also
   reject changed destinations; a consume already committed is reported as
   partial completion instead of inviting another create.
3. **Delayed sidebar updates cannot overwrite newer renders.** Direct native
   updates check display freshness, the committed render and row identity after
   asynchronous reads. Superseded work schedules a current refresh. An older
   title or URL cannot become permanent through the saved-section cache.
4. **Spotlight helper actions retain their original source.** Queued generic
   actions carry source/document checks through dispatch and handshake work.
   Moving or replacing the New Tab helper invalidates that captured context
   instead of silently targeting another window. Dismissal checks the original
   helper identity before closing it; provider-side checks cover the bridge
   boundary as well.
5. **Split invalidation is scoped to the relevant window.** Native changes in
   another known window no longer invalidate an unchanged Split picker. Changes
   to its own window still reject stale choices. Pairing changes and events with
   uncertain window boundaries retain conservative invalidation.
6. **Failed Today saves preserve restoration order.** Compensation restores the
   rank removed by that save when restoring its membership, without replacing a
   newer rank. A later restored middle tab can therefore retain A, B, C order.

Browser APIs expose separate asynchronous reads and mutations. These checks
reduce stale-authority windows but do not make browser operations atomic or
prove unobservable document history. Partial effects remain possible when the
browser changes between calls; the implementation stops rather than recreating
or retargeting an uncertain operation.

## Validation boundary

The focused Arcify store run passed **420 tests** across
`space-store.test.js`, `archive-store.test.js` and `today-folder-store.test.js`.
It covers moved/missing folder boundaries, both resumed archive claim stages
across worker restart, destination changes during consumption/display work,
fresh-create loading, and failed-save restoration ordering. The focused sidebar
run passed **70 tests**, including delayed updater/cache ordering regressions.

The focused Spotlight helper/routing suite passed 60 tests; the Split suites
passed 118 tests, including 16 new per-window regressions. Both strict helper
wire schemas and mismatch detection passed in the 71-test paired contract run,
and the mocked paired client/provider smoke passed. Independent source review
found no remaining substantive blocker after the additional asynchronous
boundary fixes were applied and tested.

These are focused source-level tests with simulated browser APIs. They do not
represent a full final integration result, new Helium acceptance, or native
paired-browser qualification. Native validation was not run for this record.
Full suites, builds, independent review, exact companion pins and remote CI must
be reported against the final integrated pair separately.

## Final local integration validation

On Node 25.2.1 / npm 11.6.2, the integrated Arcify unit suite passed **8,265
tests**, with four existing skips and no failures. Spotlight passed **2,580
tests in 87 files** with coverage (89.14% statements, 86.64% branches). Both
production builds passed, and Arcify packaging passed. Spotlight used
`NODE_OPTIONS=--no-experimental-webstorage`; Arcify's Python-backed test helpers
used the installed Python 3.11 executable through `ARCIFY_TEST_PYTHON`.

The initial runs exposed an unusable Windows Python alias and older simulated
browser fixtures missing the newly required helper identity/capability or
bookmark-event APIs. Corrected fixtures retain their original behavioral
assertions and add exact helper dismissal checks. The corrected full runs above
passed; independent review also checked these fixture adaptations. No test was
weakened or newly skipped to obtain these results.

Native E2E and paired-browser qualification remain remote CI work. The paired
runner explicitly requires its GitHub Actions environment and was not invoked
locally. The new native behavior has not been manually accepted in Helium.

Spotlight was published as `75aa85e1a1ff3dcdb222374c801fa98d1818c4a0`, with
verified tree `1c8d6e87d44fe06ee98c417c7bee9d680c26b86f`. Arcify's active workflow,
runner and regression pins all reference that exact companion. The 252 affected
pin tests, 71 contract regressions and mocked paired smoke passed after the
update. Publication uses expected-head guards without force; both PRs stay draft.
