import assert from 'node:assert/strict';

// New identities are mandatory even if the original split is still open.
export function assertSavedSplitReopened(before, after, { recipe, spaceId, windowId }) {
    const previous = new Set(before.tabs.map(tab => tab.id));
    const added = after.tabs.filter(tab => !previous.has(tab.id));
    assert.equal(added.length, 2, 'Opening a recipe must create exactly two new tabs.');
    for (const old of before.tabs) {
        const current = after.tabs.find(tab => tab.id === old.id);
        assert(current, 'Opening a recipe cannot close an existing tab.');
        for (const key of ['windowId', 'url', 'pendingUrl', 'pinned', 'incognito', 'splitViewId']) {
            assert.deepEqual(current[key], old[key], `Original tab ${old.id} changed ${key}.`);
        }
    }
    added.sort((a, b) => a.index - b.index);
    assert.deepEqual(added.map(tab => tab.url), recipe.pages.map(page => page.url));
    assert(Number.isInteger(added[0].splitViewId) && added[0].splitViewId >= 0);
    assert.equal(added[1].splitViewId, added[0].splitViewId);
    assert.equal(after.tabs.filter(tab => tab.splitViewId === added[0].splitViewId).length, 2);
    assert.equal(added[1].index, added[0].index + 1);
    const space = after.spaces.find(item => item.id === spaceId);
    assert(space);
    for (const tab of added) {
        assert.equal(tab.windowId, windowId); assert.equal(tab.incognito, false); assert.equal(tab.pinned, false);
        assert(space.temporaryTabs.includes(tab.id));
        assert(!space.spaceBookmarks.includes(tab.id));
        assert.equal(after.spaces.filter(item => item.temporaryTabs.includes(tab.id)).length, 1);
    }
    assert.equal(after.activeSpaceId, before.activeSpaceId);
    const addedIds = new Set(added.map(tab => tab.id));
    assert.deepEqual(after.spaces.map(space => ({ ...space, temporaryTabs: space.temporaryTabs.filter(id => !addedIds.has(id)) })), before.spaces, 'Original Space placement and order must not change.');
    for (const key of ['bookmarks', 'bindings', 'favorites', 'pageStates']) assert.deepEqual(after[key], before[key]);
    return added.map(tab => tab.id);
}

export function isExactSavedPairFocused(state, pair) {
    const ids = new Set(pair.map(tab => tab.id));
    const current = state.tabs.filter(tab => ids.has(tab.id));
    return current.length === 2 && current.some(tab => tab.active) && current.every(tab =>
        tab.windowId === pair[0].windowId && tab.splitViewId === pair[0].splitViewId) &&
        state.tabs.filter(tab => tab.windowId === pair[0].windowId && tab.splitViewId === pair[0].splitViewId).length === 2;
}

export async function exerciseSavedSplitReopen({ apiPage, sidebar, ui, menu, read, poll, windowId, spaceId, sourceId, owned, checkpoint }) {
    const recipes = () => apiPage.evaluate(async () => (await chrome.storage.local.get('savedSplitRecipesV1')).savedSplitRecipesV1 || []);
    const original = await recipes();
    const source = await read();
    const sourceTab = source.tabs.find(tab => tab.id === sourceId);
    assert(sourceTab && sourceTab.splitViewId >= 0);
    const sourcePair = source.tabs.filter(tab => tab.splitViewId === sourceTab.splitViewId).sort((a, b) => a.index - b.index);
    assert.equal(sourcePair.length, 2);
    try {
    await menu(sourceId);
    await ui(sidebar.page, 'Save existing native pair using its Today menu', () => sidebar.page.click('#tab-context-menu [data-action="saveSplitView"]'));
    const saved = await poll(recipes, items => items.length === original.length + 1, 'one newly saved recipe');
    const recipe = saved.find(item => !original.some(old => old.id === item.id)); assert(recipe);
    assert.deepEqual(Object.keys(recipe).sort(), ['id', 'name', 'pages']);
    assert.deepEqual(recipe.pages.map(page => page.url), sourcePair.map(tab => tab.url), 'Saved recipe must describe the exact original native pair in order.');
    const pin = await poll(() => apiPage.evaluate(async id => {
        const state = (await chrome.storage.local.get('splitPinsV1')).splitPinsV1;
        return state?.pins.find(p => p.recipeId === id && p.phase === 'committed');
    }, recipe.id), value => value?.bookmarkId, 'one bookmark-backed pin');
    const selector = `.split-pin[data-bookmark-id="${pin.bookmarkId}"]`;
    await sidebar.page.waitForSelector(selector, { visible: true });
    assert.equal(await sidebar.page.$('.saved-splits-panel'), null, 'There must not be a dedicated split section.');
    const beforeFocus = await read();
    await ui(sidebar.page, 'Activate existing pinned pair without duplication', () => sidebar.page.click(selector));
    await poll(read, state => isExactSavedPairFocused(state, sourcePair), 'existing pair focused');
    assert.equal((await read()).tabs.length, beforeFocus.tabs.length);
    // Explicit loss-of-witness fixture: never infer original tabs from matching
    // URLs. A real close/reopen of the newly created pair is tested below.
    await apiPage.evaluate(async ({ windowId, bookmarkId }) => {
        const data = (await chrome.storage.session.get('splitPinInstancesV1')).splitPinInstancesV1 || {};
        delete data[`${windowId}:${bookmarkId}`];
        await chrome.storage.session.set({ splitPinInstancesV1: data });
    }, { windowId, bookmarkId: pin.bookmarkId });
    await sidebar.page.waitForFunction(selector => document.querySelector(selector)?.dataset.splitLive === 'false', { polling: 50 }, selector);
    const before = await read();
    await ui(sidebar.page, 'Open exact pinned pair without guessing equal URLs', () => sidebar.page.click(selector));
    const after = await poll(read, state => {
        try { assertSavedSplitReopened(before, state, { recipe, spaceId, windowId }); return true; } catch { return false; }
    }, 'new native pair with exact saved URLs and original pages preserved');
    const ids = assertSavedSplitReopened(before, after, { recipe, spaceId, windowId }); owned.push(...ids);
    await sidebar.page.waitForFunction(selector => document.querySelector(selector)?.dataset.splitLive === 'true', { polling: 50 }, selector);
    await ui(sidebar.page, 'Close live pinned pair while retaining its pin', () => sidebar.page.click(`${selector} .tab-close`));
    await poll(read, state => ids.every(id => !state.tabs.some(t => t.id === id)), 'exact pinned pair closed');
    assert(await apiPage.evaluate(async id => (await chrome.bookmarks.get(id)).length === 1, pin.bookmarkId));
    await sidebar.page.waitForFunction(selector => document.querySelector(selector)?.dataset.splitLive === 'false', { polling: 50 }, selector);
    const beforeReopen = await read();
    await ui(sidebar.page, 'Reopen same named pin after close', () => sidebar.page.click(selector));
    const reopened = await poll(read, state => {
        try { assertSavedSplitReopened(beforeReopen, state, { recipe, spaceId, windowId }); return true; } catch { return false; }
    }, 'pinned pair reopened after close');
    const reopenedIds = assertSavedSplitReopened(beforeReopen, reopened, { recipe, spaceId, windowId }); owned.push(...reopenedIds);
    await checkpoint('saved-split-native-reopened', { before, after, recipe, newTabIds: ids, reopenedIds });
    await ui(sidebar.page, 'Open ordinary pin context menu', () => sidebar.page.click(selector, { button: 'right' }));
    await ui(sidebar.page, 'Unpin pair without closing its pages', async () => {
        await sidebar.page.waitForSelector('#tab-context-menu', { visible: true });
        const items = await sidebar.page.$$('#tab-context-menu .context-menu-item');
        let exact;
        for (const item of items) if (await item.evaluate(node => node.textContent === 'Remove Pin')) {
            assert.equal(exact, undefined, 'Only one ordinary Remove Pin action is expected.'); exact = item;
        }
        assert(exact, 'The shared pin menu must provide Remove Pin.');
        await exact.click();
    });
    await sidebar.page.waitForFunction(selector => !document.querySelector(selector), { polling: 50 }, selector);
    const unpinned = await read();
    for (const id of [...sourcePair.map(t => t.id), ...reopenedIds]) assert(unpinned.tabs.some(t => t.id === id));
    await apiPage.evaluate(ids => chrome.tabs.remove(ids), reopenedIds);
    await poll(read, state => reopenedIds.every(id => !state.tabs.some(tab => tab.id === id)) && state.spaces.every(space => reopenedIds.every(id => !space.temporaryTabs.includes(id))), 'reopened fixture pair cleaned up');
    await checkpoint('saved-split-recipe-remove-preserved-pages', { newTabIds: ids, reopenedIds });
    } catch (error) {
        // Do not guess which tabs a failed action owns. Preserve them in this
        // disposable profile and capture identities before outer fixture teardown.
        try {
            await checkpoint('saved-split-failure-preserved', { error: error.message, source, observed: await read(), recipes: await recipes(), cleanup: 'Unverified tabs and recipe preserved in disposable test profile; no retry.' });
        } catch { /* Diagnostic failure must not replace the action failure. */ }
        throw error;
    }
}
