# Paired Chrome tab-menu fixture integration

This fixture is wired into the paired runner for the approved tab-menu source batch, before ordinary-Favorite restart receipts and the final full-browser restart. The localhost handler precedes the generic fallback, and module/source paths are included in the paired workflow. Only syntax checks, pure tests, and production build were run locally. Native execution and screenshot evidence remain pending in the existing dedicated sandboxed GitHub Actions job.

The default `full` plan requires all **39** cases. The two new menu cases keep
stable zero-based indices **37** (Space) and **38** (Tab), execute inside the
full-only scope after case 35, and finish before cases 36 and 32. The supplemental
`favorite-lifecycle` run remains exactly **5** cases in order **0, 1, 2, 36, 32**;
it never runs or claims either menu case. All selected cases must pass once in
the declared order, with no omitted, extra, skipped or retried results.

## Parent runner contract

Import from `scripts/paired-chrome-tab-menu.mjs`:

- `serveTabMenuFixture(request, response)`
- `exerciseTabMenuActions(options)`

Call the server function before the localhost server's generic fallback. It handles `/tab-menu/<32-hex-nonce>/{ordinary,pin,away,edited,stale}`. Each real response contains a unique document token and ordinary editable input. The token and genuine typed state prove that pin edits, copy, mute, duplicate, and removal do not reload or navigate the original page.

The exercise takes the existing runner helpers:

```js
await exerciseTabMenuActions({
  apiPage: arcifyOptions,
  newTabPage,
  pageForUrl,
  ui,
  screenshot,
  snapshot,
  poll,
  fixture,
  arcifyId,
  spotlightId,
  search,
  record: detail => { /* append evidence to the parent report */ }
});
```

- `apiPage`: existing Arcify options page in `fixture.windowA`, exposing real Chrome APIs and visible `invertTabOrder` / `syncTabGroups` settings.
- `newTabPage(url, windowId)`: existing exact extension-tab creation helper returning `{page, tab}`. The exercise uses it only for extension pages.
- `pageForUrl(url)`: existing observed page lookup. Source lookup occurs while each nonce URL has one page, before creating the equal-URL ordinary twin.
- `ui(page, label, action)`: existing foreground/visibility-checked real-input wrapper. Do not substitute DOM event or value injection.
- `screenshot(page, label, required)`: existing required screenshot recorder returning its metadata; every successful required capture must return evidence. Screenshot failures are hard failures. Optional failure capture does not foreground a background page.
- `snapshot(windowId)`: existing authenticated real paired bridge call, never a stub or direct storage projection.
- `poll(read, accept, label)`: existing bounded polling helper; invariant timeouts fail the check.
- `fixture`: current `{base, windowA}` IDs. Run before a full-browser restart invalidates the original fixtures, or pass freshly verified postrestart IDs and helpers.
- `search(page, query)`: existing real Spotlight typing helper.
- `record`: persist the returned plain-JSON evidence and intermediate failure/cleanup records in the parent report.

Wrap the call in the parent's ordinary `step` machinery. Retain its window-B isolation checks, page-error and worker-crash gates, installed-runtime evidence, namespace sandbox validation, and final profile teardown. Do not weaken Chrome arguments or add clipboard permissions. The module itself refuses execution outside GitHub Actions/CI and refuses root. It never launches Chrome.

## Exact UI selectors and arguments

- Live row: `.space.active .tab[data-tab-id="<exact tab ID>"]`
- Saved row: `.space.active .tab[data-bookmark-id="<exact bookmark ID>"]`
- Folder: `.space.active .folder[data-bookmark-id="<exact folder ID>"] > .folder-header`
- Menu: `#tab-context-menu`
- Existing stable action attributes: `[data-action="rename"]`, `editUrl`, `copyLink`, `mute`, `duplicate`
- Editor: `#tabEditDialog`, `#tabEditValue`, `#tabEditSave`, `#tabEditCancel`
- Status: `#favoritesDropNotice`
- Rendered title: `.tab-title-display`
- Remove Pin: uniquely locate the existing `.context-menu-item` whose text is exactly `Remove Pin`, then use its Puppeteer `ElementHandle.click()`. Also require `Close Tab (Keep Pin)` to be present. There is no extra product confirmation dialog; the fixture confirms the resulting exact saved-record removal while the native page stays open.

All feature actions use real right-clicks, element clicks, typing, Ctrl+A, Ctrl+V, or Escape. Clipboard contents are proven through a real paste into the existing Rename editor followed by Cancel; no clipboard-read permission or fake clipboard is used. API writes are limited to disposable setup/cleanup and explicitly recorded external races (closing a seed tab or moving a seed bookmark while its editor is open). No direct `tabMenuAction` request, DOM `.click()`, dispatched event, or input-value assignment drives the product behavior.

## Required evidence

- Ordinary Rename cancellation and exact alias save, unchanged same-URL twin, actual sidebar repaint, unchanged native title/page/input, and real bridge alias projection. The already-mounted nonce query starts with two ordinary source rows; a passive observer requires the authenticated paired-window invalidation before a genuine tab return resumes its intentionally deferred refresh. The original document/query survive, with one alias and one unchanged same-URL twin, without more typing or a reload.
- Live saved-pin rename plus closed same-URL pin rename; existing ID, parent, sibling index, title and URL are checked independently.
- Saved URL Cancel and live/closed URL saves. The live source deliberately navigates away first, then keeps its document token and typed state after saving its new pin URL.
- Live Copy Link yields the away page's current URL; closed Copy Link yields the saved URL. The active sidebar tab is unrelated.
- Mute then Unmute changes only the clicked live tab's muted bit.
- Duplicate creates one new active ordinary native tab adjacent to the exact source, in the same Space's canonical Today order, without copying alias or saved identity. Original tabs and other-window activation/order stay intact.
- Closed-tab and moved-bookmark stale editors reject the old target without additional mutation.
- Remove Pin removes only that saved record, naturally shifts sibling indexes, clears its exact binding, and retains the same live page in Today.

The fixture returns real observations and required screenshot metadata. It does not claim native panel layout, Helium behavior, OS input hardware, or browser-restart coverage. The parent continues to own those separate checks.

Pure negative validators are in `tests/unit/paired-chrome-tab-menu.test.js`; importing or running those tests does not start Chrome.
