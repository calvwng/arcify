/** Read-only, exact-native-ID provenance for fixture pages replaced by a reload. */
import assert from 'node:assert/strict';

const paths = ['options.html', 'installation-onboarding.html'];
const exactIdentity = ({ id, windowId, url, pinned, incognito }) => ({ id, windowId, url, pinned, incognito });
export async function readFixturePageIdentity() {
    const tab = await chrome.tabs.getCurrent();
    return { extensionId: chrome.runtime.id, documentUrl: location.href,
        tab: { id: tab.id, windowId: tab.windowId, url: tab.url, pinned: tab.pinned, incognito: tab.incognito } };
}

export function assertFixturePageObservation(state, ids) {
    const { controlWindowId, pages } = state.fixturePages || {};
    assert(Number.isSafeInteger(controlWindowId) && controlWindowId !== state.snapshot.windowId, 'Fixture control window must be explicit and separate');
    assert(Array.isArray(pages));
    const byId = new Map(state.tabs.map(tab => [tab.id, tab]));
    const records = new Map(), ownIds = new Set();
    for (const page of pages) {
        const name = Object.keys(ids).find(key => ids[key] === page.extensionId);
        assert(['arcifyId', 'spotlightId'].includes(name), 'Fixture page must belong to an exact paired extension');
        const path = paths.find(path => page.documentUrl === `chrome-extension://${page.extensionId}/${path}`);
        assert(path, 'Only exact options/onboarding document paths are fixture pages');
        assert.equal(page.tab.url, page.documentUrl, 'Fixture realm and native URL must match');
        assert.equal(page.tab.windowId, controlWindowId, 'Fixture page must stay in the known control window');
        assert.equal(page.tab.pinned, false); assert.equal(page.tab.incognito, false);
        assert.deepEqual(exactIdentity(byId.get(page.tab.id) || {}), page.tab, 'Direct fixture realm must match the exact native tab');
        const key = `${page.extensionId}/${path}`;
        assert(!records.has(key), 'Fixture endpoint must be unique');
        assert.equal(state.tabs.filter(tab => tab.url === page.documentUrl).length, 1, 'Fixture endpoint cannot ambiguously identify multiple tabs');
        records.set(key, page);
        const owners = state.groupState.spaces.filter(space => [...space.spaceBookmarks, ...space.temporaryTabs].includes(page.tab.id));
        if (name === 'arcifyId') {
            assert.equal(owners.length, 0, 'Own Arcify fixture pages must stay outside logical Spaces');
            ownIds.add(page.tab.id);
        } else {
            assert.equal(owners.length, 1, 'Spotlight fixture page must have one control Space owner');
            assert.equal(owners[0].id, state.groupState.activeSpaces[controlWindowId], 'Fixture page cannot move to another Space');
            assert(!owners[0].spaceBookmarks.includes(page.tab.id), 'Fixture pages cannot become saved Space pins');
        }
    }
    for (const id of Object.values(ids)) assert(records.has(`${id}/options.html`), 'Both directly observed options realms are required');
    // Completeness matters: an unobserved same-path duplicate is not an exception.
    for (const tab of state.tabs) for (const id of Object.values(ids)) for (const path of paths) {
        if (tab.url === `chrome-extension://${id}/${path}`) assert(records.get(`${id}/${path}`)?.tab.id === tab.id, 'Every exact fixture endpoint needs direct realm provenance');
    }
    return { controlWindowId, records, ownIds };
}

export function assertReloadFixtureProvenance(before, after, ids, proof) {
    const prior = assertFixturePageObservation(before, ids), current = assertFixturePageObservation(after, ids);
    assert.equal(current.controlWindowId, prior.controlWindowId, 'Reload cannot change the fixture control window');
    const empty = { before: new Set(), after: new Set() };
    if (!proof) return { ...empty, prior, current };
    const { name, lifecycle, nativeEvents, observerBefore, observerAfter } = proof;
    assert(['arcify', 'spotlight'].includes(name), 'Reload source must be explicit');
    assert.equal(proof.controlWindowId, prior.controlWindowId);
    const sourceId = ids[`${name}Id`], peerId = ids[name === 'arcify' ? 'spotlightId' : 'arcifyId'];
    const sourceUrl = `chrome-extension://${sourceId}/options.html`, workerUrl = `chrome-extension://${sourceId}/background.js`;
    assert.equal(lifecycle.name, name); assert.equal(lifecycle.view.url, sourceUrl);
    assert(lifecycle.view.closed || lifecycle.view.invalidations?.length, 'Original source options realm must be invalidated');
    assert.equal(lifecycle.identity.id, sourceId); assert.equal(lifecycle.identity.url, workerUrl);
    assert.equal(lifecycle.identity.globalType, 'ServiceWorkerGlobalScope');
    const original = lifecycle.observations.find(item => item.phase === 'before-reload')?.target;
    assert.equal(original?.url, workerUrl); assert.equal(original?.type, 'service_worker');
    assert.equal(lifecycle.replacement?.url, workerUrl); assert.equal(lifecycle.replacement?.type, 'service_worker');
    assert(original.targetId && lifecycle.replacement.targetId && original.targetId !== lifecycle.replacement.targetId,
        'Fixture exceptions require a proven replacement worker');
    assert.deepEqual(observerBefore, prior.records.get(`${peerId}/options.html`), 'Observer must be the exact unaffected peer options realm');
    assert.deepEqual(observerAfter, observerBefore, 'Native event observer must survive unchanged');
    assert(Array.isArray(nativeEvents?.created) && Array.isArray(nativeEvents?.removed));
    for (const path of paths) {
        const key = `${peerId}/${path}`;
        assert.deepEqual(current.records.get(key), prior.records.get(key), 'The non-reloaded peer fixture pages cannot change');
    }
    for (const path of paths) {
        const key = `${sourceId}/${path}`, oldPage = prior.records.get(key), newPage = current.records.get(key);
        if (oldPage) {
            assert(!after.tabs.some(tab => tab.id === oldPage.tab.id), 'Old source fixture ID must actually disappear');
            const removed = nativeEvents.removed.filter(event => event.tabId === oldPage.tab.id);
            assert.deepEqual(removed, [{ tabId: oldPage.tab.id, windowId: prior.controlWindowId, isWindowClosing: false }], 'Old source page requires one exact observed native removal');
            empty.before.add(oldPage.tab.id);
        }
        if (newPage) {
            assert(!before.tabs.some(tab => tab.id === newPage.tab.id), 'Replacement fixture ID must be newly created');
            const created = nativeEvents.created.filter(event => event.id === newPage.tab.id);
            assert.equal(created.length, 1, 'Fresh fixture page requires one exact observed native creation');
            assert.equal(created[0].windowId, prior.controlWindowId, 'Creation must occur in the known control window');
            if (path === 'installation-onboarding.html') assert([created[0].url, created[0].pendingUrl].includes(newPage.documentUrl),
                'Onboarding must originate at the exact extension path, not navigate there from another page');
            // browser.newPage() emits about:blank before the harness navigates to
            // options; its native ID is tied to the returned options API realm.
            empty.after.add(newPage.tab.id);
        }
    }
    return { ...empty, prior, current };
}
