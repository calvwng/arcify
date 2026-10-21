# Independent Today insertion order

In Settings, **Show newly opened Today tabs at the top** controls where future
standalone Today tabs appear. It defaults to on. The first Today tab sits directly
below the fixed **+ New Tab** row. Turning it off places future standalone tabs at
the bottom; changing this option never sorts existing tabs.

**Reverse saved pin and folder order** is the former **Show new tabs at the top**
option. Its saved value is retained and applies only to the saved bookmark tree.
It does not change Today order. Existing Today order is preserved on upgrade.

## Where a new tab goes

- A standalone new Today tab goes to the chosen top/bottom edge of its Space.
- A tab with a fresh, exact, same-window Today opener goes immediately below that
  opener, regardless of the standalone insertion option. Repeated children each
  go immediately below the opener; they are not grouped by URL or title.
- A verified native Split View opener remains an indivisible pair. The child goes
  after the whole pair in displayed order. An uncertain split cannot authorize
  an insertion between its panes.
- An exact Today opener retains its Space even if another Space is selected.
  Native pinned tabs, saved bookmark pins, global Favorites, cross-window,
  missing, or ambiguous openers do not supply Today adjacency or Space ownership;
  the new Today tab uses the selected valid Space (then the configured default).
- Known native New Tab/blank creation remains standalone even if Chrome supplies
  an incidental opener. When the browser provides no reliable opener, Arcify does
  not infer one from a matching title or URL.
- Arcify's **Duplicate** action uses its validated source as the opener. If the
  source disappears, its newly created duplicate stays in the validated Space
  and uses standalone placement.
- Spotlight new URL/search results and Arcify's ordinary New Tab fallback are
  explicitly standalone in their requested Space. Selecting an existing result,
  navigating the current tab, or reusing a Spotlight helper is not a creation and
  must not move that existing tab.

Native tab creation and extension actions use the existing serialized Space
store. Manual Today dragging retains its exact drop order. **Move to** still
appends its selected batch at the destination's visible bottom, in selected
order; it is not treated as opening new tabs. Saving a Today selection as a named
pinned folder respects the independently chosen saved-bookmark order.

## Compatibility and recovery

The profile-local `todayOrderRepresentation` record freezes the effective old
Today display orientation on first use. This is internal compatibility metadata:
canonical tab arrays and restoration snapshots are not reversed merely to split
the settings. Options initializes it before changing the old setting. The new
insertion preference is a normal synced setting; the representation stays local
with the tab state it describes.

Creation placement updates the existing authoritative order bookkeeping. When
restoration is incomplete, affected section ranks are rebased around the current
live order; a late restored tab is inserted without re-sorting its surviving peers. It does
not create a second workspace database. Group sync off/on uses the same canonical
membership and existing group projection. Paired Spotlight receives the existing
logical invalidations and fetches a fresh snapshot. No pairing protocol or
permission change is required.

Restoration, worker startup, tab activation, navigation updates, and existing-tab
adoption are not instructions to re-sort Today. Browser-restart matching retains
its existing limitations; this feature does not claim new persistent tab identity.

## Validation

The automated checks cover placement, settings isolation, exact opener scope,
manual order, recovery, and creation/adoption distinctions with mocked Chrome
APIs. The paired Chrome fixture separately exercises real rendered sidebar order,
trusted link input, options, and group-sync modes. Test outcomes and exact tested
commits are reported with the build evidence; source tests alone are not browser
acceptance. Helium's native omnibox/startup focus remains a manual check.
