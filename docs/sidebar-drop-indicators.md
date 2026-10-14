# Sidebar drop destinations

Tabs and folders use the same resolved destination for feedback and insertion.

- A blue anchor line shows insertion before or after a row. Below the last row,
  the line stays visible at the end of that list.
- On a folder header, the top and bottom quarter (up to 8 px) insert before or
  after the entire folder. The middle highlights the header and appends inside.
- Holding over the middle of a collapsed folder opens it after 250 ms. Hovering
  either edge does not open it. Nested rows target their own parent folder.
- Empty lists have a start-of-list anchor. A folder cannot be dropped into itself,
  a descendant, or the temporary section. Closed bookmarks also stay in Favorites.
- Folder nesting uses the existing two-level limit; tab-group sync permits only
  root-level folders. Existing deeper imported trees can still reorder in place.
- The anchor is an overlay, so folder clipping cannot hide it and it cannot
  intercept the drag pointer. Scroll/resize re-hit-test the pointer. Edge hover
  scrolls the space content, including when the pointer is stationary.
- Leaving the drop area, drop, drag end, Escape, or window blur clears feedback
  and hover/scroll work. No-op and invalid destinations do not show an anchor.

## Verification

`npm run test:unit` includes:

- `sidebar-drop-target.test.js`: destination geometry, nesting and cycle guards,
  empty/end positions, collapsed projections, insertion-reference validation.
- `sidebar-drop-feedback.test.js`: single overlay, inside highlighting, lifecycle
  cleanup, scroll/resize, edge autoscroll, status announcements and CSS contracts.
- `sidebar-drop-integration.test.js`: imports the actual sidebar and uses the
  actual bookmark writer with mocked browser APIs. Checks saved folder and tab
  order, inverted order, projected rows, pin/unpin boundaries, cancellation,
  auto-open, group-sync policy and concurrent-bookmark conflict recovery.

These DOM tests do not prove native drag dispatch, browser geometry or pixels.
The real-browser acceptance pass should drag by mouse in the built sidebar and
check both the screenshot and saved bookmark parent/index after each drop:

1. First/middle/last tabs and whole folders, in both order directions.
2. Folder-header before/inside/after zones, nested rows and empty folders.
3. A projected live tab in a collapsed folder, with hidden siblings around it.
4. Long-list edge autoscroll and manual scroll; repeat with Escape, outside drop,
   window blur and rapid transitions between folder headers.
5. Light/dark and forced-color themes, narrow panels and high zoom. Confirm the
   anchor remains visible and never changes the element receiving pointer events.

Native Arc/Helium panel docking and OS drag cancellation remain manual checks.


### Saved Favorites cancellation evidence

The paired Chrome Favorites scenario starts a genuine mouse drag, then uses
Chrome's documented [`Input.cancelDragging`](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-cancelDragging) on the same CDP session that owns
Puppeteer's mouse. It passively observes trusted `dragstart` and `dragend`, requires
`dropEffect: none` and no `drop`, and checks cleared source/marker plus unchanged
registry, icon cache, bookmarks, windows and tabs before and after mouse release.
Progress and failure observations are persisted before cleanup.

This proves browser-native drag cancellation, not physical Escape-key dispatch.
The production DOM Escape listener has separate unit/integration coverage.
Physical Escape during native dragging, OS input routing and native panel layout
remain manual checks. Puppeteer's ordinary CDP `keyboard.press('Escape')` alone
does not establish that a native drag or its DOM listener received cancellation.
