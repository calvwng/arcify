# Space context menu basics

Right-click a Space header or a bottom-switcher chip to open the same menu.
Keyboard users can focus the Space name or a chip and press **Shift+F10** or the
Context Menu key. Arrow keys, Home and End move through the menu; Escape dismisses
it and returns focus. Opening the menu does not activate or reorder that Space.

- **Change Space Icon:** type or paste one emoji into **Emoji**, then choose
  **Save emoji**, or use one of 20 named presets. Open your device's emoji keyboard
  in the field (for example, Control–Command–Space on macOS or Windows+. on Windows).
  Skin tones, joined family/profession emoji, flags, keycaps and variation selectors
  stay intact. IME candidate confirmation does not submit the editor.
  **No icon**, or saving an empty field, removes the icon. The bounded, scrollable
  picker is keyboard accessible. Icons appear in both header and switcher; existing
  Spaces have no icon by default. **Settings → Sidebar appearance → Hide Space names
  in switcher** optionally shows only switcher icons with names retained on hover.
- **Rename:** edit the clicked Space's name and its exact backing bookmark folder.
  Duplicate display names do not redirect the operation to another Space.
- **Theme Color:** choose the existing eight colors: grey, blue, red, yellow,
  green, pink, purple or cyan. This is the existing basic background/group color,
  not a gradient, wallpaper or richer theme system.
- **New Folder:** name a saved folder directly under the clicked Space's bookmark
  root, including when that Space is inactive. It uses the existing folder policy;
  deeper folder restrictions and group-sync behavior are unchanged.
- **Delete:** the confirmation names the Space and explicitly warns that it deletes
  every saved bookmark and folder in its backing subtree and closes owned tabs
  across all windows. Shared saved Favorites survive. Cancellation changes nothing.

Name and folder editors require 1–256 characters after trimming. Picker and form
submissions disable repeated saves while pending, preserve the exact target ID,
show failures without claiming success, and reject deleted targets. Dialogs have
accessible names, bounded scrolling, focus containment and Escape/Cancel dismissal.

## Persistence and concurrency

The background `SpaceStore` serializes `metadata` and `newFolder` operations with
existing delete/reorder work. It resolves the stable Space ID against current
state, validates the exact bookmark folder, and never selects a Space as a side
effect. Existing inline rename and color controls use the same metadata path.
`newFolder` uses `folder-policy.js`; deletion retains the existing queued ownership
checks and Favorite protection.

`space-icons.js` accepts the existing preset IDs or a single Unicode emoji
extended grapheme cluster. It validates the browser's Unicode emoji properties
and sequence structure, including well-formed non-RGI ZWJ combinations and
unqualified/text-presentation variants; glyph appearance depends on system fonts.
Plain text, multiple emoji, markup, URLs, broken surrogates, and incomplete
sequences are rejected without truncating or replacing the input. Validation runs
on save in both the dialog and worker. No input `maxlength`, UTF-16 slicing, image
URLs, HTML, uploads or network requests are involved. The local `spaces` record and durable
`spaceRegistry` entry retain the icon, including a null reset. Registry recovery
only copies an icon to a matching stable UUID. Older records without an icon keep
their existing appearance. Metadata refresh updates the header and switcher across
panels; stale unrelated membership patches cannot erase newer icon metadata.

## Verification

Run `npm run test:unit` and `npm run build`. Dedicated actual-module/DOM coverage is
in `tests/unit/space-context-menu.test.js`, `tests/unit/space-context-sidebar.test.js`,
`tests/unit/space-icons.test.js`, `tests/unit/sidebar-appearance.test.js`,
and `tests/unit/space-store.test.js`. These cover inactive/duplicate-name targets,
header/switcher parity, keyboard and cancellation, repeated submits, errors and
stale targets, icon reset/recovery, queued metadata, folder creation, and deletion
across windows with a shared Favorite retained. Existing switcher drag/reorder,
sidebar and folder-policy tests remain part of the full unit suite.

The isolated paired runner now calls `scripts/paired-chrome-space-context.mjs`
before ordinary-Favorite restart receipts and the final browser restart. The
CI-only module uses genuine right-click, Shift+F10, Tab traversal, typed names and
native confirmation dismissal on its exact disposable Space. It covers inactive
Rename/Theme Color/New Folder, icon save/reset/Cancel, header/chip parity, a 224px
picker viewport, sidebar reload and second-window projection, and Delete Cancel
with complete captured state invariance. Every planned screenshot is required and
its capture metadata is retained. Pure negative validators and input-adapter tests
are in `tests/unit/paired-chrome-space-context.test.js`.

The [paired run at Arcify `3f450f3`](https://github.com/calvwng/arcify/actions/runs/38719535714)
with Spotlight `019b527` passed all 39 full-suite cases, including this menu,
on Chrome 155.0.8059.39. Its separate Favorite lifecycle job passed 5 cases.
The menu module uses ordinary `sidebar.html` tabs and proves sidebar reload
persistence, not native-panel layout or a complete browser restart with the
edited Space retained. Helium-specific manual acceptance remains outstanding.
Deferred export, Live Folders, richer themes and true Profiles are tracked in
[the backlog](BACKLOG.md#deferred-space-menu-features).

The keyboard emoji field precedes the preset grid in the focus order; Tab from
Cancel wraps to that field, and Shift+Tab wraps back. Preset selection continues
to focus the selected preset on opening; a saved custom emoji focuses its field.
Unit/DOM checks cover custom emoji, composition, invalid input, retry/cancel and
recovery. Historical paired runs above predate these additions; real-browser
keyboard/IME, tooltip and icon-only geometry checks are still required.
