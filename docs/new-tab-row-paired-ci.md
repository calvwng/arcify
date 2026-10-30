# Unified Today New Tab row: paired Chrome evidence

The full hosted Chrome job retains all 49 mandatory cases. Case 8 still launches
Spotlight from an ordinary sidebar tab and checks helper reuse, now through the
single `#newTabBtn`. Case 14 retains its startup command, unchanged source-tab,
native `SIDE_PANEL`, exact-window `onOpened`, and native screenshot assertions,
then requires `exerciseNativeNewTabRow` against that verified native target.
The 5-case Favorite lifecycle and 4-case native Split View plans are unchanged.

The native row checks require:

- One real button immediately after the active Today divider and before its
  sortable tab container, with visible usable geometry; no old Spotlight button.
- Normal and inverted order, compact appearance with 12 px Space headers, a real
  empty Space, and a bookmark metadata repaint. Screenshots are mandatory and
  the footer notice host must remain present.
- Two rapid trusted mouse clicks, including a repeated click while launch is
  pending, followed by genuine Tab/Enter activation. The active Spotlight
  document, exact tab ID, draft text, a verified nonempty caret selection and selected result remain
  unchanged. Moving focus to the sidebar is expected and is not misreported as
  helper focus preservation.
- Actual options-UI disconnect/reconnect. A disconnected row creates exactly one
  native browser New Tab in the source window, canonically assigned to the source
  Space. The fixture verifies that Chrome's existing Spotlight override handles
  it by its real extension TAB context and waits for the exact visible Today row; no hardcoded helper URL or replacement
  provider is accepted. Reconnecting and reusing the original draft cannot create
  a deferred extra fallback.

Fixtures use a disposable bookmark-backed Space and remove only their exact
created tab IDs, restore settings, and restore the original Space. Cleanup verifies
the disposable Space’s exact folder identity and absence of live owned tabs, uses
the authoritative Space delete operation, and observes canonical disappearance
before the unchanged global window-isolation check. Full evidence and action
checkpoints are retained separately, including final cleanup observations. They
focus the existing source window after options changes rather than activating a
possibly differently owned tab. Empty-Space intent is reselected and rechecked
before fallback. Every case retains the suite's other-window isolation and
uncaught-renderer/crash gates.

Only the dedicated GitHub-hosted job may launch Chrome. No local browser, Chrome
private extension API, settings-policy override, transport replacement, synthetic
DOM input, or sandbox change is used. Validators and syntax/build checks can run
locally without claiming browser coverage. Stale-source/pairing races and unknown
post-dispatch/timeout outcomes are deterministic production unit tests, not
artificially delayed hosted browser transport. This fixture does not claim
physical keyboard/Helium validation or literal companion uninstallation.
