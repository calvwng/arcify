# Space ordering

Drag a Space chip in the bottom switcher to the left or right of another chip.
The insertion line shows the saved destination. Dropping onto the source chip,
pressing Escape, or ending the drag outside the switcher leaves the order alone.
For keyboard access, focus a chip and press **Alt+Shift+Left** or
**Alt+Shift+Right** to move it one neighbor. Moving a Space does not select it.

The order is shared by Arcify panels in all normal windows and survives closing
and reopening the sidebar or browser. Reordering does not move bookmark folders
or change a Space's ID, tab membership, or active selection.

## Import and synchronization

On first discovery with no saved Spaces, Arcify adopts top-level Arcify bookmark
folders in the order Chrome returns them. Existing saved Spaces keep their order;
newly discovered folders append. For example, if GenAI and Finance are already
saved when Personal arrives, the result is GenAI, Finance, Personal. Drag Personal
before GenAI to choose a new saved order.

Later bookmark-folder renames or reordering do not replace a chosen Space order.
There is no automatic re-sorting or order migration in this change. Folder
association recovery and deletion behavior are unchanged.

## Internal ownership

The service worker's `SpaceStore` and its persisted `spaces` array are the sole
order authority. The `reorder` operation takes a source Space ID, an anchor Space
ID, and `before` or `after`, and applies that move to the latest state. A missing
source or anchor rejects the operation rather than resurrecting deleted data.

Generic `patch` operations still merge metadata, membership, additions, and
removals. They never reorder surviving Spaces, even if the calling panel supplied
an older complete array. Newly added Spaces append. This prevents a stale panel's
unrelated edit from undoing a reorder made in another window.

The switcher is mounted once and defers chip replacement during dragging or
saving. A completed move projects the acknowledged order onto current panel
objects without resetting pending metadata edits; normal refresh reconciles the
remaining authoritative state. Focus stays on its chip unless the user moved it
elsewhere while the request was pending.

## Regression coverage

Run `npm run test:unit` and `npm run build`. Focused tests live in
`tests/unit/space-switcher.test.js`, `tests/unit/space-store.test.js`,
`tests/unit/sidebar-drop-integration.test.js`, and
`tests/unit/spotlight-invalidation.test.js`.
