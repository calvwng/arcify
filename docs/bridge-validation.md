# Bridge validation record

## Unchanged baselines (2026-10-11)

- Arcify `f714c449e1d88236de9bb45de2259abe5bf5be81`: install/build passed;
  **96/96 unit tests passed**. Existing Vite warning: `onboarding-script.js` in
  `onboarding.html` has no `type="module"`; not changed by this integration.
- Spotlight `137ea1bbe503ec00e08da7d81b462e0ed87a82d1`: install/build passed;
  **689 tests passed, 7 failed** across two integration files. These unchanged
  tests raced the unmocked remote autocomplete timeout at 3000 ms. An external
  test-only fetch stub made all 35 tests in the two affected files pass. No
  production autocomplete behavior was changed to hide the baseline failure.
- Confirmed existing Arcify event-order defect: if a pin-change persistence pass
  overlaps a different tab's `onReplaced` event, pruning can remove the old ID before
  the replacement handler transfers ownership. The same reproduction fails against
  the unchanged baseline `space-store.js`. It is retained as an explicitly skipped
  regression, not fixed or counted as a passing bridge case in this PR.
- Node v24.19.0 / npm 11.9.0, Linux cloud VM. Initial install needed a writable npm
  cache (`--cache /tmp/npm-arcify-cache`); this was an environment setup issue.

## Real-browser evidence and blocker

The supported cloud Chromium browser was inspected. Opening the required
`chrome://extensions/` page was rejected with:

> Browser Use rejected this action due to browser security policy. Reason: The
> browser URL policy blocks this action. Cloud browser cannot visit the requested
> page. The requested URL protocol is not allowed. Allowed protocols: "http:",
> "https:".

The restriction was not bypassed with another automation technology or native
route. **Neither baseline nor integrated unpacked extensions were loaded. No
real-Chrome extension behavior is claimed as passing.** The same restriction
prevents extension reload/worker-stop inspection through that route. Automated
mocked checks do not substitute for this missing evidence.

## Manual acceptance matrix (all pending real Chrome)

Use a test profile, both paired builds, two normal windows, at least two spaces
including an empty one, and equal-URL bookmarks in different spaces. Record Chrome
version, extension IDs, both commits, sync setting, screenshots, and actual results.
Repeat relevant cases with Chrome group sync **off** and **on**.

1. Standalone Spotlight: history/bookmarks/top sites/default-engine search,
   suggestions, autocomplete, overlay and new-tab page retain upstream behavior.
2. Pair IDs in both settings. Check clear connected status; test typo/self-ID,
   missing/disabled companion, unpairing, protocol mismatch, and reconnection.
3. Search/select a live tab in another space; assert exactly one existing tab is
   activated, Arcify selects its owner, and the other window is unchanged.
4. Search/select each of two same-URL bookmarks in different spaces and nested
   folders. Confirm correct bookmark identity, no duplicate live pin after repeated
   selection, and no collision with an ordinary same-URL tab.
5. Switch to an empty space through Spotlight. It stays empty and selected. Open
   a URL/default-engine search/new tab; it belongs to that selected space only.
6. Open current-tab and new-tab overlays using Alt+L and Alt+T (or configured
   shortcuts). Check focus, keyboard selection, Enter/Escape, close/cancel, repeated
   clicks, and updated results while a slower prior search is still outstanding.
7. Launch from **Search with Spotlight** in each Arcify sidebar. Confirm window
   targeting/focus; confirm the original New Tab button still works.
8. Open new tabs from each window while editing/sidebar refresh is pending;
   confirm membership/order and that stale snapshots never erase newer tabs.
9. Reload either extension; refresh existing content-script pages; suspend/stop
   workers; re-open search. Verify fresh handshake/snapshot and unchanged membership.
10. Fully restart Chrome with session restore on, then without restored tabs;
    verify stable spaces/empty spaces and correct per-window restoration within
    Arcify's existing documented duplicate-URL restoration limitations.
11. From a separate, unpaired test extension, send valid-looking and malformed
    requests, wrong versions, unsupported commands, forged window/tab IDs, and
    repeated request IDs. Verify rejection/no state mutation; do not expose a
    website message gateway for this test.
12. Induce a response timeout after an action. Verify visible error, no automatic
    retry/native fallback, fresh state on next search, and no duplicate action when
    the same request ID is delivered again within the same browser session.

Final automated counts and paired draft PR links are recorded in the PR descriptions.
