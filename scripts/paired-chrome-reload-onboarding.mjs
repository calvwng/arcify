/** Read-only barrier for Arcify's asynchronous onInstalled update onboarding. */
import assert from 'node:assert/strict';

// Run in an exact options realm. Do not acknowledge onboarding or modify sync.
export async function readReloadOnboardingState() {
    const tab = await chrome.tabs.getCurrent();
    const { onboardingVersion } = await chrome.storage.sync.get('onboardingVersion');
    return { extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version, onboardingVersion,
        source: { extensionId: chrome.runtime.id, documentUrl: location.href,
            tab: { id: tab.id, windowId: tab.windowId, url: tab.url, pinned: tab.pinned, incognito: tab.incognito } },
        tabs: (await chrome.tabs.query({})).map(({ id, windowId, url, pendingUrl, status, pinned, incognito }) =>
            ({ id, windowId, url, pendingUrl, status, pinned, incognito })) };
}

export async function readReloadOnboardingDocument() {
    const tab = await chrome.tabs.getCurrent();
    return { extensionId: chrome.runtime.id, documentUrl: location.href, readyState: document.readyState,
        tab: { id: tab.id, windowId: tab.windowId, url: tab.url, pinned: tab.pinned, incognito: tab.incognito } };
}

const identity = ({ id, windowId, url, pinned, incognito }) => ({ id, windowId, url, pinned, incognito });
function assertSource(state, extensionId, windowId) {
    assert.equal(state.extensionId, extensionId);
    assert.equal(state.source.extensionId, extensionId);
    assert.equal(state.source.documentUrl, `chrome-extension://${extensionId}/options.html`);
    assert.equal(state.source.tab.url, state.source.documentUrl);
    assert(Number.isSafeInteger(state.source.tab.id));
    assert(Number.isSafeInteger(state.source.tab.windowId));
    if (windowId !== undefined) assert.equal(state.source.tab.windowId, windowId, 'Reload options must remain in the known control window');
    assert.equal(state.source.tab.pinned, false); assert.equal(state.source.tab.incognito, false);
    assert(Array.isArray(state.tabs));
    assert.deepEqual(state.tabs.filter(tab => tab.id === state.source.tab.id).map(identity), [state.source.tab],
        'Direct options realm must match one exact native tab');
}

/**
 * runtime.reload triggers the update gate in background.js: only an unmatched
 * onboardingVersion opens onboarding. Wait for that expected document before
 * focusing the peer; a fixed delay can race its asynchronous storage read.
 * This neither dismisses onboarding nor retries/replays the reconnect action.
 */
export async function waitForExpectedReloadOnboarding({ before, extensionId, readState, readDocument, poll }) {
    assertSource(before, extensionId);
    assert.equal(typeof before.version, 'string'); assert(before.version);
    const windowId = before.source.tab.windowId;
    const url = `chrome-extension://${extensionId}/installation-onboarding.html`;
    const expected = before.onboardingVersion !== before.version;
    const baselineIds = new Set(before.tabs.map(tab => tab.id));
    const inspect = state => {
        assertSource(state, extensionId, windowId);
        assert(!baselineIds.has(state.source.tab.id), 'Replacement options must have a fresh native identity');
        assert.equal(state.version, before.version, 'Reload must preserve the manifest version');
        assert.equal(state.onboardingVersion, before.onboardingVersion, 'Fixture cannot change the onboarding version gate');
        const candidates = state.tabs.filter(tab => tab.url === url || tab.pendingUrl === url);
        assert(candidates.length <= 1, 'Reload onboarding endpoint must be unique');
        const candidate = candidates[0];
        if (candidate) {
            assert.equal(candidate.windowId, windowId, 'Onboarding must open in the known control window');
            assert.equal(candidate.pinned, false); assert.equal(candidate.incognito, false);
            assert(!candidate.pendingUrl || candidate.pendingUrl === url, 'Onboarding cannot be navigating elsewhere');
        }
        return candidate;
    };
    if (!expected) {
        const state = await readState(), candidate = inspect(state);
        assert(!candidate || baselineIds.has(candidate.id), 'Acknowledged version cannot create new onboarding');
        return { expected, version: before.version, onboardingVersion: before.onboardingVersion, controlWindowId: windowId, document: null };
    }
    const state = await poll(readState, value => {
        const candidate = inspect(value);
        return candidate && !baselineIds.has(candidate.id) && candidate.url === url && candidate.status === 'complete';
    }, 'one new fully loaded exact Arcify onboarding page before peer reconnect');
    const candidate = inspect(state), document = await readDocument(candidate, url);
    assert.equal(document.extensionId, extensionId);
    assert.equal(document.documentUrl, url); assert.equal(document.readyState, 'complete');
    assert.deepEqual(document.tab, identity(candidate), 'Onboarding realm must match the exact new native tab');
    const finalCandidate = inspect(await readState());
    assert(finalCandidate, 'Observed onboarding must remain present before reconnect');
    assert.deepEqual(identity(finalCandidate), document.tab, 'Onboarding identity cannot change during observation');
    assert.equal(finalCandidate.status, 'complete');
    return { expected, version: before.version, onboardingVersion: before.onboardingVersion, controlWindowId: windowId, document };
}
