# Little Arc reading-window size

This local candidate adds window geometry to the existing Shift-click Little Arc pair. It does not change tab ownership, transfer confirmation, recovery, or extension permissions.

## Everyday behavior

- A new normal window requests 1,150 pixels outer width and 85% of the current display's available height, capped at 1,200 × 900 and fitted inside approximately 24-pixel margins. It is not maximized.
- Position is centered over the exact originating browser window, clamped to that display's available rectangle. Signed coordinates are preserved. Another last-focused window does not become the origin.
- In the page header, choose **More → Window size settings…**. This focuses the existing trusted control tab, opens its **More → Window size** section, and never transfers the page.
- **Remember my size** is off by default. When enabled, normal Little Arc resizes save only width and height in local extension storage. Each subsequent opening recalculates position for its origin and clamps the saved size to available space.
- Existing version-1 settings preserve their opt-in and remembered dimensions on read. Legacy Reset preserves that opt-in. After saving the new version-2 settings, Reset returns future windows to defaults with automatic memory off. Neither operation resizes or repositions the current window.

## Geometry and safety boundaries

`little-arc-window-geometry.js` uses native window bounds and an early message from the exact extension-owned controller reporting `screen.availLeft`, `availTop`, `availWidth`, and `availHeight`. The candidate does not enumerate monitors or request `system.display`/window-management permission. The reported rectangle must contain the originating window's center. Unavailable or ambiguous display information falls back to source-window-relative bounds; exact taskbar margins cannot be guaranteed in that fallback.

The early screen observation bypasses the SpaceStore operation queue because creation already holds it. A pending token is registered before native creation, then bound to the exact returned controller/window IDs. Sender extension, top frame, document URL, optional origin/lifecycle, and current native identities are checked before adjustment. No bounds or window IDs from the website/header can request arbitrary updates. Persistent settings accept only that trusted controller; the authenticated header route merely opens it.

Only one bounded opening correction is allowed. Origin/target movement, controller changes, closure, expiry, or changed authority cancels it. Once ready, the extension does not chase or reposition the window. A rejected or uncertain geometry write never recreates a window or retries a transfer. Chromium provides no atomic compare-and-update for native bounds, so a narrow dispatch race remains possible.

`windows.onBoundsChanged` does not attest whether a human, the OS, or another application resized the window. The implementation excludes its own opening writes, position-only changes, and minimized/maximized/fullscreen transitions, including worker restoration and startup transitions. It debounces and rereads normal bounds before saving. An external normal-window resize is indistinguishable from a deliberate user resize; disable size memory if that behavior is unwanted. Disable/reset invalidates pending resize saves. Storage failures or failed readback are visible in the trusted controls and are not retried automatically.

Native window and screen coordinates are used directly, without multiplying by devicePixelRatio. Physical mixed-DPI, display disconnect, and multi-monitor behavior need hardware acceptance; simulated signed coordinates are not proof of those native cases. Browser restart and transient recovery retain the existing limitations described in the [reload boundary](little-arc-reload-boundary.md).

## Verification

The geometry tests cover source centering, taskbar rectangles, negative coordinates, small displays, malformed inputs, early messages, stale source/controller/target identity, cancellation, uncertainty, state transitions, explicit preferences, reset/disable races, worker restoration, and production launch integration. Controller tests use the actual markup. Existing transfer and authenticated-header tests cover the settings route and retained one-use authority. Disposable-profile native checks must verify the actual work area, default bounds, trusted settings focus, memory/reset behavior, no late reposition, and unchanged same-tab direct placement before delivery. Normal-profile installation is for manual testing and does not enable memory or reload extensions.

## Editable future-window preferences

The trusted controller now shows current outer dimensions, saved preference, and a resolved pixel preview for its verified current monitor. Choose Default, Fixed dimensions (logical pixels), or Percentage of usable work area, then **Save for future windows**. Saving never resizes the current window. Percentage values range from 10 to 100; resolved dimensions are raised to the supported minimum and clamped with screen-edge margins. Pixel dimensions must be integers from 240 to 32768. Actual browser/OS constraints can adjust requested bounds.

A separate optional width-to-height aspect lock uses width to calculate height. It fits the dimensions proportionally, including fixed-size source-rectangle fallback. An aspect ratio is not a percentage of screen size. An impossible ratio/work-area combination keeps the existing safe fallback rather than moving or recreating anything.

**Remember last normal size** is explicit and available only in Default mode. Choosing and saving Fixed or Percentage disables automatic memory while retaining previously remembered pixels. Later native resize events cannot overwrite those explicit configured dimensions. Draft edits survive a safe context refresh and do not write until Save. Settings writes are serialized, invalidate earlier debounced memory writes, and require semantic readback; object property order is irrelevant. No migration write occurs merely by reading a legacy preference.

Percentages use a verified usable monitor rectangle. Without it, launch uses the documented conservative source-window fallback; source bounds are never treated as a measured monitor for percentage calculations. Future launches use their own originating monitor, so the controller's current-monitor preview is illustrative, not a promise for another display. No display-enumeration permission was added.

The paired Spotlight header provides an anchored searchable Space chooser and keeps a healthy mounted header across ordinary page completion. Selection changes never transfer a page; direct/trusted confirmation and uncertain-operation safeguards remain intact.
