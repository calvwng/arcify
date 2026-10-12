# Optional startup launcher

Arcify can show a small, ordinary extension tab when Chrome starts. The page has one primary action: **Open Arcify sidebar**. This is a separate feature from the optional Spotlight bridge.

## Enable or disable

In **Arcify Settings → Browser startup**, turn **Show an Arcify startup tab** on or off. It is off by default and takes effect at the next browser startup. Existing settings, spaces, bookmarks, archives, tabs and bridge pairing are preserved. Turning it off does not close tabs Chrome has already restored; close an existing launcher tab normally if you no longer want it in the restored session.

The launcher never opens the sidebar automatically. Chrome requires a real user action. Click the button, or focus it with Tab and press Enter/Space. Its native button calls `chrome.sidePanel.open({ tabId })` immediately from the trusted click handler. The page resolves its own tab ID before enabling the button; Chrome finds that tab's current window even after a tab move. There is no message, asynchronous lookup, synthetic click or timer ahead of the call. Rejected calls show a retry/toolbar-icon fallback. The page stays open after success, so the user chooses when to close it.

`sidePanel.open()` requires Chrome 116 or a compatible browser. On unsupported browsers the page explains the toolbar-icon fallback. See [Chrome's Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-open).

## Startup and restore behavior

- One launch attempt per browser session, only after `runtime.onStartup`. Installation, an extension reload, worker suspension/resumption, subsequent windows and changing the setting do not independently create launcher tabs.
- A short 750 ms quiet period allows startup tabs to restore. A stored pending request and a separate one-shot alarm cover service-worker interruption; existing auto-archive startup/alarm hooks continue unchanged.
- Only ordinary, non-incognito browser windows with existing tabs qualify. Arcify never creates a browser window for the launcher. If none exist yet, it waits for one.
- In the initially focused normal window, the new tab may be foreground during the first three seconds, provided the active tab still matches and no tab activation, navigation/loading or window-focus change has been observed. Later readiness or an interrupted worker uses a background tab. No existing window is focused, and no browsing tab is navigated or removed.
- Existing or pending launcher tabs are reused without activation. If a restored launcher arrives after a new one was created, only the redundant tab created by this startup can be removed, and only while it is still the launcher with no outbound navigation pending and another tab remains in that window. A window is never closed just to remove a redundant helper. Manually opened/restored tabs are never deleted. Closing the launcher does not trigger another launch in the same session.
- A failed tab-create operation is reported without blindly retrying an operation that might have already been accepted.

Chrome does not expose a single definitive “session restore finished” event or all user interactions inside webpages to an extension with these permissions. The bounded initial-window check avoids delayed focus stealing and treats observable activity conservatively. Extremely late restore is handled by the duplicate check, rather than waiting indefinitely before showing the launcher.

## Isolation

There are no manifest permission additions and no new-tab override. Spotlight retains its existing new-tab behavior. The launcher is excluded from Arcify space membership, space snapshots, native-group sync, sidebar rows/native pinned favicons, archives, background recent/search-tab results and Spotlight bridge tab snapshots. The exclusion checks Arcify's exact helper URL, including pending restores; similarly named websites and other extensions are unaffected. Navigating the helper tab to an ordinary website makes it a normal browsing tab again.

The page uses only local assets and a small standalone script and stylesheet. It contains no dashboard, remote requests, workspace management UI or automatic side-panel activation.

## Verification

Automated unit/API/DOM regressions cover disabled defaults, saving/restoring the option without erasing other settings, startup foreground/background decisions, late windows, session persistence, existing/pending/late restored launcher reuse, repeated events, closing/no reopening, outbound navigation safety, API errors, synthetic-click rejection, synchronous button-to-API ordering, tab-ID targeting, accessibility markup and classification/archive exclusion. Production and development builds include the launcher page. Mocked trusted events do not demonstrate real browser user activation.

Real-browser acceptance must use a sandboxed, permitted Chrome environment. Cloud browser execution was policy-blocked in this development environment; no sandbox/security bypass was attempted and no real-click side-panel success is claimed.

### Manual acceptance in an allowed browser

1. With the setting off, restart Chrome: no new launcher. With it on, restart using both a blank startup and **Continue where you left off**: at most one automatic launcher, existing tabs preserved, Spotlight still owns Ctrl/Cmd+T.
2. Restore a session containing a launcher; verify it is reused without an unexpected tab/window switch. Close it and open more windows: no repeated launch until the next full browser startup.
3. Test an initially focused normal window, a popup, multiple windows, a delayed normal window and an incognito window. Start browsing promptly: delayed launch should remain in the background.
4. On the launcher, click the button and separately use Tab then Enter/Space. Verify the real sidebar opens in that window. Drag the launcher to another normal window and repeat. Close/reopen the sidebar and retry; success must not depend on a simulated activation.
5. Check the launcher is absent from spaces, native-group membership, archive, recent/search results, pinned favicons and Spotlight bridge results. Navigate that tab to a website and verify ordinary classification resumes.
6. Disable the setting, close the helper, restart and verify no new helper. Verify previously saved settings, spaces, pins and archives remain unchanged.
