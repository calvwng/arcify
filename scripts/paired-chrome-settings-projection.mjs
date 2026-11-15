import assert from 'node:assert/strict';
export const SETTINGS_PROJECTION_CASE = 'Settings replacement retirement and control-window group projection diagnostic';
export async function exerciseSettingsProjection({ browser, apiPage, fixture, arcifyId, spotlightId, snapshot, poll, record, retired }) {
    const state = await snapshot(fixture.windowA);
    const source = state.spaces.find(s => s.id === state.activeSpaceId);
    const controlWindow = await apiPage.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
    assert.notEqual(controlWindow, fixture.windowA);
    const controlState = await snapshot(controlWindow);
    const home = controlState.spaces.find(s => s.id === controlState.activeSpaceId);
    const url = `chrome-extension://${spotlightId}/options.html`;
    const read = async () => {
        const target = browser.targets().filter(t => t.type() === 'service_worker' && t.url() === `chrome-extension://${arcifyId}/background.js`);
        assert.equal(target.length, 1);
        const worker = await target[0].worker();
        return worker.evaluate(async () => {
            if (typeof globalThis.__settingsProjectionDiagnostic !== 'function') throw Error('Read-only diagnostic instrumentation missing');
            return globalThis.__settingsProjectionDiagnostic();
        });
    };
    const checkpoint = async (phase, extra = {}) => { const observation = await read(); await record({ phase, ...extra, observation }); return observation; };
    const create = async (windowId, spaceId) => {
        const tab = await apiPage.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }), { windowId, url });
        await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), tab.id), t => t.url === url && t.status === 'complete', 'exact diagnostic Settings document loaded');
        const reply = await apiPage.evaluate(({ id, spaceId }) => chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId: id, spaceId, newTodayTab: true, pinned: false }), { id: tab.id, spaceId });
        assert.equal(reply.success, true);
        return tab.id;
    };
    await apiPage.evaluate(() => chrome.storage.sync.set({ syncTabGroups: false }));
    await checkpoint('baseline', { retired, sourceId: source.id, homeId: home.id, controlWindow });
    let priorId = null;
    if (retired) {
        // Broad suite has already performed explicit ordinary Today moves.
        // Establish that authority with an HTTP anchor; extension URLs are
        // intentionally ineligible for the public Today Move command.
        const anchorUrl = `${fixture.base}/alpha`;
        const anchor = await apiPage.evaluate(({ controlWindow, anchorUrl }) => chrome.tabs.create({ windowId: controlWindow, url: anchorUrl, active: false }), { controlWindow, anchorUrl });
        await poll(() => apiPage.evaluate(id => chrome.tabs.get(id), anchor.id), t => t.url === anchorUrl && t.status === 'complete', 'authority anchor loaded');
        const assigned = await apiPage.evaluate(({ tabId, spaceId }) => chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId, spaceId, pinned: false }), { tabId: anchor.id, spaceId: home.id });
        assert.equal(assigned.success, true);
        const placement = await apiPage.evaluate(async ({ tabId, controlWindow, home, source, url }) => {
            const { todayOrderRepresentation } = await chrome.storage.local.get('todayOrderRepresentation');
            return chrome.runtime.sendMessage({ type: 'moveTodayTabsToSpace', windowId: controlWindow,
                spaceId: home.id, bookmarkFolderId: home.bookmarkFolderId,
                destinationSpaceId: source.id, destinationBookmarkFolderId: source.bookmarkFolderId,
                inverted: todayOrderRepresentation.inverted, entries: [{ tabId, url }] });
        }, { tabId: anchor.id, controlWindow, home, source, url: anchorUrl });
        assert.equal(placement.success, true, JSON.stringify(placement));
        await checkpoint('prior-http-authority-established', { anchorId: anchor.id, placement });
        priorId = await create(controlWindow, home.id);
        await checkpoint('prior-settings-created', { priorId });
        await poll(read, o => o.decisions.find(d => d.tabId === priorId)?.explicitOwner,
            'prior Settings has real current explicit ownership before witnessed close');
        await apiPage.evaluate(id => chrome.tabs.remove(id), priorId);
        const receipt = await poll(read, o => o.layout?.retirements?.some(r => r.reason === 'observed-individual-close' && r.closed.some(c => c.tabId === priorId)),
            'genuine durable individual-close retirement for prior Settings');
        await record({ phase: 'prior-retirement-witnessed', priorId, observation: receipt });
    }
    const replacementId = await create(fixture.windowA, source.id);
    const beforeMove = await checkpoint('replacement-before-control-move', { priorId, replacementId });
    const beforeTab = beforeMove.tabs.find(t => t.id === replacementId);
    assert.equal(beforeTab.groupId, -1); assert.equal(beforeTab.active, false); assert.equal(beforeTab.splitViewId ?? -1, -1);
    const moved = await apiPage.evaluate(async ({ replacementId, controlWindow, homeId }) => {
        const tab = await chrome.tabs.move(replacementId, { windowId: controlWindow, index: -1 });
        const assigned = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'assign', tabId: replacementId, spaceId: homeId, pinned: false });
        return { tab, assigned };
    }, { replacementId, controlWindow, homeId: home.id });
    assert.equal(moved.assigned.success, true);
    await checkpoint('replacement-after-control-move', { replacementId, movedTab: moved.tab });
    await apiPage.evaluate(() => chrome.storage.sync.set({ syncTabGroups: true }));
    // Observe bounded convergence without changing state or retrying a mutation.
    const observations = [];
    for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        observations.push(await checkpoint('sync-on-observation', { index: i, replacementId }));
    }
    const final = observations.at(-1), tab = final.tabs.find(t => t.id === replacementId);
    assert(tab && tab.windowId === controlWindow && tab.url === url && !tab.pinned);
    assert.deepEqual(final.tabs.map(t => t.id).sort((a,b)=>a-b), beforeMove.tabs.map(t => t.id).sort((a,b)=>a-b), 'Move/projection cannot replace/create/close native tabs');
    const owners = final.spaces.filter(s => [...s.temporaryTabs,...s.spaceBookmarks].includes(replacementId));
    assert.equal(owners.length, 1); assert.equal(owners[0].id, home.id);
    const decision = final.decisions.find(d => d.tabId === replacementId);
    const groupId = final.session.spaceGroupProjection?.[`${home.id}:${controlWindow}`];
    const result = { retired, priorId, replacementId, controlWindow, homeId: home.id,
        terminal: decision.terminal, explicitOwner: decision.explicitOwner,
        windowDeferred: final.pendingWindows.includes(controlWindow), nativeGroupId: tab.groupId, expectedProjection: groupId ?? null,
        grouped: tab.groupId >= 0 && tab.groupId === groupId };
    await record({ phase: 'diagnostic-result', result });
    if (!retired) assert(result.grouped, 'Clean no-retirement control must settle into exact Home native projection');
    else assert(result.grouped || result.windowDeferred, 'An ungrouped replacement must have observed guard deferral; no unexplained failure accepted');
    return result;
}
