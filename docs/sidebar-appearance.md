# Sidebar appearance

Open **Settings → Sidebar appearance**. These preferences save automatically
for this Chrome profile and update every open Arcify sidebar, including after
the sidebar or browser is reopened. They do not sync to other Chrome profiles.

- **Favorites layout:** Standard preserves the existing expanding buttons and
  visible Open/Closed/Pin labels. Compact icons uses fixed square tiles, with
  names and open/closed state retained in tooltips and accessible names.
- **Compact Favorite size:** 36–64 px, in 1 px steps. This control is enabled
  only in Compact icons layout. The initial size is 44 px with 8 px gaps: four
  columns fit in a 224 px sidebar, and six in a 350 px sidebar. Resize the panel
  to reflow the grid. Incomplete rows keep the same tile size as full rows.
- **Space header size:** 12–20 px name text, independently adjustable from
  Favorites. Header buttons scale with the name and remain at least 24 px.
  Smaller names use lighter font weight without reducing text contrast.
- **Hide Space names in switcher:** Off by default. Turn it on for 32 px,
  icon-only bottom-switcher buttons. Hover to see each Space name; screen-reader
  labels retain the name and keyboard shortcuts remain available. Spaces without
  an icon show a neutral dot. Headers, rename dialogs and menus keep their names.
  Use **Change Space Icon** to assign a keyboard emoji or a preset.
- **Reset sidebar appearance:** Returns to Standard Favorites, 44 px compact
  tiles, 16 px Space names, and visible switcher names. Other settings, Spaces, Favorites, bookmarks,
  native pins and open tabs are unchanged.

For a compact arrangement similar to Arc, choose **Compact icons**, **44 px**
Favorite size and **12 px** Space header size. The initial/default appearance
stays Standard with 16 px Space names and visible switcher names. You can
independently enable **Hide Space names in switcher** for an icon-only row.

## Implementation and safety

`sidebar-appearance.js` owns validation and in-place CSS variables/data
attributes. Stored values are finite numbers, rounded and bounded on both read
and write; invalid values return to defaults. `hideSpaceNames` accepts only
the boolean `true` to opt in; older settings without it retain visible names. The profile-local
`chrome.storage.local.sidebarAppearance` key is separate from Favorite and
Space stores. A storage-change listener applies appearance without replacing
focused tiles or an in-progress Space-name edit. Listeners subscribe before
the initial read so a late read cannot overwrite newer settings.

`sidebar-appearance-options.js` merges only changed controls under an
extension-origin Web Lock. This prevents independent options pages from
overwriting each other's settings. Its per-page queue retains rapid slider
changes and reset ordering. If storage or the lock is unavailable, the options
page reports a failure instead of claiming the preference was saved. There is
no unlocked write fallback and no new extension permission.

Compact layout uses fixed CSS grid tracks (`auto-fill`), never fractional
columns or an expanding last row. Name, state, activation and drag identity
still come from the existing Favorite UI. The shared geometry-based drop
resolver and non-interactive overlay are reused; updating density refreshes an
active marker, and window resize re-hit-tests the pointer against the new rows.
Icon-only Space chips use the same buttons, stable IDs and reorder handlers.
Appearance changes refresh their active drag marker in place without replacing
a focused or dragged chip.

## Validation

Run without launching a browser:

```sh
node --test tests/unit/sidebar-appearance.test.js \
  tests/unit/favorites-drop-target.test.js \
  tests/unit/favorites-drop-feedback.test.js
npm run test:unit
npm run build
```

Unit regressions cover defaults, malformed/bounded storage, persistence and
reset isolation, concurrent options pages, rapid updates, storage failures,
in-place focus/edit preservation, fixed tile bounds, partial-row destinations,
wrapped-row anchors and stationary drag markers during resize. Real-browser
CI additionally checks actual control interaction and rendered geometry.

Custom emoji and icon-only regressions also cover full graphemes, paste and IME
composition, malformed-input rejection, preset and clear/reset compatibility,
registry-only icon recovery, live multi-panel setting changes, name tooltips and
labels, header/edit focus preservation, iconless fallback targets, and keyboard
and drag ordering. These new cases have unit/DOM coverage; real-browser visual
and native IME acceptance remain separate checks.

## Appearance mode

The same profile-local settings also provide **System** (default), **Light** and
**Dark**. System follows live OS changes; explicit choices override them. See
[Space colors and appearance](space-themes.md) for per-Space custom tints and
contrast handling. Reset sidebar appearance returns the mode to System along
with the layout defaults.
