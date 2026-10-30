import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { observeDisplayChanges } from '../../sidebar-display-read.js';
import { CommittedSavedSections, savedSectionSignature } from '../../sidebar-saved-section.js';

const source = readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('function handleTabUpdate('), source.indexOf('\nasync function handleTabRemove('));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness(heldRead) {
    const { document } = parseHTML('<html><body><div id="saved"></div></body></html>');
    const container = document.getElementById('saved');
    let changed, windowCallback, invalidations = 0;
    const wait = deferred();
    const api = { tabs: { onUpdated: { addListener(fn) { changed = fn; } } },
        windows: { getCurrent(_opts, fn) { windowCallback = fn; } } };
    const context = vm.createContext({ document, chrome: api, URL,
        displayChanges: observeDisplayChanges(api), committedDisplayIsCurrent: () => true,
        nativeFavoriteConversions: new Set(), isOpeningBookmark: false, spaces: [],
        Logger: { log() {} }, refreshCoordinator: { invalidateActiveView() { invalidations++; } },
        Utils: { getTabNameOverrides: () => heldRead === 'overrides' ? wait.promise : Promise.resolve({}),
            getPinnedTabState: () => heldRead === 'pinned' ? wait.promise : Promise.resolve(null),
            getPinnedUrlKey: url => url, getFaviconUrl: url => url }
    });
    vm.runInContext(handler, context);
    const cache = new CommittedSavedSections();
    const tab = title => ({ id: 1, windowId: 10, title, url: `https://${title.toLowerCase()}.test/`, pinned: false });
    const signature = t => savedSectionSignature({ id: 's', spaceBookmarks: [1], temporaryTabs: [] }, [t],
        { pinnedStatesById: {}, overrides: {} }, false, 0, 0);
    const commit = t => {
        const row = document.createElement('div'); row.className = 'tab'; row.dataset.tabId = '1'; row.dataset.url = t.url;
        row.innerHTML = '<img class="tab-favicon"><span class="tab-title-display"></span><span class="tab-domain-display"></span><input class="tab-title-input">';
        row.querySelector('.tab-title-display').textContent = t.title;
        row.querySelector('input').value = t.title;
        // The row's close listener captures this render's native snapshot.
        row.closeSnapshot = { ...t };
        container.replaceChildren(row);
        cache.commit(container, signature(t), new Set([1]), true);
        context.committedDisplayIsCurrent = () => true;
        return row;
    };
    return { context, container, cache, tab, signature, commit, wait,
        changed: () => changed(), callback: () => windowCallback({ id: 10 }), invalidations: () => invalidations };
}

for (const held of ['window', 'overrides', 'pinned']) {
    test(`older updater held at ${held} cannot overwrite a newer committed saved row`, async () => {
        const h = harness(held); h.commit(h.tab('A'));
        h.changed(); h.context.handleTabUpdate(1, { url: h.tab('B').url }, h.tab('B'));
        let pending;
        if (held !== 'window') { pending = h.callback(); await Promise.resolve(); await Promise.resolve(); }
        h.changed();
        const current = h.tab('C'), row = h.commit(current);
        if (held === 'window') pending = h.callback();
        else h.wait.resolve(held === 'overrides' ? {} : null);
        await pending;
        // A subsequent Today creation reads the unchanged saved snapshot: the
        // exact cache hit must retain C's DOM and captured close identity.
        assert.deepEqual([...h.cache.read(h.container, h.signature(current))], [1]);
        assert.equal(h.container.firstChild, row);
        assert.equal(row.querySelector('.tab-title-display').textContent, 'C');
        assert.equal(row.dataset.url, current.url);
        assert.deepEqual(row.closeSnapshot, current);
        assert.equal(h.invalidations(), 1);
    });
}

test('a committed render fences an old callback even without a subsequent native event', async () => {
    const h = harness('window'); h.commit(h.tab('A'));
    h.context.handleTabUpdate(1, { url: h.tab('B').url }, h.tab('B'));
    const row = h.commit(h.tab('C'));
    await h.callback();
    assert.equal(row.dataset.url, h.tab('C').url);
    assert.equal(h.invalidations(), 1);
});

test('current direct updater still refreshes title and URL without scheduling a render', async () => {
    const h = harness(); const row = h.commit(h.tab('A'));
    h.context.handleTabUpdate(1, { url: h.tab('B').url }, h.tab('B'));
    await h.callback();
    assert.equal(row.querySelector('.tab-title-display').textContent, 'B');
    assert.equal(row.dataset.url, h.tab('B').url);
    assert.equal(h.invalidations(), 0);
});
