# Temporary private-window sidebar

The sidebar resolves its native owning window before loading normal sidebar code. Private windows show only their current live native tabs, a private indicator, and activate/close/new-tab controls. Spaces, Favorites, import, Spotlight, saving, archive, restore, and transfer controls are absent.

The private module does not use storage, background messaging, analytics, or logging. Titles exist only in the current DOM and native query results; URLs are not rendered or fetched for favicons. Native events trigger fresh queries, with stale query results discarded. Closing the owner removes listeners and clears the list. Reloading reconstructs the view from native tabs, with no saved private history or service-worker dependency.

Each mutation verifies the exact owning private window and, for existing tabs, the exact native tab ID and private/window membership immediately before calling the native API. Chrome does not provide an atomic validate-and-mutate API; a concurrent native move between validation and mutation remains a browser API race. There is no fallback target or retry of a mutation.

No new permissions, incognito mode conversion, permission enablement, historical data migration, or Spotlight redesign is included. Browser-native private-session handling remains the browser's responsibility. Existing background private-persistence containment remains in place.

Tests use synthetic private markers and cover context isolation, exact targets, stale/wrong-window rejection, event refresh and disposal, stale query ordering, and storage/messaging tripwires. Real-profile incognito access and browser automation are not changed or used by this work.

Integration coverage imports the real HTML entry with mixed native windows, exercises rendered controls after native identity changes, and records forbidden Chrome/Web Storage and messaging access even if an error is caught. Normal sidebar fixtures traverse the context boundary both before and after DOM readiness and compare their real rows and stored state.
