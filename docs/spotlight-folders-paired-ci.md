# Spotlight folder acceptance

The additive `folder-actions` job uses the existing hosted-only sandboxed Chrome runner, a fresh profile, exact Arcify head and the same pinned Spotlight revision as all other jobs. It executes setup cases 0–2 and case 56. It does not replace the full suite or imply overlay, browser restart, or EVOO acceptance.

Case 56 exercises the real Spotlight new-tab document with trusted input and reads native bookmarks back after each action:

- fuzzy `open Ares` discovery of a nested Areas folder and full ancestry;
- parent navigation, creating a child and renaming that same bookmark ID;
- empty-delete confirmation initially focused on Cancel, cancellation preserving the ID, then explicit deletion;
- moving a nonempty folder subtree to another Space, preserving folder/child identities;
- refreshed search/browse ancestry after the move.

Setup creates nonce-scoped Spaces and folders only. Cleanup validates every descendant against exact owned IDs before removing its trees, restores native group-sync preference, active tabs/Spaces and focus, and checks for leaked IDs. An unexpected child aborts cleanup instead of deleting it. Failed cleanup fails the run. Evidence contains native readbacks and screenshots for each checkpoint, including on failure where available.

Local import-safe fixture/run-plan unit checks are not native acceptance. The real runner intentionally refuses local use and never disables browser sandbox/security settings. Publish the reviewed tests to the draft PR and inspect the mandatory `folder-actions` job for the exact paired heads before describing native behavior as validated.
