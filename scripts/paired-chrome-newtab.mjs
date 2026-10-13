import assert from 'node:assert/strict';

// Read-only renderer evidence. This cannot inspect the browser's omnibox draft.
export async function readNewTabReuseState() {
    const input = document.querySelector('[data-testid="spotlight-input"]');
    const selected = [...document.querySelectorAll('[data-testid="spotlight-result"].selected')];
    return {
        tab: await chrome.tabs.getCurrent(),
        url: document.URL,
        timeOrigin: performance.timeOrigin,
        visibility: document.visibilityState,
        documentFocused: document.hasFocus(),
        input: input ? { value: input.value, start: input.selectionStart, end: input.selectionEnd,
            direction: input.selectionDirection, focused: document.activeElement === input } : null,
        selected: selected.map(item => ({ type: item.dataset.resultType,
            title: item.querySelector('.arcify-spotlight-result-title')?.textContent }))
    };
}

export function assertActiveNewTabReused(before, after, tabIdsBefore, tabIdsAfter, extensionId) {
    assert.match(extensionId, /^[a-p]{32}$/);
    assert(['chrome://newtab', 'chrome://newtab/'].includes(before.tab?.url), 'Test must start on the browser-created New Tab alias.');
    assert.equal(before.url, `chrome-extension://${extensionId}/newtab.html`);
    assert(Number.isSafeInteger(before.tab.id) && before.tab.id > 0);
    assert(Number.isSafeInteger(before.tab.windowId) && before.tab.windowId > 0);
    assert.equal(before.tab.active, true);
    assert.equal(before.tab.incognito, false);
    assert.equal(before.tab.status, 'complete');
    assert.equal(after.tab?.status, 'complete');
    assert(!before.tab.pendingUrl && !after.tab?.pendingUrl, 'Pending navigation cannot establish safe reuse.');
    assert(before.input && before.visibility === 'visible', 'The original Spotlight renderer must be ready and visible.');
    assert(Number.isFinite(before.timeOrigin) && before.timeOrigin > 0);
    assert.equal(after.url, before.url);
    assert.equal(after.timeOrigin, before.timeOrigin, 'Reuse must retain the original document.');
    for (const key of ['id', 'windowId', 'url', 'active', 'incognito', 'pinned']) assert.equal(after.tab[key], before.tab[key], key);
    assert.equal(after.visibility, before.visibility);
    assert.equal(after.documentFocused, before.documentFocused);
    assert.deepEqual(after.input, before.input, 'Reuse must preserve the input, caret and focus.');
    assert.deepEqual(after.selected, before.selected, 'Reuse must preserve manual selection.');
    assert.deepEqual(tabIdsAfter.slice().sort((a,b) => a-b), tabIdsBefore.slice().sort((a,b) => a-b), 'Reuse must not create or close a tab.');
}
