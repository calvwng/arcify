/** Fixture-only setup before Favorite lifecycle measurements; import-safe. */
import assert from 'node:assert/strict';

const paths = ['options.html', 'installation-onboarding.html'];
const exact = (values, id) => { const matches = values.filter(value => value.id === id); assert.equal(matches.length, 1, `Require exact identity ${id}`); return matches[0]; };
const native = ({ id, windowId, url, pendingUrl, pinned, incognito, active, groupId, splitViewId }) =>
    ({ id, windowId, url, pendingUrl: pendingUrl || null, pinned, incognito, active, groupId, splitViewId: splitViewId ?? -1 });
const ordered = (tabs, windowId) => tabs.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);

export async function readControlDocument() {
    const tab = await chrome.tabs.getCurrent();
    return { extensionId: chrome.runtime.id, documentUrl: location.href, timeOrigin: performance.timeOrigin,
        tab: { id: tab.id, windowId: tab.windowId, url: tab.url, pinned: tab.pinned, incognito: tab.incognito } };
}
export async function readControlWindowState() {
    const settled = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
    if (settled?.success !== true) throw new Error('Cannot observe the settled Space queue.');
    const local = await chrome.storage.local.get(['spaces', 'pinnedTabStatesById', 'tabNameOverridesById', 'persistentFavorites', 'favoriteIconCache']);
    const session = await chrome.storage.session.get(['activeSpaces', 'favoriteSession']);
    const { spaces, ...saved } = local;
    return { tabs: await chrome.tabs.query({}), windows: await chrome.windows.getAll(), spaces,
        activeSpaces: session.activeSpaces || {}, saved, favoriteSession: session.favoriteSession ?? null };
}

export function planControlWindowSetup(before, { arcifyId, spotlightId, sourceWindowId, counterpartWindowId }) {
    assert.notEqual(arcifyId, spotlightId);
    for (const id of [arcifyId, spotlightId]) assert.match(id, /^[a-p]{32}$/);
    assert.notEqual(sourceWindowId, counterpartWindowId);
    for (const id of [sourceWindowId, counterpartWindowId]) assert(Number.isSafeInteger(id) && id > 0);
    assert.equal(new Set(before.tabs.map(tab => tab.id)).size, before.tabs.length);
    assert.equal(new Set(before.windows.map(window => window.id)).size, before.windows.length);
    const records = new Map();
    for (const page of before.documents) {
        assert([arcifyId, spotlightId].includes(page.extensionId), 'Unknown fixture runtime');
        const path = paths.find(path => page.documentUrl === `chrome-extension://${page.extensionId}/${path}`);
        assert(path, 'Only exact options/onboarding fixture documents may move');
        assert(Number.isFinite(page.timeOrigin) && page.timeOrigin > 0, 'Document identity must be observed');
        const key = `${page.extensionId}/${path}`; assert(!records.has(key), 'Ambiguous fixture endpoint'); records.set(key, page);
        assert.equal(before.tabs.filter(tab => tab.url === page.documentUrl).length, 1, 'Duplicate native fixture endpoint');
        const tab = exact(before.tabs, page.tab.id);
        assert.deepEqual(page.tab, { id: tab.id, windowId: tab.windowId, url: tab.url, pinned: tab.pinned, incognito: tab.incognito });
        assert.equal(tab.url, page.documentUrl); assert.equal(tab.pinned, false); assert.equal(tab.incognito, false);
        assert.equal(tab.status, 'complete'); assert(!tab.pendingUrl);
    }
    for (const id of [arcifyId, spotlightId]) assert(records.has(`${id}/options.html`), 'Both directly observed options realms are mandatory');
    for (const tab of before.tabs) for (const id of [arcifyId, spotlightId]) for (const path of paths) {
        if (tab.url === `chrome-extension://${id}/${path}`) assert.equal(records.get(`${id}/${path}`)?.tab.id, tab.id, 'Every fixture endpoint requires direct provenance');
    }
    const controlWindowId = records.get(`${arcifyId}/options.html`).tab.windowId;
    assert.notEqual(controlWindowId, sourceWindowId); assert.notEqual(controlWindowId, counterpartWindowId);
    const controlWindow = exact(before.windows, controlWindowId);
    assert.equal(controlWindow.type, 'normal'); assert.equal(controlWindow.incognito, false);
    const controlSpaceId = before.activeSpaces[controlWindowId]; exact(before.spaces, controlSpaceId);
    const moves = [];
    for (const page of records.values()) {
        const tab = exact(before.tabs, page.tab.id), owners = before.spaces.filter(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(tab.id));
        if (page.extensionId === arcifyId) assert.equal(owners.length, 0, 'Arcify control pages must not own logical membership');
        else {
            assert.equal(owners.length, 1); assert(!owners[0].spaceBookmarks.includes(tab.id));
            assert.equal(owners[0].id, before.activeSpaces[tab.windowId], 'Control ownership must match its selected Space before setup');
        }
        if (tab.windowId === controlWindowId) continue;
        assert.equal(tab.windowId, sourceWindowId, 'Never move an endpoint from an unknown or counterpart window');
        assert.equal(tab.active, false, 'Never move an active endpoint'); assert.equal(tab.groupId, -1);
        assert.equal(tab.splitViewId ?? -1, -1);
        moves.push({ tabId: tab.id, fromWindowId: tab.windowId, toWindowId: controlWindowId,
            spaceId: page.extensionId === spotlightId ? controlSpaceId : null });
    }
    const moved = new Set(moves.map(move => move.tabId));
    if (moves.length) assert(before.tabs.some(tab => tab.windowId === sourceWindowId && !moved.has(tab.id) && tab.active), 'Setup must retain the source window and its active tab');
    return { controlWindowId, controlSpaceId, moves };
}

export function assertControlWindowSetup(before, after, options, plan) {
    assert.deepEqual(planControlWindowSetup(before, options), plan);
    const current = planControlWindowSetup(after, options); assert.deepEqual(current.moves, []);
    assert.equal(current.controlWindowId, plan.controlWindowId); assert.equal(current.controlSpaceId, plan.controlSpaceId);
    assert.deepEqual(after.windows, before.windows, 'Setup preserves every window and focus');
    assert.deepEqual(after.activeSpaces, before.activeSpaces, 'Setup never changes selected Spaces');
    assert.deepEqual(after.saved, before.saved); assert.deepEqual(after.favoriteSession, before.favoriteSession);
    assert.deepEqual(after.tabs.map(tab => tab.id).sort((a, b) => a - b), before.tabs.map(tab => tab.id).sort((a, b) => a - b));
    const moved = new Map(plan.moves.map(move => [move.tabId, move]));
    for (const tab of before.tabs) {
        const expected = native(tab), move = moved.get(tab.id);
        if (move) expected.windowId = move.toWindowId;
        assert.deepEqual(native(exact(after.tabs, tab.id)), expected, 'Only attested control window placement may change');
    }
    for (const window of before.windows) {
        const expected = ordered(before.tabs, window.id).filter(tab => !moved.has(tab.id)).map(tab => tab.id);
        if (window.id === plan.controlWindowId) expected.push(...plan.moves.map(move => move.tabId));
        const actual = ordered(after.tabs, window.id);
        assert.deepEqual(actual.map(tab => tab.id), expected, 'Only removal/end insertion of attested controls may shift native order');
        assert.deepEqual(actual.map(tab => tab.index), expected.map((_, index) => index));
    }
    const spaces = structuredClone(before.spaces);
    for (const move of plan.moves.filter(move => move.spaceId !== null)) {
        for (const space of spaces) space.temporaryTabs = space.temporaryTabs.filter(id => id !== move.tabId);
        exact(spaces, move.spaceId).temporaryTabs.push(move.tabId);
    }
    assert.deepEqual(after.spaces, spaces, 'Only moved Spotlight fixture IDs may change Space ownership');
    for (const page of before.documents) {
        const expected = structuredClone(page), move = moved.get(page.tab.id);
        if (move) expected.tab.windowId = move.toWindowId;
        assert.deepEqual(after.documents.find(value => value.tab.id === page.tab.id), expected, 'Every control document and native ID must survive unchanged');
    }
}

export async function normalizeReloadControlWindow({ apiPage, spotlightApiPage, pageForUrl, arcifyId, spotlightId, sourceWindowId, counterpartWindowId, record }) {
    const options = { arcifyId, spotlightId, sourceWindowId, counterpartWindowId }, pages = [apiPage, spotlightApiPage];
    const initial = await apiPage.evaluate(readControlWindowState);
    await record({ phase: 'control-window-native-discovery', state: initial });
    for (const id of [arcifyId, spotlightId]) for (const path of paths) {
        const url = `chrome-extension://${id}/${path}`, matches = initial.tabs.filter(tab => tab.url === url);
        assert(matches.length <= 1, 'Ambiguous fixture endpoint; do not choose a tab');
        if (path === 'installation-onboarding.html' && matches.length) pages.push(await pageForUrl(url));
    }
    const read = async () => ({ ...await apiPage.evaluate(readControlWindowState), documents: await Promise.all(pages.map(page => page.evaluate(readControlDocument))) });
    const before = await read(); await record({ phase: 'before-control-window-setup', before });
    const plan = planControlWindowSetup(before, options), operations = [];
    let failure;
    try { for (const move of plan.moves) {
        const page = pages.find((_, index) => before.documents[index].tab.id === move.tabId);
        assert.deepEqual(await page.evaluate(readControlDocument), before.documents.find(document => document.tab.id === move.tabId));
        const result = await apiPage.evaluate(async ({ move, expectedUrl }) => {
            const tab = await chrome.tabs.get(move.tabId);
            if (tab.id !== move.tabId || tab.windowId !== move.fromWindowId || tab.url !== expectedUrl || tab.active || tab.pinned || tab.incognito || tab.pendingUrl || tab.status !== 'complete' || tab.groupId !== -1 || (tab.splitViewId ?? -1) !== -1) throw new Error('Fixture control changed before its one native move');
            const moved = await chrome.tabs.move(move.tabId, { windowId: move.toWindowId, index: -1 });
            const assigned = move.spaceId === null ? null : await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId: move.tabId, spaceId: move.spaceId, pinned: false });
            return { moved, assigned };
        }, { move, expectedUrl: before.documents.find(document => document.tab.id === move.tabId).documentUrl });
        operations.push({ move, result }); await record({ phase: 'control-window-move-observed', move, result });
        assert.equal(result.moved.id, move.tabId); assert.equal(result.moved.windowId, move.toWindowId);
        if (move.spaceId !== null) assert.equal(result.assigned?.success, true);
    } } catch (error) { failure = error; }
    // Each native move and real assign has completed, then read() drains the
    // authoritative queue. Validate one captured outcome; never poll away a
    // selection/focus/identity failure or retry a mutation.
    let after, observationError;
    try { after = await read(); } catch (error) { observationError = error; }
    await record({ phase: 'after-control-window-setup', before, after, plan, operations,
        ...(failure ? { error: failure.message } : {}), ...(observationError ? { observationError: observationError.message } : {}) });
    if (failure) throw failure;
    if (observationError) throw observationError;
    assertControlWindowSetup(before, after, options, plan);
    return { before, after, plan, operations };
}
