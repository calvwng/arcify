import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createFavoritesDragSource } from '../../favorites-drop.js';
import { Utils } from '../../utils.js';

// The retired native-only writer's safety cases now exercise FavoriteStore.
// docs/favorites-drop.md maps all 27 original cases to their current coverage.
// Keep the independent real provenance and shared Utils-lock regressions here.
function fixture() {
    const bindings = {}, tabs = [], hooks = {}, queues = new Map();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(key, operation) {
        const next = (queues.get(key) || Promise.resolve()).then(operation); queues.set(key, next.catch(() => {})); return next;
    } } } });
    globalThis.chrome = {
        storage: { local: { async get() { return { pinnedTabStatesById: structuredClone(bindings) }; },
            async set({ pinnedTabStatesById: next }) { await hooks.bindingSet?.(); for (const key of Object.keys(bindings)) delete bindings[key]; Object.assign(bindings, structuredClone(next)); } } },
        tabs: { async get(id) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Tab closed'); return structuredClone(tab); } }
    };
    return { bindings, tabs, hooks };
}
function addLive(f, { pinned }) { f.tabs.push({ id: 1, pinned }); f.bindings[1] = { bookmarkId: 'saved', pinnedUrl: 'https://saved.test/' }; }

test('provenance accepts one unchanged own-sidebar row, never transfer payload or forged dragging class', () => {
    const { document } = parseHTML('<body><div id="pinnedFavicons"></div><div id="spacesList"><div class="space" data-space-id="s"><div class="tab bookmark-only dragging" data-bookmark-id="saved"></div><div class="folder" data-bookmark-id="folder"></div></div></div></body>');
    const context = { spaces: [{ id: 's', bookmarkFolderId: 'p' }], activeSpaceId: 's', windowId: 10 };
    const drag = createFavoritesDragSource({ document, getContext: () => context });
    assert.match(drag.inspect().error, /from this sidebar/);
    const row = document.querySelector('.tab'); drag.start(row);
    assert.equal(drag.inspect().source.bookmarkId, 'saved'); assert.match(drag.inspect().hint, /Opens a Favorite tab/);
    row.dataset.bookmarkId = 'forged'; assert.match(drag.inspect().error, /changed/);
    row.dataset.bookmarkId = 'saved'; row.remove(); assert.match(drag.take().error, /changed/);
    assert.match(drag.inspect().error, /from this sidebar/);
    const folder = document.querySelector('.folder'); folder.classList.add('dragging'); drag.start(folder);
    assert.match(drag.inspect().error, /does not accept folders/);
});

test('independent pinned-state writers use the origin lock and preserve both bindings', async () => {
    const f = fixture();
    const one = { ...Utils, _pinnedStateChain: Promise.resolve() }, two = { ...Utils, _pinnedStateChain: Promise.resolve() };
    f.hooks.bindingSet = async () => { await new Promise(resolve => setTimeout(resolve, 2)); };
    await Promise.all([one.setPinnedTabState(1, { bookmarkId: 'first' }), two.setPinnedTabState(2, { bookmarkId: 'second' })]);
    assert.equal(f.bindings[1].bookmarkId, 'first'); assert.equal(f.bindings[2].bookmarkId, 'second');
});

test('startup cleanup checks native pin freshly inside the binding lock and closed-tab cleanup still removes it', async () => {
    const f = fixture(); addLive(f, { pinned: true });
    await Utils.removePinnedTabState(1, { preserveNativePinned: true });
    assert.equal(f.bindings[1].bookmarkId, 'saved');
    f.tabs.splice(0);
    await Utils.removePinnedTabState(1, { preserveNativePinned: true });
    assert.equal(f.bindings[1], undefined);
});
