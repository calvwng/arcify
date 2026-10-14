# Backlog

## Ordinary, unpinned live tabs for saved Favorites

**Status: deferred; not implemented.** Revisit after favicon retention and
Favorite drop-line feedback are manually testable, with a new decision to proceed.
No schedule is committed. Saved Favorites currently continue to use native pinned
tabs; this item does not change that behavior.

### Design constraints and decisions

- Keep Favorites accessible across Spaces through exact, session-scoped Favorite
  bindings, independent of Chrome's pinned bit. Do not merely create unpinned
  tabs: ordinary tabs are currently assigned to a Space.
- Exclude bound global instances from Space ownership, group projection,
  restoration assignment, bulk-close and auto-archive. Handle already-grouped
  adopted tabs and stale sidebar patches with group sync both on and off.
- Coordinate Arcify's Favorite/bridge validation and Spotlight's snapshot/action
  validation. The current paired contract requires live Favorite bindings to
  reference native-pinned tabs outside Space membership. Do not misreport the
  pinned bit or silently weaken either peer's identity checks.
- Decide focus separately from accessibility: switching Spaces currently
  activates the destination Space's last tab. Keeping the Favorite globally
  reachable does not necessarily mean leaving it focused during a switch.
- Evaluate the native close-toast tradeoff on the target Chrome/Helium version.
  Removing native pinning changes the browser's pinned-tab close protection;
  this is not an extension-owned toast to suppress. Preserve the distinction
  between closing a live tab and removing its saved Favorite.
- Preserve exact per-window identity, replacement/move handling, and uncertain
  creation receipts. A browser restart clears session bindings; do not guess
  identity from URLs, titles, tab positions, or reused numeric IDs. Resolve the
  restored ordinary-tab versus newly opened Favorite duplication tradeoff.
- Define explicit live-instance detachment when dragging a Favorite into a Space,
  and assignment of the still-open ordinary tab when removing a Favorite. Those
  transitions can no longer depend solely on a native `pinned: false` event.

### Possible acceptance checks

- Open/adopt and repeatedly activate one exact Favorite across two Spaces and
  two windows, with group sync on and off; preserve duplicate-URL identities.
- Verify native grouping, stale patches, Space cleanup/deletion and auto-archive
  cannot hide, reassign or close a bound global instance.
- Exercise actual keyboard close behavior and context-menu close; retain saved
  links and icons, and verify the chosen Space-switch focus behavior.
- Cover explicit removal/reverse drag, tab replacement/window moves, worker
  restart, full browser restart, reused IDs and uncertain create outcomes.
- Test both peer validators and mixed-version compatibility without weakening
  pairing or introducing URL-based live-tab adoption.

Background: [Saved Favorites](favorites-drop.md), including
[native keyboard-close confirmation](favorites-drop.md#native-keyboard-close-confirmation).
