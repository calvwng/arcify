# Space colors and appearance

Right-click a Space header or its bottom switcher button and choose **Theme Color**.
Choose a named preset, or use the color picker / a six-digit hex value such as
`#8bb3f3` and select **Save custom tint**. **Reset to … preset** clears only the
custom tint. Choosing another preset also clears the custom tint.

**Settings → Sidebar appearance → Appearance** offers **System** (the default),
**Light**, and **Dark**. System responds to OS appearance changes while the
sidebar and Settings are open. These choices apply to this Chrome profile.
Tints adapt to light/dark surfaces, with derived text, selection and drop-marker
contrast. The picker displays the source tint rather than the adapted surface.

Custom tint is independent of the named Chrome tab-group color. Native group
sync and Spotlight bridge v1 continue to receive only the existing named enum.
Shared palette overrides still apply to preset Spaces; a Space custom tint takes
precedence. Clearing it resumes the shared palette. Existing choices are not
rewritten when appearance changes.

The tint is stored alongside the Space's stable UUID in the profile-local Space
registry, like its icon. It survives worker/extension reloads and bookmark
reconciliation/renames within the profile. It is not encoded in bookmark titles,
so bookmark sync to a different profile does not transfer custom tints. A Space
recovered from its registry restores the tint only when its UUID matches.
Explicitly clearing a tint is retained. Older Arcify versions ignore the new
field safely and can still use the named color.

Appearance changes update CSS tokens in place. They do not rebuild tab rows,
change Today or saved-tab selection, or discard a live text editor. The header
keeps the complete chosen emoji immediately before its name; icon-only mode
continues to affect only bottom switcher labels.

## Verification

- `node --test tests/unit/sidebar-theme.test.js` checks hex validation,
  200+ sampled colors in both modes, System listener lifecycle and in-place DOM.
- `tests/unit/sidebar-appearance.test.js` covers concurrent options patches and
  persisted appearance/reset behavior.
- Store, menu, sidebar and bridge tests cover custom tint persistence/recovery,
  error/cancel/reset flows and native-group/v1 compatibility.
- These checks are source/API/DOM regressions, not rendered-browser acceptance.
  Browser visual review must include narrow sidebar and Settings widths, extreme
  tints, both appearance modes, menus/dialogs, Today/Favorites selections,
  drop markers and long names/composed emoji before delivery.

## Settings and initial paint

Arcify Settings uses the same profile-local System / Light / Dark preference, including the companion pairing forms, notices, disabled controls, and keyboard focus indicators. System is the default and tracks the operating system while the page is open. The packaged early script uses a validated, non-authoritative mode cache to reduce first-paint flashing; Chrome local storage remains authoritative and corrects stale caches. If the cache is unavailable, the page follows System. The native color dialog follows Chrome/OS rendering and remains a manual visual check.

Space header icons share a centered flex line box with the editable name at every header size. Whole emoji graphemes remain intact, long unfocused names ellipsize, and focus keeps the same editable input. Icon-only switcher mode never hides the header name.

## Hosted browser evidence module

`scripts/paired-chrome-space-theme.mjs` exports `exerciseSpaceTheme` without launching a browser on import. The paired runner supplies `apiPage`, `nativeSidebar`, `newTabPage`, `ui`, `screenshot`, `screenshotBytes`, `snapshot`, `poll`, `fixture`, `arcifyId`, and `record`. It requires the sandboxed, non-root GitHub Actions environment and an actual 224–420 px native panel with a matching SIDE_PANEL/onOpened receipt. It uses the existing local `/alpha` fixture pages and expects Standard Favorites layout after the density case. The mandatory full paired runner executes it as case 46, after the previous 45 cases and before the unchanged Favorite lifecycle/restart ending. Case 47 executes the exact reviewed Spotlight companion options collector. Recovery and initial Spotlight action cases 48/49 follow it. The full/lifecycle/native-split plans require 49/5/4 passing cases; no theme-only subset replaces them.

The evidence includes real keyboard hex save/invalid/cancel/reset, named preset/native-group/v1 compatibility, Light/Dark/System settings, rendered contrast with ancestor alpha compositing, native drag-marker screenshot pixels, full emoji and long-name geometry at 12/16/20 px, Settings validation/focus/disabled controls, and persisted native sidebar/Settings **document** reloads. System changes use Chrome media emulation, explicitly recorded as such; the OS color dialog remains manual. This does not claim an additional full extension unload/reload or physical OS appearance change. The pure validator suite is `tests/unit/paired-chrome-space-theme.test.js`; passing it is not rendered acceptance.

The native-color proof explicitly enables sync through the foreground Settings
checkbox and targets `fixture.spaces.work` in window A. An absent/stale projection,
missing group, wrong window, no live owned members, or non-native color fails
both the custom-tint and preset assertions. Custom tint must leave the real group
ID and named color unchanged; a preset must update that same group to its enum.
The fixture restores its original sync setting, exact native groups/members/order,
Space metadata, active tabs/Spaces and window focus after removing only owned
test data. [Paired theme acceptance details](theme-paired-ci.md) describe the
required artifacts, reviewed companion pin and unverified manual surfaces.
