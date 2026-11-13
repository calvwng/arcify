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
    await ui(sidebar.page, 'Expand saved pairs', async () => {
        if (!await sidebar.page.$eval('.saved-splits-panel', node => node.open)) await sidebar.page.click('.saved-splits-panel summary');
    });
    await sidebar.page.waitForFunction(id => Array.from(document.querySelectorAll('.saved-splits-panel option')).some(option => option.value === id), {}, recipe.id);
    await ui(sidebar.page, 'Select exact saved pair', () => sidebar.page.select('.saved-splits-panel select', recipe.id));
    await sidebar.page.waitForFunction(id => { const panel = document.querySelector('.saved-splits-panel'); return panel?.querySelector('select')?.value === id && panel.querySelector('button:first-of-type')?.disabled === false; }, {}, recipe.id);
    const before = await read();
    await ui(sidebar.page, 'Open saved pair with original native split still present', () => sidebar.page.click('.saved-splits-panel button:first-of-type'));
    const after = await poll(read, state => {
        try { assertSavedSplitReopened(before, state, { recipe, spaceId, windowId }); return true; } catch { return false; }
    }, 'new native pair with exact saved URLs and original pages preserved');
    const ids = assertSavedSplitReopened(before, after, { recipe, spaceId, windowId }); owned.push(...ids);
    await checkpoint('saved-split-native-reopened', { before, after, recipe, newTabIds: ids });
    await sidebar.page.waitForFunction(id => { const panel = document.querySelector('.saved-splits-panel'); return panel?.querySelector('select')?.value === id && panel.querySelector('button:last-of-type')?.disabled === false; }, {}, recipe.id);
    await ui(sidebar.page, 'Remove saved recipe without closing either pair', () => sidebar.page.click('.saved-splits-panel button:last-of-type'));
    await poll(recipes, items => !items.some(item => item.id === recipe.id), 'saved recipe removed');
    assertSavedSplitReopened(before, await read(), { recipe, spaceId, windowId });
    // Only these exact fixture-created tabs are closed; the source pair remains.
    await apiPage.evaluate(ids => chrome.tabs.remove(ids), ids);
    await poll(read, state => ids.every(id => !state.tabs.some(tab => tab.id === id)) && state.spaces.every(space => ids.every(id => !space.temporaryTabs.includes(id))), 'reopened fixture pair cleaned up');
    await checkpoint('saved-split-recipe-remove-preserved-pages', { newTabIds: ids });
    } catch (error) {
        // Do not guess which tabs a failed action owns. Preserve them in this
        // disposable profile and capture identities before outer fixture teardown.
        try {
            await checkpoint('saved-split-failure-preserved', { error: error.message, source, observed: await read(), recipes: await recipes(), cleanup: 'Unverified tabs and recipe preserved in disposable test profile; no retry.' });
        } catch { /* Diagnostic failure must not replace the action failure. */ }
        throw error;
    }
}
