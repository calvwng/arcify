/** Real backend handlers with mocked Chrome APIs, deliberately not hosted-browser evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture as actionFixture, success, error } from './spotlight-action-fixture.js';
import { GLOBAL_FAVORITES_FEATURE, SPACE_ACTIONS_FEATURE, SPACE_NAVIGATION_FEATURE } from '../../spotlight-bridge-protocol.js';

const FEATURES = [GLOBAL_FAVORITES_FEATURE, SPACE_ACTIONS_FEATURE, SPACE_NAVIGATION_FEATURE];
const destination = { spaceId: 'target', bookmarkFolderId: 'target-root' };
function fixture() {
    const f = actionFixture();
    f.local.todayOrderRepresentation = { version: 1, inverted: false };
    Object.assign(f.store, { restoredRanks: new Map(), restoreQueue: [], windowKeys: new Map([[10, 'ten'], [20, 'twenty']]) });
    f.nodes.push({ id: 'target-root', parentId: 'arc', title: 'Target' });
    f.store.spaces.push({ id: 'target', name: 'Target', color: 'red', bookmarkFolderId: 'target-root', temporaryTabs: [5], spaceBookmarks: [], lastTab: 5 });
    f.tabs.push({ id: 5, windowId: 10, index: 3, active: false, title: 'Destination same URL', url: 'https://same.test/' });
    return f;
}

for (const kind of ['closed', 'moved-other-window']) test(`API-mocked navigation refuses ${kind} exact source and cannot replay onto a same-URL survivor`, async () => {
    for (const command of ['switchSpace', 'moveCurrentTodayTab']) {
        const f = fixture();
        const captured = success(await f.handle(f.request('navigationContext', { supportedFeatures: FEATURES, tabId: 1 }), f.sender));
        const request = f.request(command, { supportedFeatures: FEATURES, context: captured.actionContext, sourceUrl: captured.navigationContext.sourceUrl,
            destination, ...(command === 'moveCurrentTodayTab' ? { inverted: captured.navigationContext.inverted } : {}) });
        const original = structuredClone(f.tabs.find(tab => tab.id === 1));
        // Keep source memberships untouched to ensure the fresh native witness,
        // rather than convenient model cleanup, must reject the captured ID.
        if (kind === 'closed') {
            f.tabs.splice(f.tabs.findIndex(tab => tab.id === 1), 1);
            chrome.tabs.onRemoved.emit(1, { windowId: 10, isWindowClosing: false });
        } else {
            Object.assign(f.tabs.find(tab => tab.id === 1), { windowId: 20, active: false, index: 1 });
            chrome.tabs.onDetached.emit(1, { oldWindowId: 10, oldPosition: 0 });
            chrome.tabs.onAttached.emit(1, { newWindowId: 20, newPosition: 1 });
        }
        f.active(3); // Equal-URL ordinary Today neighbor must never replace ID 1.
        const before = structuredClone({ tabs: f.tabs, spaces: f.store.spaces, active: f.store.active, bindings: f.local.pinnedTabStatesById });
        error(await f.handle(request, f.sender), 'STALE_CONTEXT');
        assert.deepEqual(f.writes(), [], 'Rejection may journal the attempt, but must not persist or mutate content.');
        assert.deepEqual({ tabs: f.tabs, spaces: f.store.spaces, active: f.store.active, bindings: f.local.pinnedTabStatesById }, before);
        assert.equal(f.session.spotlightBridgeRequests.length, 1);
        assert.equal(f.session.spotlightBridgeRequests[0].fingerprint, JSON.stringify(request));
        assert.equal(f.session.spotlightBridgeRequests[0].response, undefined);

        // Even if the exact source later returns, the same pending request is
        // never executed again or substituted with a fresh request automatically.
        const existing = f.tabs.findIndex(tab => tab.id === 1);
        if (existing < 0) f.tabs.unshift(original); else f.tabs[existing] = original;
        f.active(1);
        const effectsBeforeRetry = structuredClone(f.effects), tabsBeforeRetry = structuredClone(f.tabs);
        error(await f.handle(request, f.sender), 'UNCERTAIN_RESULT');
        assert.deepEqual(f.effects, effectsBeforeRetry); assert.deepEqual(f.tabs, tabsBeforeRetry);
        assert.equal(f.session.spotlightBridgeRequests.length, 1);
        assert(f.store.spaces[0].temporaryTabs.includes(1)); assert(f.store.spaces[0].temporaryTabs.includes(3));
        assert.deepEqual(f.store.spaces[1].temporaryTabs, [5]);
    }
});
