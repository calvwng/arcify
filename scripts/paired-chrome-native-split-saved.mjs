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
    // Exercise the actual HTML5 drag input for a closed compound pin. Merely
    // clicking/selecting the row is not evidence that native dragstart fired.
    const dragFolder = await apiPage.evaluate(async id => {
        const [marker] = await chrome.bookmarks.get(id);
        return chrome.bookmarks.create({ parentId: marker.parentId, title: 'Saved split drag fixture' });
    }, pin.bookmarkId);
    const folderSelector = `.folder[data-bookmark-id="${dragFolder.id}"]`;
    await sidebar.page.waitForSelector(folderSelector, { visible: true });
    const closedBaseline = await read();
    const pinStorage = () => apiPage.evaluate(async () => ({
        local: await chrome.storage.local.get(['savedSplitRecipesV1', 'splitPinsV1']),
        session: await chrome.storage.session.get('splitPinInstancesV1')
    }));
    const closedStorage = await pinStorage();
    await ui(sidebar.page, 'Move closed inline split pin into folder and back with trusted drag', async () => {
        await sidebar.page.evaluate(bookmarkId => {
            globalThis.__splitPinFolderDrag = [];
            for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) document.addEventListener(type, event => {
                const row = event.target.closest?.('[data-bookmark-id]');
                globalThis.__splitPinFolderDrag.push({ type, trusted: event.isTrusted, bookmarkId: row?.dataset.bookmarkId, x: event.clientX, y: event.clientY, effectAllowed: event.dataTransfer?.effectAllowed, dropEffect: event.dataTransfer?.dropEffect, dragging: document.querySelector('.dragging')?.dataset.bookmarkId, connected: row?.isConnected });
            }, true);
        }, pin.bookmarkId);
        const dragTo = async (targetSelector, placement) => {
            const source = await sidebar.page.$(selector);
            const from = await source.boundingBox();
            assert(from);
            await sidebar.page.mouse.move(from.x + 55, from.y + from.height / 2);
            await sidebar.page.mouse.down();
            try {
                await sidebar.page.mouse.move(from.x + 67, from.y + from.height / 2, { steps: 6 });
                await poll(() => sidebar.page.evaluate(selector => document.querySelector(selector)?.classList.contains('dragging'), selector), Boolean, 'closed split genuine dragstart');
                // Starting a drag can reflow the row/folder. Read the current
                // header only after trusted dragstart, not the pre-drag layout.
                const to = await (await sidebar.page.$(targetSelector)).boundingBox();
                assert(to);
                const point = { x: to.x + 55, y: placement === 'after' ? to.y + to.height - 4 : to.y + to.height / 2 };
                await sidebar.page.evaluate(geometry => { globalThis.__splitPinDragGeometry = geometry; }, { from, to, targetSelector, placement, point });
                await sidebar.page.mouse.move(point.x, point.y, { steps: 15 });
                await new Promise(resolve => setTimeout(resolve, 350));
                const hit = await sidebar.page.evaluate(({ point, targetSelector }) => {
                    const target = document.querySelector(targetSelector), actual = document.elementFromPoint(point.x, point.y);
                    const anchor = document.querySelector('.sidebar-drop-anchor');
                    const result = { targetConnected: target?.isConnected, hitTarget: Boolean(target && actual && (target === actual || target.contains(actual))), hitBookmarkId: actual?.closest('[data-bookmark-id]')?.dataset.bookmarkId, status: document.querySelector('.sidebar-drop-status')?.textContent, anchorVisible: anchor?.hidden === false, anchorPlacement: anchor?.dataset.placement, inside: target?.classList.contains('sidebar-drop-inside') };
                    globalThis.__splitPinDragGeometry.hit = result;
                    return result;
                }, { point, targetSelector });
                assert(hit.targetConnected && hit.hitTarget, 'Release must hit the current folder header, never the source row');
                if (placement === 'after') assert(hit.anchorVisible && hit.anchorPlacement === 'after', 'Root return must advertise the after-folder insertion');
                else assert(hit.inside, 'Inbound drop must advertise folder containment');
            } finally { await sidebar.page.mouse.up(); }
        };
        await dragTo(`${folderSelector} > .folder-header`, 'inside');
        await poll(() => apiPage.evaluate(async id => (await chrome.bookmarks.get(id))[0].parentId, pin.bookmarkId), id => id === dragFolder.id, 'same marker nested in folder');
        await sidebar.page.waitForSelector(`${folderSelector} ${selector}`, { visible: true });
        await dragTo(`${folderSelector} > .folder-header`, 'after');
        await poll(() => apiPage.evaluate(async id => (await chrome.bookmarks.get(id))[0].parentId, pin.bookmarkId), id => id === dragFolder.parentId, 'same marker restored to root');
        const trace = await sidebar.page.evaluate(() => globalThis.__splitPinFolderDrag);
        for (const type of ['dragstart', 'drop', 'dragend']) assert.equal(trace.filter(event => event.type === type && event.trusted).length, 2, `Two trusted ${type} events required`);
        const afterDrag = await read();
        for (const key of ['tabs', 'bindings', 'favorites', 'spaces', 'pageStates']) assert.deepEqual(afterDrag[key], closedBaseline[key], `Folder drag cannot change ${key}`);
        assert.deepEqual(await pinStorage(), closedStorage, 'Folder movement cannot change recipes or live witnesses');
        const withoutMarker = nodes => nodes.filter(node => node.id !== pin.bookmarkId).map(({ index, dateGroupModified, children, ...node }) => ({ ...node, ...(children ? { children: withoutMarker(children) } : {}) }));
        assert.deepEqual(withoutMarker(afterDrag.bookmarks), withoutMarker(closedBaseline.bookmarks), 'Unrelated bookmark identities, content and order must remain unchanged');
        assert.equal(await sidebar.page.$eval(selector, node => node.dataset.splitLive), 'false');
        await checkpoint('saved-split-trusted-folder-drag', { bookmarkId: pin.bookmarkId, folderId: dragFolder.id, trace });
    });
    await apiPage.evaluate(id => chrome.bookmarks.remove(id), dragFolder.id);
    const beforeReopen = await read();
    await ui(sidebar.page, 'Reopen same named pin after close', () => sidebar.page.click(selector));
    const reopened = await poll(read, state => {
        try { assertSavedSplitReopened(beforeReopen, state, { recipe, spaceId, windowId }); return true; } catch { return false; }
    }, 'pinned pair reopened after close');
    const reopenedIds = assertSavedSplitReopened(beforeReopen, reopened, { recipe, spaceId, windowId }); owned.push(...reopenedIds);
    await checkpoint('saved-split-native-reopened', { before, after, recipe, newTabIds: ids, reopenedIds });
    // Simulate a worker interruption after native marker creation but before
    // receipt persistence. Recovery must require an explicit exact selection,
    // must not reconstruct a live witness, and must leave every page untouched.
    const beforeRecovery = await read();
    await apiPage.evaluate(async ({ bookmarkId, windowId }) => {
        const { splitPinsV1 } = await chrome.storage.local.get('splitPinsV1');
        const pin = splitPinsV1.pins.find(p => p.bookmarkId === bookmarkId);
        pin.phase = 'pending'; pin.bookmarkId = null;
        const { splitPinInstancesV1 = {} } = await chrome.storage.session.get('splitPinInstancesV1');
        delete splitPinInstancesV1[`${windowId}:${bookmarkId}`];
        await chrome.storage.session.set({ splitPinInstancesV1 });
        await chrome.storage.local.set({ splitPinsV1 });
    }, { bookmarkId: pin.bookmarkId, windowId });
    await ui(sidebar.page, 'Review interrupted pin creation', async () => {
        await sidebar.page.waitForSelector('#splitPinRecovery', { visible: true });
        await sidebar.page.click('#splitPinRecovery');
        await sidebar.page.waitForSelector('.split-pin-recovery-dialog[open]', { visible: true });
    });
    const beforeChoice = await apiPage.evaluate(async () => (await chrome.storage.local.get('splitPinsV1')).splitPinsV1);
    assert(beforeChoice.pins.some(p => p.recipeId === recipe.id && p.phase === 'pending'), 'Opening review must not adopt a marker.');
    await ui(sidebar.page, 'Explicitly associate exact interrupted bookmark', async () => {
        const choices = await sidebar.page.$$('.split-pin-recovery-dialog fieldset button');
        let selected;
        for (const choice of choices) if (await choice.evaluate((node, id) => node.textContent.startsWith('Use this bookmark:') && node.textContent.endsWith(`ID ${id}`), pin.bookmarkId)) {
            assert.equal(selected, undefined); selected = choice;
        }
        assert(selected); await selected.click();
    });
    await sidebar.page.waitForFunction(() => !document.querySelector('.split-pin-recovery-dialog'), { polling: 50 });
    const afterRecovery = await read();
    assert.deepEqual(afterRecovery.tabs.map(({ active, ...tab }) => tab), beforeRecovery.tabs.map(({ active, ...tab }) => tab));
    for (const key of ['bookmarks', 'bindings', 'favorites', 'spaces', 'pageStates']) assert.deepEqual(afterRecovery[key], beforeRecovery[key]);
    assert.equal(await apiPage.evaluate(async ({ bookmarkId, windowId }) => !!(await chrome.storage.session.get('splitPinInstancesV1')).splitPinInstancesV1?.[`${windowId}:${bookmarkId}`], { bookmarkId: pin.bookmarkId, windowId }), false);
    await checkpoint('saved-split-explicit-recovery-preserved-pages', { bookmarkId: pin.bookmarkId });
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
    await exerciseSplitSectionDrag({ apiPage, sidebar, ui, read, poll, spaceId, sourcePair, checkpoint });
    } catch (error) {
        // Do not guess which tabs a failed action owns. Preserve them in this
        // disposable profile and capture identities before outer fixture teardown.
        try {
            await checkpoint('saved-split-failure-preserved', { error: error.message, source, observed: await read(), recipes: await recipes(), dragEvidence: await sidebar.page.evaluate(() => ({ trace: globalThis.__splitPinFolderDrag || [], geometry: globalThis.__splitPinDragGeometry || null, compound: globalThis.__compoundDragTrace || [], compoundHit: globalThis.__compoundDragHit || null })), cleanup: 'Unverified tabs and recipe preserved in disposable test profile; no retry.' });
        } catch { /* Diagnostic failure must not replace the action failure. */ }
        throw error;
    }
}

async function exerciseSplitSectionDrag({ apiPage, sidebar, ui, read, poll, spaceId, sourcePair, checkpoint }) {
    const baseline = await read();
    const folder = await apiPage.evaluate(async spaceId => {
        const { spaces } = await chrome.storage.local.get('spaces');
        return chrome.bookmarks.create({ parentId: spaces.find(s => s.id === spaceId).bookmarkFolderId, title: 'Compound drag fixture' });
    }, spaceId);
    const sourceSelector = `.space.active [data-tab-type="temporary"] .tab[data-tab-id="${sourcePair[1].id}"]`;
    const folderSelector = `.folder[data-bookmark-id="${folder.id}"] > .folder-header`;
    const drag = async (sourceSelector, targetSelector, edge) => ui(sidebar.page, 'Drag exact live Split View across sections', async () => {
        await sidebar.page.waitForSelector(sourceSelector, { visible: true });
        await sidebar.page.waitForSelector(targetSelector, { visible: true });
        await sidebar.page.evaluate(() => {
            globalThis.__compoundDragTrace = [];
            if (!globalThis.__compoundDragObserved) {
                globalThis.__compoundDragObserved = true;
                for (const type of ['dragstart', 'drop', 'dragend']) document.addEventListener(type, event => globalThis.__compoundDragTrace.push({ type, trusted: event.isTrusted, tabId: event.target.closest?.('[data-tab-id]')?.dataset.tabId, bookmarkId: event.target.closest?.('[data-bookmark-id]')?.dataset.bookmarkId }), true);
            }
        });
        const from = await (await sidebar.page.$(sourceSelector)).boundingBox(); assert(from);
        await sidebar.page.mouse.move(from.x + 55, from.y + from.height / 2); await sidebar.page.mouse.down();
        try {
            await sidebar.page.mouse.move(from.x + 67, from.y + from.height / 2, { steps: 6 });
            await poll(() => sidebar.page.$eval(sourceSelector, node => node.classList.contains('dragging')), Boolean, 'compound dragstart');
            const to = await (await sidebar.page.$(targetSelector)).boundingBox(); assert(to);
            const point = { x: to.x + 55, y: to.y + (edge ? 4 : to.height / 2) };
            await sidebar.page.mouse.move(point.x, point.y, { steps: 15 });
            await new Promise(resolve => setTimeout(resolve, 350));
            const hit = await sidebar.page.evaluate(({ targetSelector, point }) => {
                const target = document.querySelector(targetSelector), actual = document.elementFromPoint(point.x, point.y), anchor = document.querySelector('.sidebar-drop-anchor');
                const result = { target: !!target && !!actual && (target === actual || target.contains(actual)), inside: target?.classList.contains('sidebar-drop-inside'), anchor: anchor?.hidden === false && anchor.dataset.placement === 'before' };
                globalThis.__compoundDragHit = { targetSelector, point, result }; return result;
            }, { targetSelector, point });
            assert(hit.target && (edge ? hit.anchor : hit.inside), 'Compound drop must hit a verified advertised destination');
        } finally { await sidebar.page.mouse.up(); }
        const trace = await sidebar.page.evaluate(() => globalThis.__compoundDragTrace);
        for (const type of ['dragstart', 'drop', 'dragend']) assert.equal(trace.filter(e => e.type === type && e.trusted).length, 1);
        await checkpoint('compound-drag-input', { trace });
    });
    await drag(sourceSelector, folderSelector, false);
    const pins = await poll(() => apiPage.evaluate(async folderId => chrome.bookmarks.getChildren(folderId), folder.id), children => children.length === 1, 'one compound pin at intended folder');
    const pin = pins[0], selector = `.split-pin[data-bookmark-id="${pin.id}"]`;
    await sidebar.page.waitForSelector(selector, { visible: true });
    const pinned = await read();
    for (const key of ['tabs', 'bindings', 'favorites', 'spaces', 'pageStates']) assert.deepEqual(pinned[key], baseline[key], `Compound pin must preserve ${key}`);
    const target = await sidebar.page.$eval('.space.active [data-tab-type="temporary"] .tab[data-tab-id]', node => node.dataset.tabId);
    const inverted = await sidebar.page.$eval('.space.active [data-tab-type="temporary"]', node => node.dataset.todayOrderInverted === 'true');
    await drag(selector, `.space.active [data-tab-type="temporary"] .tab[data-tab-id="${target}"]`, true);
    await poll(() => apiPage.evaluate(async folderId => chrome.bookmarks.getChildren(folderId), folder.id), children => children.length === 0, 'compound pin removed');
    await poll(() => apiPage.evaluate(async bookmarkId => {
        const { splitPinsV1 } = await chrome.storage.local.get('splitPinsV1');
        const { splitPinInstancesV1 = {} } = await chrome.storage.session.get('splitPinInstancesV1');
        return !splitPinsV1.pins.some(p => p.bookmarkId === bookmarkId) && !Object.values(splitPinInstancesV1).some(p => p.bookmarkId === bookmarkId);
    }, pin.id), Boolean, 'compound release metadata cleanup confirmed');
    for (const pane of sourcePair) await sidebar.page.waitForSelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${pane.id}"]`, { visible: true });
    const released = await read();
    for (const key of ['tabs', 'bindings', 'favorites', 'pageStates']) assert.deepEqual(released[key], pinned[key], `Compound release must preserve ${key}`);
    const pairIds = sourcePair.map(t => t.id);
    const withoutPair = spaces => spaces.map(s => ({ ...s, temporaryTabs: s.temporaryTabs.filter(id => !pairIds.includes(id)) }));
    assert.deepEqual(withoutPair(released.spaces), withoutPair(pinned.spaces), 'Compound release preserves unrelated ownership and relative Today order');
    const owner = released.spaces.find(s => s.id === spaceId), positions = pairIds.map(id => owner.temporaryTabs.indexOf(id));
    assert(positions.every(i => i >= 0) && Math.abs(positions[0] - positions[1]) === 1, 'Both panes surface as one adjacent Today block');
    for (const pane of sourcePair) await sidebar.page.waitForSelector(`.space.active [data-tab-type="temporary"] .tab[data-tab-id="${pane.id}"]`, { visible: true });
    const visibleOrder = await sidebar.page.$$eval('.space.active [data-tab-type="temporary"] .tab[data-tab-id]', rows => rows.map(row => Number(row.dataset.tabId)));
    const priorPairOrder = pinned.spaces.find(s => s.id === spaceId).temporaryTabs.filter(id => pairIds.includes(id));
    const expectedPairOrder = inverted ? [...priorPairOrder].reverse() : priorPairOrder;
    const targetIndex = visibleOrder.indexOf(Number(target));
    assert(targetIndex >= 2);
    assert.deepEqual(visibleOrder.slice(targetIndex - 2, targetIndex), expectedPairOrder, 'Released pair must occupy the requested visible slot immediately before target, preserving pane order');
    const state = await apiPage.evaluate(async () => ({ local: await chrome.storage.local.get(['splitPinsV1', 'savedSplitRecipesV1']), session: await chrome.storage.session.get('splitPinInstancesV1') }));
    assert(!state.local.splitPinsV1.pins.some(p => p.bookmarkId === pin.id));
    assert(!state.local.savedSplitRecipesV1.some(recipe => recipe.id === new URL(pin.url).hash.slice(1)), 'Release removes the saved recipe rather than leaving a duplicate closed shortcut');
    assert(!Object.values(state.session.splitPinInstancesV1 || {}).some(p => p.bookmarkId === pin.id));
    await apiPage.evaluate(id => chrome.bookmarks.remove(id), folder.id);
    await checkpoint('compound-live-pin-today-roundtrip', { pinId: pin.id, pairIds: sourcePair.map(t => t.id), before: baseline, after: released });
}
