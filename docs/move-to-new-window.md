# Move to New Window

The tab context menu offers Move to New Window for one live Today tab, live Space pin, saved Favorite, or native browser pin. Closed bookmarks/Favorites do not offer it. Multi-selection intentionally offers no singleton move: select one live tab first. The existing New Tab row also accepts an eligible single live-tab drop. No Spotlight command is added.

The background validates the exact tab ID, source window, current Space or saved Favorite binding, saved bookmark identity, and native Split state. It calls windows.create with tabId once, preserving the live page instead of navigating, duplicating, or reopening its URL. Stale or Split targets fail before dispatch; end Split View first. Uncertain native replies are never retried automatically.

Space membership, saved bookmark identity, Favorite ID, and pin mode are kept. The destination selects the tab's Space; the source window's selection stays unchanged. Favorite reconciliation follows the same live tab ID into the new window. A Chrome group is window scoped: only the chosen tab moves, leaving its source group. Existing optional Arcify group sync projects its Space in the destination; native group IDs are not copied across windows.

Moving the source window's last tab lets Chrome close that empty window normally. No blank fallback tab is created. If a native move succeeds but reconciliation/storage fails, the error explicitly says the tab moved and asks the user to inspect the new window before another action; no destructive rollback or duplicate page is attempted.

Validation uses mocked browser APIs and the real Favorite reconciliation method. Personal browser tabs are not operated on. Browser acceptance (live page state, native group projection and last-tab UI) remains manual.

An independent review added destination checks before pin restoration, after Favorite reconciliation, before persistence writes, and after persistence. Menu dispatch also revalidates the exact rendered row and captured selection. Chrome exposes no atomic compare-and-move or bookmark/tab transaction: external changes after the final check remain a browser API limitation. Group projection can be deferred by existing sync behavior; successful movement does not claim native-browser acceptance.

## Hosted acceptance candidate (publication and installation pending)

The existing full paired-Chrome run, case 38, now also calls scripts/paired-chrome-move-window.mjs. It owns a new disposable source window and opens the real native side panel through the authenticated Spotlight command. Actual menu input moves Today, saved-pin, and Favorite fixture tabs. Independent observers require unchanged native tab IDs, document nonces, typed input, bookmark/pin records, logical membership, destination Space and Favorite bindings. A retained stale request must be refused without changes. The final menu action moves the sole remaining source tab and must destroy the empty source window without replacement pages. Expected renderer-close errors never replay input or substitute for exact state proof.

Evidence is retained in report.moveWindow and report.moveWindowNativeHosts. Cleanup removes only recorded fixture tab IDs, the exact saved folder, and nonce-scoped Favorite identities. All existing hosted sandbox/launch guards, job permissions and run order remain in force. Local checks validate syntax, rejection oracles and wiring; they do not launch this CI-only fixture. Native group projection and native-pin Favorite mode are not covered by this case. Hosted execution, publication and installation remain pending.

## Sticky New Tab drop target

The same New Tab button keeps its flow position below Today and sticks at the top of the Space content scrollport, below the fixed Space header and Favorites. Its solid theme surface, fixed icon box and single-line label avoid content showing through or row geometry changing during drag feedback. As soon as a single live-tab drag passes eligibility, it shows Move to new window and a window/arrow icon, before the pointer enters the target. Target entry adds only the drop highlight; leaving removes the highlight while retaining the label/icon for the eligible drag. Drop, cancellation, dragend and stale cleanup restore New Tab. Unsupported drags retain the ordinary label and cannot arm a target.

Local source provenance is captured by the existing sidebar drag controller. Folders, closed bookmarks, multi-selection and Split tabs cannot arm the target. A committed drop consumes the drag once, revalidates the frozen native tab/row/selection after pending saves, and uses the same exact-ID background operation as the menu. It does not run legacy reorder, anchor, pin/Favorite conversion, or Split-drop operations. A late, stale or uncertain result never automatically retries or falls back to New Tab. Cancel, blur, dragend and invalid drops restore presentation; trailing native clicks are blocked until a new pointer/keyboard gesture. Ordinary clicks retain the existing New Tab/Spotlight behavior.

Hosted case 38 now includes real wheel scroll geometry and opaque surfaces in light/dark themes, stable hover dimensions, leave/re-enter and repeated browser-native cancellation, two genuine native drops with preserved document/input/ownership, and a fixture-owned tab closing mid-drag. Native execution and publication/installation remain pending; these are prepared acceptance checks, not a claim of a passing hosted run.


## Hosted cancellation correction (local candidate, not published)

Full paired run [39199316643](https://github.com/calvwng/arcify/actions/runs/39199316643/job/117888799277) failed its strict no-mutation oracle after CDP keyboard Escape followed by mouse release delivered the drop and moved the exact fixture tab. The existing Favorites marker fixture already documents that CDP keyboard Escape does not cancel Chrome's native HTML drag controller. This evidence supports correcting the fixture, not changing the product runtime.

The candidate reuses the verified primary mouse input session and supported `Input.cancelDragging`. It requires one trusted exact-source dragstart/dragend pair, no delivered drop, dropEffect none and a reset target before releasing the mouse. Exact native tabs/windows/order, logical membership, bookmark/pin/Favorite records and page state must remain unchanged both before and after release. Drag trace/state evidence is recorded before assertions and on failure before cleanup; cleanup never releases a still-held drag based on command acknowledgement alone. No uncertain move input is retried.

Physical Escape remains a manual native Chrome/Helium acceptance check. The runtime's DOM Escape cancellation tests remain intact; a passing browser-native cancellation fixture is not evidence that a physical Escape key was exercised. The correction is prepared locally pending review and publication approval; installed builds remain unchanged.
