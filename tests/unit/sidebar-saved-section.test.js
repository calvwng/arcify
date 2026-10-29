import test from 'node:test';
import assert from 'node:assert/strict';
import { CommittedSavedSections, savedSectionSignature, observeSavedSectionChanges } from '../../sidebar-saved-section.js';
import { observeDisplayChanges } from '../../sidebar-display-read.js';

const base = () => ({
    space: { id: 'a', name: 'A', bookmarkFolderId: 'f', spaceBookmarks: [1], temporaryTabs: [2] },
    tabs: [{ id: 1, url: 'https://saved.test/', title: 'Saved', active: false, windowId: 10 }, { id: 2, url: 'https://today.test/', title: 'Today', windowId: 10 }],
    metadata: { pinnedStatesById: { 1: { bookmarkId: 'b', pinnedUrl: 'https://saved.test/' } }, overrides: {} },
    inverted: false, revision: 0, folder: 0
});
const signature = x => savedSectionSignature(x.space, x.tabs, x.metadata, x.inverted, x.revision, x.folder);

test('frozen-only changes preserve saved reuse without mutating native snapshots', () => {
    const a = base(), original = structuredClone(a), b = structuredClone(a);
    b.tabs[0].frozen = true;
    assert.equal(signature(a), signature(b));
    b.tabs[0].frozen = false;
    assert.equal(signature(a), signature(b));
    assert.deepEqual(a, original);
    assert.equal(b.tabs[0].frozen, false);
});

for (const field of ['id', 'url', 'pendingUrl', 'title', 'favIconUrl', 'index', 'windowId', 'groupId', 'splitViewId', 'pinned', 'incognito', 'status', 'discarded'])
test(`frozen normalization keeps ${field} as a dependency`, () => {
    const a = base(), b = structuredClone(a); b.tabs[0].frozen = true; b.tabs[0][field] = 'changed';
    assert.notEqual(signature(a), signature(b));
});

test('frozen update still invalidates an in-flight display capture', () => {
    let listener;
    const display = observeDisplayChanges({ tabs: { onUpdated: { addListener: fn => listener = fn } }, bookmarks: {}, storage: {} });
    const current = display.capture(); listener(1, { frozen: true }, { id: 1, frozen: true });
    assert.equal(current(), false);
});

test('only ordinary Today projection/content changes may preserve the saved signature', () => {
    const initial = base(), next = structuredClone(initial);
    next.space.temporaryTabs = [3, 2]; next.tabs[1].title = 'Updated'; next.tabs[1].url = 'https://other.test/';
    next.tabs.push({ id: 3, title: 'New', url: 'https://new.test/', windowId: 10 });
    assert.equal(signature(next), signature(initial));
});

for (const [name, mutate] of [
    ['Space', x => x.space.id = 'other'], ['folder identity', x => x.space.bookmarkFolderId = 'other'],
    ['saved membership', x => x.space.spaceBookmarks.push(2)], ['saved order', x => x.space.spaceBookmarks.unshift(3)],
    ['saved URL', x => x.tabs[0].url = 'https://away.test/'], ['saved title', x => x.tabs[0].title = 'Updated'],
    ['saved activation', x => x.tabs[0].active = true], ['saved native window', x => x.tabs[0].windowId = 20],
    ['saved closure', x => x.tabs.shift()], ['exact binding', x => x.metadata.pinnedStatesById[1].bookmarkId = 'other'],
    ['new binding on Today', x => x.metadata.pinnedStatesById[2] = { bookmarkId: 'new' }],
    ['override', x => x.metadata.overrides[1] = { name: 'Alias' }], ['setting', x => x.inverted = true],
    ['bookmark revision', x => x.revision++], ['folder generation', x => x.folder++]
]) test(`saved dependency ${name} requires full rendering`, () => {
    const a = base(), b = structuredClone(a); mutate(b); assert.notEqual(signature(a), signature(b));
});

test('only committed, available, connected identical saved DOM may be reused', () => {
    const cache = new CommittedSavedSections(), node = {}, container = { childNodes: [node], isConnected: true };
    assert.equal(cache.read(container, 'key'), null, 'first render cannot reuse');
    cache.commit(container, 'key', new Set([1, 4]), true);
    const ids = cache.read(container, 'key'); assert.deepEqual([...ids], [1, 4]); ids.clear();
    assert.deepEqual([...cache.read(container, 'key')], [1, 4], 'caller cannot corrupt committed represented set');
    assert.equal(cache.read(container, 'changed'), null);
    container.isConnected = false; assert.equal(cache.read(container, 'key'), null); container.isConnected = true;
    container.childNodes = [{}]; assert.equal(cache.read(container, 'key'), null); container.childNodes = [node];
    cache.commit(container, 'key', new Set(), false); assert.equal(cache.read(container, 'key'), null, 'unavailable tree retires proof');
});

test('bookmark messages/events, folder/settings and unknown storage invalidate saved proof', () => {
    const event = () => { const callbacks=[]; return { addListener: f => callbacks.push(f), emit: (...args) => callbacks.forEach(f => f(...args)) }; };
    const api = { bookmarks: Object.fromEntries(['onCreated','onChanged','onMoved','onRemoved','onChildrenReordered','onImportEnded'].map(n => [n,event()])), storage: { onChanged:event() }, runtime: { onMessage:event() } };
    const observer = observeSavedSectionChanges(api); let expected=0;
    for(const e of Object.values(api.bookmarks)) { e.emit(); assert.equal(observer.current(), ++expected); }
    api.runtime.onMessage.emit({action:'arcifyBookmarksChanged'}); assert.equal(observer.current(), ++expected);
    for(const [changes, area] of [[{anySetting:{}},'sync'],[{'folderCollapsed:f':{}},'local'],[{unknownKey:{}},'local'],[{activeSpaces:{}},'session'],[{pinnedTabStatesById:{}},'local'],[{tabNameOverridesById:{}},'local']]) {
        api.storage.onChanged.emit(changes,area); assert.equal(observer.current(), ++expected);
    }
    api.storage.onChanged.emit({spaces:{},spaceTabSnapshot:{},spaceSession:{}},'local'); assert.equal(observer.current(),expected);
});



test('lastTab bookkeeping does not affect saved row signature', () => {
    const a = base(), b = structuredClone(a); b.space.lastTab = 3;
    assert.equal(signature(a), signature(b));
});

test('schema transitions stay structural; only explicit supported no-op is harmless', () => {
    let emit;
    const observer = observeSavedSectionChanges({ storage: { onChanged: { addListener: f => emit = f } } });
    emit({ spaceModelVersion: { oldValue: 2, newValue: 2 } }, 'local');
    assert.equal(observer.current(), 0);
    for (const change of [{oldValue:1,newValue:2}, {oldValue:2,newValue:3}, {oldValue:2}, {newValue:2}])
        emit({ spaceModelVersion: change }, 'local');
    assert.equal(observer.current(), 4);
    emit({ spaceModelVersion: { oldValue:2,newValue:2 } }, 'sync');
    assert.equal(observer.current(), 5);
});
